import type { Response } from 'express';
import { MeDto, MFA_REQUIRED_ROLES, AgeStatus, Role } from '@aquisito/contracts';
import { config } from '../../config';
import { db, tx } from '../../db/db';
import { AuthCtx, CSRF_COOKIE, SESSION_COOKIE } from '../../common/auth';
import {
  base32Encode,
  hashPassword,
  randomDigits,
  randomToken,
  sha256,
  verifyPassword,
  verifyTotp,
} from '../../common/crypto';
import { BizError } from '../../common/errors';
import { audit } from '../../common/audit';
import { randomBytes } from 'crypto';
import { emailProvider, smsProvider } from '../../providers/messaging';
import { addBusinessDays } from '../../common/time';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

export async function ageStatusOf(userId: string): Promise<AgeStatus> {
  const v = await db.maybe(`SELECT status FROM age_verifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [userId]);
  if (v) return v.status;
  const u = await db.maybe(`SELECT declared_birth_date FROM users WHERE id = $1`, [userId]);
  return u?.declared_birth_date ? 'declared' : 'none';
}

export async function buildMe(userId: string, sessionId?: string): Promise<MeDto> {
  const u = await db.one(`SELECT * FROM users WHERE id = $1`, [userId]);
  const ms = await db.q(`SELECT id, role, city_id, merchant_id, branch_id FROM memberships WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  const mfa = await db.maybe(`SELECT enabled_at FROM mfa_totp WHERE user_id = $1`, [userId]);
  const s = sessionId ? await db.maybe(`SELECT mfa_verified_at FROM sessions WHERE id = $1`, [sessionId]) : null;
  return {
    id: u.id,
    email: u.email,
    phone: u.phone,
    fullName: u.full_name,
    declaredBirthDate: u.declared_birth_date ? toISODate(u.declared_birth_date) : null,
    ageStatus: await ageStatusOf(userId),
    memberships: ms.map((m) => ({ id: m.id, role: m.role, cityId: m.city_id, merchantId: m.merchant_id, branchId: m.branch_id })),
    mfaEnabled: !!mfa?.enabled_at,
    mfaVerified: !!s?.mfa_verified_at,
    isDemo: u.is_demo,
  };
}

export function toISODate(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10);
  // columnas DATE llegan como Date local del proceso; reconstruir sin desfase horario
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function createSession(userId: string, deviceLabel?: string) {
  const token = randomToken();
  const roles = await db.q(`SELECT role FROM memberships WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  const sensitive = roles.some((r) => MFA_REQUIRED_ROLES.includes(r.role as Role));
  const ttl = sensitive ? config().ADMIN_SESSION_TTL_HOURS : config().SESSION_TTL_HOURS;
  const s = await db.one(
    `INSERT INTO sessions(user_id, token_hash, device_label, expires_at) VALUES ($1,$2,$3, now() + make_interval(hours => $4)) RETURNING id`,
    [userId, sha256(token), deviceLabel ?? null, ttl],
  );
  const mfa = await db.maybe(`SELECT enabled_at FROM mfa_totp WHERE user_id = $1`, [userId]);
  const user = await buildMe(userId, s.id);
  return { token, user, mfaRequired: sensitive || !!mfa?.enabled_at, ttlHours: ttl };
}

export function setSessionCookies(res: Response, token: string, ttlHours: number) {
  const secure = config().COOKIE_SECURE;
  const maxAge = ttlHours * 3600 * 1000;
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, maxAge, path: '/' });
  res.cookie(CSRF_COOKIE, randomToken(18), { httpOnly: false, sameSite: 'lax', secure, maxAge, path: '/' });
}

export function clearSessionCookies(res: Response) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.clearCookie(CSRF_COOKIE, { path: '/' });
}

export async function register(input: { email: string; password: string; fullName: string; phone?: string }) {
  const exists = await db.maybe(`SELECT 1 FROM users WHERE email = $1`, [input.email]);
  if (exists) throw new BizError('EMAIL_TAKEN', 'Ya existe una cuenta con ese correo', 409);
  const hash = await hashPassword(input.password);
  const u = await db.one(
    `INSERT INTO users(email, phone, password_hash, full_name) VALUES ($1,$2,$3,$4) RETURNING id`,
    [input.email, input.phone ?? null, hash, input.fullName],
  );
  await db.q(`INSERT INTO consents(user_id, purpose, granted, policy_version) VALUES ($1,'terms',true,'borrador-0.1'),($1,'privacy',true,'borrador-0.1')`, [u.id]);
  return createSession(u.id);
}

async function tooManyFailures(key: string) {
  const r = await db.one(
    `SELECT count(*)::int AS n FROM login_attempts WHERE key = $1 AND NOT success AND created_at > now() - make_interval(mins => $2)
       AND created_at > coalesce((SELECT max(created_at) FROM login_attempts WHERE key = $1 AND success), 'epoch')`,
    [key, LOCK_MINUTES],
  );
  return r.n >= MAX_FAILED_LOGINS;
}

export async function login(input: { email: string; password: string; deviceLabel?: string }, ip: string) {
  const key = `login:${input.email.toLowerCase()}`;
  if (await tooManyFailures(key)) throw new BizError('RATE_LIMITED', `Demasiados intentos. Espera ${LOCK_MINUTES} minutos o recupera tu contraseña.`, 429);
  const u = await db.maybe(`SELECT id, password_hash FROM users WHERE email = $1 AND status = 'active'`, [input.email]);
  const ok = await verifyPassword(input.password, u?.password_hash ?? null);
  await db.q(`INSERT INTO login_attempts(key, success) VALUES ($1,$2)`, [key, ok]);
  if (!ok || !u) throw new BizError('INVALID_CREDENTIALS', 'Correo o contraseña incorrectos', 401);
  void ip;
  return createSession(u.id, input.deviceLabel);
}

export async function requestOtp(phone: string, ip: string) {
  const recent = await db.one(`SELECT count(*)::int AS n FROM otp_challenges WHERE phone = $1 AND created_at > now() - interval '15 minutes'`, [phone]);
  if (recent.n >= 3) throw new BizError('RATE_LIMITED', 'Demasiadas solicitudes de código. Intenta en 15 minutos.', 429);
  const byIp = await db.one(`SELECT count(*)::int AS n FROM otp_challenges WHERE request_ip = $1 AND created_at > now() - interval '1 hour'`, [ip]);
  if (byIp.n >= 10) throw new BizError('RATE_LIMITED', 'Demasiadas solicitudes desde esta red.', 429);
  let provider;
  try {
    provider = smsProvider();
  } catch {
    throw new BizError('OTP_UNAVAILABLE', 'El acceso por SMS no está disponible. Usa correo y contraseña.', 503);
  }
  const code = randomDigits(6);
  await db.q(`INSERT INTO otp_challenges(phone, code_hash, expires_at, request_ip) VALUES ($1,$2, now() + interval '5 minutes', $3)`, [phone, sha256(`${phone}:${code}`), ip]);
  await provider.send(phone, `Aquisito: tu código es ${code}. Vence en 5 minutos. No lo compartas.`);
  return { sent: true, simulated: provider.isSimulator, expiresInSeconds: 300 };
}

export async function verifyOtp(input: { phone: string; code: string; fullName?: string; deviceLabel?: string }) {
  const ch = await db.maybe(
    `SELECT * FROM otp_challenges WHERE phone = $1 AND consumed_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`,
    [input.phone],
  );
  if (!ch) throw new BizError('OTP_INVALID', 'Código vencido o inexistente. Solicita uno nuevo.', 401);
  if (ch.attempts >= 5) throw new BizError('OTP_LOCKED', 'Demasiados intentos. Solicita un nuevo código.', 429);
  if (ch.code_hash !== sha256(`${input.phone}:${input.code}`)) {
    await db.q(`UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1`, [ch.id]);
    throw new BizError('OTP_INVALID', 'Código incorrecto', 401);
  }
  await db.q(`UPDATE otp_challenges SET consumed_at = now() WHERE id = $1`, [ch.id]);
  let u = await db.maybe(`SELECT id FROM users WHERE phone = $1 AND status = 'active'`, [input.phone]);
  if (!u) {
    if (!input.fullName) throw new BizError('NAME_REQUIRED', 'Indica tu nombre para crear la cuenta', 422);
    u = await db.one(`INSERT INTO users(phone, full_name) VALUES ($1,$2) RETURNING id`, [input.phone, input.fullName]);
  }
  return createSession(u!.id, input.deviceLabel);
}

export async function mfaSetup(a: AuthCtx) {
  const existing = await db.maybe(`SELECT enabled_at FROM mfa_totp WHERE user_id = $1`, [a.userId]);
  if (existing?.enabled_at) throw new BizError('MFA_ALREADY_ENABLED', 'La verificación en dos pasos ya está activa', 409);
  const secret = base32Encode(randomBytes(20));
  await db.q(
    `INSERT INTO mfa_totp(user_id, secret_base32) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET secret_base32 = EXCLUDED.secret_base32`,
    [a.userId, secret],
  );
  const u = await db.one(`SELECT coalesce(email::text, phone) AS label FROM users WHERE id = $1`, [a.userId]);
  return { secret, otpauthUrl: `otpauth://totp/Aquisito:${encodeURIComponent(u.label)}?secret=${secret}&issuer=Aquisito` };
}

export async function mfaVerify(a: AuthCtx, code: string) {
  return tx(async (t) => {
    const m = await t.maybe(`SELECT * FROM mfa_totp WHERE user_id = $1 FOR UPDATE`, [a.userId]);
    if (!m) throw new BizError('MFA_NOT_SETUP', 'Configura primero la verificación en dos pasos', 409);
    const step = verifyTotp(m.secret_base32, code);
    if (step === null || (m.last_used_step != null && step <= Number(m.last_used_step)))
      throw new BizError('MFA_INVALID', 'Código incorrecto o ya utilizado', 401);
    await t.q(`UPDATE mfa_totp SET last_used_step = $2, enabled_at = coalesce(enabled_at, now()) WHERE user_id = $1`, [a.userId, step]);
    await t.q(`UPDATE sessions SET mfa_verified_at = now() WHERE id = $1`, [a.sessionId]);
    await audit(t, a, 'mfa.verified', 'session', a.sessionId, null);
    return { mfaVerified: true };
  });
}

export async function listSessions(a: AuthCtx) {
  const rows = await db.q(
    `SELECT id, device_label, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`,
    [a.userId],
  );
  return rows.map((r) => ({ id: r.id, deviceLabel: r.device_label, createdAt: r.created_at, lastSeenAt: r.last_seen_at, current: r.id === a.sessionId }));
}

export async function revokeSession(a: AuthCtx, id: string) {
  const r = await db.q(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`, [id, a.userId]);
  if (!r.length) throw new BizError('NOT_FOUND', 'Sesión no encontrada', 404);
  return { revoked: true };
}

export async function passwordResetRequest(email: string) {
  const u = await db.maybe(`SELECT id FROM users WHERE email = $1 AND status = 'active'`, [email]);
  // Respuesta idéntica exista o no la cuenta (evita enumeración).
  if (u) {
    const token = randomToken();
    await db.q(`INSERT INTO password_resets(user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '30 minutes')`, [u.id, sha256(token)]);
    const p = emailProvider();
    if (p) await p.send(email, 'Recupera tu contraseña', `Enlace: ${config().PUBLIC_WEB_URL}/recuperar?token=${token} (vence en 30 minutos)`);
  }
  return { accepted: true, emailConfigured: !!emailProvider() };
}

export async function passwordReset(token: string, password: string) {
  return tx(async (t) => {
    const r = await t.maybe(`SELECT * FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`, [sha256(token)]);
    if (!r) throw new BizError('TOKEN_INVALID', 'Enlace vencido o ya utilizado', 400);
    await t.q(`UPDATE password_resets SET used_at = now() WHERE id = $1`, [r.id]);
    await t.q(`UPDATE users SET password_hash = $2 WHERE id = $1`, [r.user_id, await hashPassword(password)]);
    await t.q(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [r.user_id]);
    return { reset: true };
  });
}

/** Cambiar nombre o fecha de nacimiento REVOCA la verificación de edad hasta nueva revisión. */
export async function updateMe(a: AuthCtx, input: { fullName?: string; phone?: string; birthDate?: string }) {
  return tx(async (t) => {
    const u = await t.one(`SELECT full_name, declared_birth_date FROM users WHERE id = $1 FOR UPDATE`, [a.userId]);
    const identityChanged =
      (input.fullName && input.fullName !== u.full_name) ||
      (input.birthDate && input.birthDate !== (u.declared_birth_date ? toISODate(u.declared_birth_date) : null));
    await t.q(
      `UPDATE users SET full_name = coalesce($2, full_name), phone = coalesce($3, phone), declared_birth_date = coalesce($4::date, declared_birth_date) WHERE id = $1`,
      [a.userId, input.fullName ?? null, input.phone ?? null, input.birthDate ?? null],
    );
    if (identityChanged) {
      const last = await t.maybe(`SELECT * FROM age_verifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [a.userId]);
      if (last && (last.status === 'verified' || last.status === 'pending')) {
        await t.q(
          `INSERT INTO age_verifications(user_id, status, document_type, document_last4, full_name_on_document, birth_date, method, policy_version, decision_reason, decided_at)
           VALUES ($1,'revoked',$2,$3,$4,$5,'system',$6,'Cambio de datos de identidad: requiere nueva revisión', now())`,
          [a.userId, last.document_type, last.document_last4, last.full_name_on_document, last.birth_date, last.policy_version],
        );
        if (last.status === 'pending') await t.q(`UPDATE age_verifications SET status = 'revoked', decided_at = now(), decision_reason = 'Datos cambiados' WHERE id = $1`, [last.id]);
        await audit(t, a, 'age_verification.revoked_by_identity_change', 'user', a.userId, 'Cambio de nombre o fecha de nacimiento');
      }
    }
    return buildMe(a.userId, a.sessionId);
  });
}

