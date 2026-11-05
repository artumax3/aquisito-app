import type { Tx } from '../../db/db';
import { db } from '../../db/db';
import { BizError } from '../../common/errors';

export interface CoverageResult {
  inCoverage: boolean;
  reason: string | null;
  code: 'OK' | 'OUTSIDE_POLYGON' | 'OTHER_CITY' | 'ZONE_SUSPENDED' | 'CITY_PAUSED' | 'TOO_FAR' | 'NO_JURISDICTION';
  zoneId: string | null;
  zoneName: string | null;
  zoneVersionId: string | null;
  jurisdictionId: string | null;
  jurisdictionName: string | null;
  suspension: { reason: string; detail: string | null; endsAt: string } | null;
}

/**
 * Cobertura en servidor (PostGIS). Se evalúa al cotizar, confirmar, programar y reasignar. El
 * punto debe caer en una versión VIGENTE de una zona de la MISMA ciudad, sin suspensión activa, y
 * en una jurisdicción municipal registrada de esa ciudad.
 */
export async function checkCoverage(cityId: string, lat: number, lng: number, at = new Date(), t: Tx = db): Promise<CoverageResult> {
  const base: CoverageResult = { inCoverage: false, reason: null, code: 'OUTSIDE_POLYGON', zoneId: null, zoneName: null, zoneVersionId: null, jurisdictionId: null, jurisdictionName: null, suspension: null };
  const city = await t.maybe(`SELECT id, status, pause_reason FROM cities WHERE id = $1`, [cityId]);
  if (!city) throw new BizError('NOT_FOUND', 'Ciudad no encontrada', 404);
  const pt = `ST_SetSRID(ST_MakePoint($2, $3), 4326)`;
  const zone = await t.maybe(
    `SELECT z.id, z.name, zv.id AS version_id FROM zones z JOIN zone_versions zv ON zv.zone_id = z.id AND zv.is_current
     WHERE z.city_id = $1 AND z.status = 'active' AND ST_Contains(zv.geom, ${pt}) LIMIT 1`,
    [cityId, lng, lat],
  );
  const jur = await t.maybe(`SELECT id, name FROM jurisdictions WHERE city_id = $1 AND ST_Contains(geom, ${pt}) LIMIT 1`, [cityId, lng, lat]);
  if (!zone) {
    const other = await t.maybe(
      `SELECT c.name FROM zones z JOIN zone_versions zv ON zv.zone_id = z.id AND zv.is_current JOIN cities c ON c.id = z.city_id
       WHERE z.city_id <> $1 AND ST_Contains(zv.geom, ${pt}) LIMIT 1`,
      [cityId, lng, lat],
    );
    if (other) return { ...base, code: 'OTHER_CITY', reason: `La dirección pertenece a la operación de ${other.name}. No se realizan envíos entre ciudades.` };
    return { ...base, reason: 'La dirección está fuera de la zona de reparto' };
  }
  const r: CoverageResult = { ...base, zoneId: zone.id, zoneName: zone.name, zoneVersionId: zone.version_id, jurisdictionId: jur?.id ?? null, jurisdictionName: jur?.name ?? null };
  if (city.status === 'paused') return { ...r, code: 'CITY_PAUSED', reason: city.pause_reason ?? 'Operación pausada temporalmente en esta ciudad' };
  if (!jur) return { ...r, code: 'NO_JURISDICTION', reason: 'No hay jurisdicción municipal configurada para este punto' };
  const susp = await t.maybe(
    `SELECT reason, detail, ends_at FROM zone_suspensions WHERE zone_id = $1 AND starts_at <= $2 AND ends_at > $2 ORDER BY ends_at DESC LIMIT 1`,
    [zone.id, at],
  );
  if (susp) {
    return {
      ...r,
      code: 'ZONE_SUSPENDED',
      reason: `Zona suspendida temporalmente (${susp.reason.replace('_', ' ')})`,
      suspension: { reason: susp.reason, detail: susp.detail, endsAt: susp.ends_at.toISOString() },
    };
  }
  return { ...r, inCoverage: true, code: 'OK' };
}

export async function requireCoverage(cityId: string, lat: number, lng: number, at = new Date(), t: Tx = db) {
  const c = await checkCoverage(cityId, lat, lng, at, t);
  if (!c.inCoverage) throw new BizError(c.code === 'OTHER_CITY' ? 'CROSS_CITY' : 'OUT_OF_COVERAGE', c.reason ?? 'Fuera de cobertura', 422, { code: c.code });
  return c;
}

export async function listCities() {
  const rows = await db.q(`SELECT id, slug, name, timezone, status, pause_reason, ST_Y(center) AS lat, ST_X(center) AS lng FROM cities ORDER BY name`);
  return rows.map((c) => ({ id: c.id, slug: c.slug, name: c.name, timezone: c.timezone, status: c.status, pauseReason: c.pause_reason, center: { lat: c.lat, lng: c.lng } }));
}

/** Sugerencia de ciudad por ubicación (con permiso del usuario): la zona que contiene el punto o la más cercana. */
export async function suggestCity(lat: number, lng: number) {
  return db.maybe(
    `SELECT id, name FROM cities ORDER BY ST_Distance(center::geography, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography) LIMIT 1`,
    [lng, lat],
  );
}

export async function cityZones(cityId: string) {
  const rows = await db.q(
    `SELECT z.id, z.name, zv.version, zv.is_demo_geometry, ST_AsGeoJSON(zv.geom)::json AS geometry,
       EXISTS (SELECT 1 FROM zone_suspensions s WHERE s.zone_id = z.id AND now() BETWEEN s.starts_at AND s.ends_at) AS suspended
     FROM zones z JOIN zone_versions zv ON zv.zone_id = z.id AND zv.is_current WHERE z.city_id = $1`,
    [cityId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, version: r.version, isDemoGeometry: r.is_demo_geometry, suspended: r.suspended, geometry: r.geometry }));
}
