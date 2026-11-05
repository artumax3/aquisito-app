import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { MFA_REQUIRED_ROLES, Role } from '@aquisito/contracts';
import { db } from '../db/db';
import { sha256, safeEqual } from './crypto';
import { BizError } from './errors';

export interface MembershipRow {
  id: string;
  role: Role;
  city_id: string | null;
  merchant_id: string | null;
  branch_id: string | null;
}

export interface AuthCtx {
  userId: string;
  sessionId: string;
  memberships: MembershipRow[];
  roles: Set<Role>;
  mfaVerified: boolean;
  viaCookie: boolean;
  correlationId: string;
}

export const PUBLIC_KEY = 'aq_public';
export const ROLES_KEY = 'aq_roles';
/** Ruta pública (sin sesión). Las rutas sin decorador exigen sesión. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
/** La sesión debe tener al menos uno de estos roles (el ámbito se valida en el servicio). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export const SESSION_COOKIE = 'aq_session';
export const CSRF_COOKIE = 'aq_csrf';

export function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export async function resolveSession(req: Request): Promise<AuthCtx | null> {
  const header = req.headers.authorization;
  let token: string | undefined;
  let viaCookie = false;
  if (header?.startsWith('Bearer ')) token = header.slice(7);
  else {
    const c = parseCookies(req.headers.cookie);
    if (c[SESSION_COOKIE]) {
      token = c[SESSION_COOKIE];
      viaCookie = true;
    }
  }
  if (!token) return null;
  const s = await db.maybe(
    `SELECT s.id, s.user_id, s.mfa_verified_at FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'`,
    [sha256(token)],
  );
  if (!s) return null;
  const memberships = await db.q<MembershipRow>(
    `SELECT id, role, city_id, merchant_id, branch_id FROM memberships WHERE user_id = $1 AND revoked_at IS NULL`,
    [s.user_id],
  );
  db.q(`UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '5 minutes'`, [s.id]).catch(() => undefined);
  const roles = new Set<Role>(['customer', ...memberships.map((m) => m.role)]);
  return {
    userId: s.user_id,
    sessionId: s.id,
    memberships,
    roles,
    mfaVerified: !!s.mfa_verified_at,
    viaCookie,
    correlationId: (req as any).correlationId,
  };
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { auth?: AuthCtx | null }>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()]);
    const auth = await resolveSession(req);
    req.auth = auth;
    if (isPublic) return true;
    if (!auth) throw new BizError('UNAUTHENTICATED', 'Inicia sesión para continuar', 401);

    // CSRF: con cookie de sesión, las operaciones que modifican exigen el token doble-envío.
    if (auth.viaCookie && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const c = parseCookies(req.headers.cookie);
      const h = req.headers['x-csrf-token'];
      if (!c[CSRF_COOKIE] || typeof h !== 'string' || !safeEqual(c[CSRF_COOKIE], h))
        throw new BizError('CSRF', 'Token CSRF inválido', 403);
    }

    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (roles?.length) {
      const granted = roles.filter((r) => auth.roles.has(r));
      if (granted.length === 0) throw new BizError('FORBIDDEN', 'No tienes permiso para esta acción', 403);
      // Autenticación adicional: si el ÚNICO camino de acceso es un rol sensible, exigir MFA.
      const onlySensitive = granted.every((r) => MFA_REQUIRED_ROLES.includes(r));
      if (onlySensitive && !auth.mfaVerified)
        throw new BizError('MFA_REQUIRED', 'Esta operación requiere verificación en dos pasos', 403);
    }
    return true;
  }
}

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthCtx => {
  return ctx.switchToHttp().getRequest().auth;
});

export const OptionalAuth = Auth;

// ---------- Ámbitos ----------
export function hasRole(a: AuthCtx | null | undefined, role: Role): boolean {
  return !!a && a.roles.has(role);
}

export function isGlobal(a: AuthCtx, role: Role): boolean {
  return a.memberships.some((m) => m.role === role && !m.city_id && !m.merchant_id && !m.branch_id);
}

/** Ciudades donde el usuario opera como staff de plataforma; null = todas (admin global). */
export function opsCityScope(a: AuthCtx, roles: Role[] = ['admin', 'city_dispatcher', 'support_agent', 'finance']): string[] | null {
  const ms = a.memberships.filter((m) => roles.includes(m.role));
  if (ms.some((m) => !m.city_id)) return null;
  return ms.map((m) => m.city_id!).filter(Boolean);
}

export function requireMfaIfSensitive(a: AuthCtx) {
  if (!a.mfaVerified) throw new BizError('MFA_REQUIRED', 'Esta operación requiere verificación en dos pasos', 403);
}

/** ¿Puede el usuario operar la sucursal? Propietario del comercio u operador de esa sucursal. */
export async function branchAccess(a: AuthCtx, branchId: string): Promise<{ merchantId: string; cityId: string; isOwner: boolean }> {
  const b = await db.maybe<{ merchant_id: string; city_id: string }>(`SELECT merchant_id, city_id FROM branches WHERE id = $1`, [branchId]);
  if (!b) throw new BizError('NOT_FOUND', 'Sucursal no encontrada', 404);
  const isOwner = a.memberships.some((m) => m.role === 'merchant_owner' && m.merchant_id === b.merchant_id);
  const isOperator = a.memberships.some((m) => m.role === 'branch_operator' && m.branch_id === branchId);
  // 404 en lugar de 403 para no revelar existencia de datos de otro comercio.
  if (!isOwner && !isOperator) throw new BizError('NOT_FOUND', 'Sucursal no encontrada', 404);
  return { merchantId: b.merchant_id, cityId: b.city_id, isOwner };
}

export function assertCityScope(a: AuthCtx, cityId: string, roles?: Role[]) {
  const scope = opsCityScope(a, roles);
  if (scope !== null && !scope.includes(cityId)) throw new BizError('NOT_FOUND', 'Recurso no encontrado', 404);
}

export function actorRoles(a: AuthCtx): string[] {
  return [...a.roles];
}