export async function setConsent(a: AuthCtx, input: { purpose: string; granted: boolean; policyVersion: string }) {
  await db.q(`INSERT INTO consents(user_id, purpose, granted, policy_version) VALUES ($1,$2,$3,$4)`, [a.userId, input.purpose, input.granted, input.policyVersion]);
  return listConsents(a);
}

export async function listConsents(a: AuthCtx) {
  const rows = await db.q(
    `SELECT DISTINCT ON (purpose) purpose, granted, policy_version, created_at FROM consents WHERE user_id = $1 ORDER BY purpose, created_at DESC`,
    [a.userId],
  );
  return rows.map((r) => ({ purpose: r.purpose, granted: r.granted, policyVersion: r.policy_version, at: r.created_at }));
}

export async function createDataRequest(a: AuthCtx, input: { kind: string; detail?: string }) {
  // Plazos orientativos (a validar con asesoría, Ley 29733 y su reglamento): acceso 20 días hábiles, demás 10.
  const days = input.kind === 'access' ? 20 : 10;
  const due = await addBusinessDays(new Date(), days);
  const r = await db.one(
    `INSERT INTO data_requests(user_id, kind, detail, due_at) VALUES ($1,$2,$3,$4) RETURNING id, kind, status, due_at, created_at`,
    [a.userId, input.kind, input.detail ?? null, due],
  );
  return { id: r.id, kind: r.kind, status: r.status, dueAt: r.due_at, createdAt: r.created_at };
}

