import { isAdultOn, isWithinWeeklyWindows, localDate, localWeekdayMinutes } from '@aquisito/contracts';
import { config } from '../../config';
import { db, Tx } from '../../db/db';
import { AuthCtx } from '../../common/auth';
import { BizError } from '../../common/errors';
import { LIMA, timeToMinutes } from '../../common/time';

/**
 * Acceso a contenido restringido: SOLO cuentas autenticadas con verificación de edad aprobada
 * (estado "verified" vigente y edad >= mínima calculada por fecha completa en hora de Lima).
 * Una fecha declarada o una casilla no habilitan.
 */
export async function restrictedAccess(a: AuthCtx | null | undefined, minimumAge = 18, at = new Date(), t: Tx = db): Promise<{ allowed: boolean; reason: string }> {
  if (!a) return { allowed: false, reason: 'AUTH_REQUIRED' };
  const v = await t.maybe(`SELECT status, birth_date FROM age_verifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [a.userId]);
  if (!v) return { allowed: false, reason: 'NOT_VERIFIED' };
  if (v.status !== 'verified') return { allowed: false, reason: v.status === 'pending' ? 'VERIFICATION_PENDING' : v.status === 'revoked' ? 'VERIFICATION_REVOKED' : 'VERIFICATION_REJECTED' };
  if (!isAdultOn(v.birth_date, localDate(at, LIMA), minimumAge)) return { allowed: false, reason: 'UNDERAGE' };
  return { allowed: true, reason: 'OK' };
}

export interface AlcoholSaleContext {
  branchId: string;
  destinationJurisdictionId: string | null;
  /** Instantes a validar: p.ej. ahora y la hora estimada de entrega (o la franja programada). */
  instants: Date[];
}

/**
 * Regla de venta y entrega de alcohol. Todas deben cumplirse:
 * 1. La ciudad tiene alcohol habilitado (interruptor comercial).
 * 2. La sucursal vende alcohol con habilitación aprobada y vigente.
 * 3. Para la jurisdicción de la sucursal Y la del destino: existe una ventana permitida que cubre
 *    cada instante. En ensayo/producción solo cuentan reglas validadas (validated = true); en
 *    desarrollo se aceptan las de demostración marcadas is_demo.
 * 4. Ninguna prohibición temporal (blackout) activa. El interruptor del administrador NO la anula.
 */
export async function alcoholSaleCheck(ctx: AlcoholSaleContext, t: Tx = db): Promise<{ ok: boolean; code: string; message: string }> {
  const b = await t.one(
    `SELECT b.sells_alcohol, b.alcohol_permit_status, b.alcohol_permit_expires_at, b.jurisdiction_id, c.alcohol_enabled, c.timezone
     FROM branches b JOIN cities c ON c.id = b.city_id WHERE b.id = $1`,
    [ctx.branchId],
  );
  const fail = (code: string, message: string) => ({ ok: false, code, message });
  if (!b.alcohol_enabled) return fail('ALCOHOL_DISABLED_CITY', 'La venta de bebidas alcohólicas no está habilitada en esta ciudad');
  if (!b.sells_alcohol || b.alcohol_permit_status !== 'approved') return fail('ALCOHOL_PERMIT', 'El comercio no tiene habilitación vigente para vender bebidas alcohólicas');
  if (b.alcohol_permit_expires_at && b.alcohol_permit_expires_at < localDate(new Date(), b.timezone)) return fail('ALCOHOL_PERMIT_EXPIRED', 'La habilitación del comercio para alcohol está vencida');
  const jurisdictions = [...new Set([b.jurisdiction_id, ctx.destinationJurisdictionId].filter(Boolean))] as string[];
  if (jurisdictions.length === 0 || !ctx.destinationJurisdictionId) return fail('ALCOHOL_NO_JURISDICTION', 'No hay jurisdicción configurada para validar el horario');
  const onlyValidated = !config().isDevLike;
  for (const j of jurisdictions) {
    const rules = await t.q(
      `SELECT weekday, start_time::text AS s, end_time::text AS e FROM alcohol_rules
       WHERE jurisdiction_id = $1 AND active AND (validated OR ($2 = false AND is_demo))`,
      [j, onlyValidated],
    );
    if (rules.length === 0) return fail('ALCOHOL_NO_RULES', 'No hay reglas horarias validadas para esta jurisdicción; la venta permanece cerrada');
    const windows = rules.map((r) => ({ weekday: r.weekday, opens: timeToMinutes(r.s), closes: timeToMinutes(r.e) }));
    for (const at of ctx.instants) {
      const { weekday, minutes } = localWeekdayMinutes(at, b.timezone);
      if (!isWithinWeeklyWindows(windows, weekday, minutes))
        return fail('ALCOHOL_OUTSIDE_HOURS', 'Fuera del horario permitido para venta y entrega de bebidas alcohólicas (incluye la hora estimada de entrega)');
      const blackout = await t.maybe(`SELECT reason FROM alcohol_blackouts WHERE jurisdiction_id = $1 AND starts_at <= $2 AND ends_at > $2 LIMIT 1`, [j, at]);
      if (blackout) return fail('ALCOHOL_BLACKOUT', `Venta de alcohol suspendida: ${blackout.reason}`);
    }
  }
  return { ok: true, code: 'OK', message: 'Permitido' };
}

export async function requireAlcoholSale(ctx: AlcoholSaleContext, t: Tx = db) {
  const r = await alcoholSaleCheck(ctx, t);
  if (!r.ok) throw new BizError(r.code, r.message, 422);
}

export async function requireRestrictedBuyer(a: AuthCtx, minimumAge: number, t: Tx = db) {
  const r = await restrictedAccess(a, minimumAge, new Date(), t);
  if (!r.allowed) {
    const msg: Record<string, string> = {
      AUTH_REQUIRED: 'Inicia sesión para continuar',
      NOT_VERIFIED: 'Necesitas una verificación de mayoría de edad aprobada para comprar este producto',
      VERIFICATION_PENDING: 'Tu verificación de edad está pendiente de revisión',
      VERIFICATION_REVOKED: 'Tu verificación de edad fue revocada; solicita una nueva revisión',
      VERIFICATION_REJECTED: 'Tu verificación de edad fue rechazada',
      UNDERAGE: 'Este producto es solo para mayores de edad',
    };
    throw new BizError('AGE_RESTRICTED', msg[r.reason] ?? 'Producto restringido', 403, { reason: r.reason });
  }
}
