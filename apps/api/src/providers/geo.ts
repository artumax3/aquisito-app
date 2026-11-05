import { haversineMeters } from '@aquisito/contracts';
import { config } from '../config';
import { logger } from '../common/logger';

export interface RouteResult {
  meters: number;
  seconds: number | null;
  method: 'route' | 'approx_haversine';
}
type Pt = { lat: number; lng: number };

/**
 * Adaptador de rutas intercambiable. "haversine" es una APROXIMACIÓN (línea recta × 1.3 como
 * factor de desvío urbano); la interfaz lo etiqueta como estimación. "osrm" usa un servidor OSRM
 * propio (OSRM_URL); no se usa el servidor público demo como infraestructura.
 */
export async function routeDistance(a: Pt, b: Pt): Promise<RouteResult> {
  const c = config();
  if (c.ROUTE_PROVIDER === 'osrm' && c.OSRM_URL) {
    try {
      const url = `${c.OSRM_URL}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`;
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      const body: any = await res.json();
      if (body.code === 'Ok' && body.routes?.[0]) {
        return { meters: Math.round(body.routes[0].distance), seconds: Math.round(body.routes[0].duration), method: 'route' };
      }
    } catch (e) {
      logger.warn('osrm no disponible, uso aproximación', { err: (e as Error).message });
    }
  }
  return { meters: Math.round(haversineMeters(a, b) * 1.3), seconds: null, method: 'approx_haversine' };
}

/** Velocidad urbana supuesta para estimar recorrido cuando no hay duración de ruta (moto, 18 km/h). */
export function travelMinutes(r: RouteResult): number {
  if (r.seconds != null) return Math.ceil(r.seconds / 60);
  return Math.ceil(r.meters / 300);
}