/**
 * Eliminación de cuenta: anonimiza datos personales y revoca accesos, CONSERVANDO pedidos,
 * movimientos económicos y reclamaciones por las obligaciones de conservación (a validar).
 */
export async function anonymizeUser(t: import('../../db/db').Tx, userId: string) {
  await t.q(`UPDATE users SET email = NULL, phone = NULL, password_hash = NULL, full_name = 'Usuario eliminado', declared_birth_date = NULL, status = 'deleted', deleted_at = now() WHERE id = $1`, [userId]);
  await t.q(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  await t.q(`UPDATE addresses SET deleted_at = now(), line1 = '[eliminada]', number = NULL, reference = NULL, instructions = NULL WHERE user_id = $1`, [userId]);
  await t.q(`UPDATE age_verifications SET full_name_on_document = '[eliminado]', document_last4 = '----' WHERE user_id = $1`, [userId]);
  await t.q(`DELETE FROM favorites WHERE user_id = $1`, [userId]);
  await t.q(`DELETE FROM carts WHERE user_id = $1`, [userId]);
  await t.q(`UPDATE push_tokens SET revoked_at = now() WHERE user_id = $1`, [userId]);
  await t.q(`UPDATE orders SET address_line1 = '[eliminada]', address_reference = NULL, address_instructions = NULL, contact_phone = NULL, invoice_name = NULL, invoice_doc_number = NULL WHERE user_id = $1 AND commercial_status IN ('completado','cancelado','rechazado_comercio')`, [userId]);
}
