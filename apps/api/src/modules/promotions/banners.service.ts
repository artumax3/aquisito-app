import { db, tx } from '../../db/db';
import { AuthCtx } from '../../common/auth';
import { BizError } from '../../common/errors';
import { audit } from '../../common/audit';
import { restrictedAccess } from '../alcohol/alcohol.service';

const dto = (b: any) => ({ id: b.id, cityId: b.city_id, title: b.title, body: b.body, conditions: b.conditions, linkBranchId: b.link_branch_id, containsAlcohol: b.contains_alcohol, startsAt: b.starts_at, endsAt: b.ends_at, active: b.active, isDemo: b.is_demo });

/**
 * Banners vigentes de la ciudad. Los que promocionan alcohol se omiten salvo para adultos
 * verificados (y nunca se envían a cuentas sin sesión): no hay filtración por la API pública.
 * Un banner que enlaza a una sucursal que solo vende alcohol también se considera restringido.
 */
export async function activeBanners(a: AuthCtx | null, cityId: string) {
  const adult = (await restrictedAccess(a)).allowed;
  const rows = await db.q(
    `SELECT b.* FROM banners b WHERE b.active AND now() BETWEEN b.starts_at AND b.ends_at AND (b.city_id IS NULL OR b.city_id = $1)
       AND ($2 OR NOT b.contains_alcohol) ORDER BY b.starts_at DESC LIMIT 10`,
    [cityId, adult],
  );
  return rows.map(dto);
}

export const listAll = async () => (await db.q(`SELECT * FROM banners ORDER BY created_at DESC LIMIT 200`)).map(dto);

export async function create(a: AuthCtx, input: { cityId?: string; title: string; body: string; conditions: string; linkBranchId?: string; containsAlcohol: boolean; startsAt: string; endsAt: string }) {
  if (new Date(input.endsAt) <= new Date(input.startsAt)) throw new BizError('INVALID_RANGE', 'Vigencia inválida', 422);
  return tx(async (t) => {
    let containsAlcohol = input.containsAlcohol;
    if (input.linkBranchId) {
      const b = await t.maybe(`SELECT city_id FROM branches WHERE id = $1`, [input.linkBranchId]);
      if (!b) throw new BizError('NOT_FOUND', 'Sucursal no encontrada', 404);
      if (input.cityId && b.city_id !== input.cityId) throw new BizError('CROSS_CITY', 'El banner y la sucursal deben ser de la misma ciudad', 422);
    }
    // Detección conservadora: si el texto menciona bebidas alcohólicas, se marca restringido.
    if (/cerveza|vino|licor|ron|pisco|whisky|vodka|alcoh/i.test(`${input.title} ${input.body}`)) containsAlcohol = true;
    const r = await t.one(
      `INSERT INTO banners(city_id, title, body, conditions, link_branch_id, contains_alcohol, starts_at, ends_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [input.cityId ?? null, input.title, input.body, input.conditions, input.linkBranchId ?? null, containsAlcohol, input.startsAt, input.endsAt, a.userId],
    );
    await audit(t, a, 'banner.created', 'banner', r.id, null, { containsAlcohol });
    return dto(r);
  });
}

export async function setActive(a: AuthCtx, id: string, active: boolean, reason: string) {
  return tx(async (t) => {
    const r = await t.maybe(`UPDATE banners SET active = $2 WHERE id = $1 RETURNING *`, [id, active]);
    if (!r) throw new BizError('NOT_FOUND', 'Banner no encontrado', 404);
    await audit(t, a, active ? 'banner.activated' : 'banner.deactivated', 'banner', id, reason);
    return dto(r);
  });
}
