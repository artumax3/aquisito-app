/**
 * Reglas puras compartidas por backend y clientes. El backend es la autoridad: los clientes solo
 * las usan para mostrar información anticipada.
 */

/** Dinero: siempre céntimos enteros de PEN. */
export function formatPEN(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  const soles = Math.floor(abs / 100);
  const cent = (abs % 100).toString().padStart(2, '0');
  return `${sign}S/ ${soles.toLocaleString('es-PE')}.${cent}`;
}

/**
 * Reparte un descuento entre líneas proporcionalmente a su importe con el método del mayor resto.
 * La suma del resultado es exactamente `discount` y ninguna línea recibe más que su importe.
 */
export function distributeDiscount(lineTotals: number[], discount: number): number[] {
  const total = lineTotals.reduce((a, b) => a + b, 0);
  if (total <= 0 || discount <= 0) return lineTotals.map(() => 0);
  const d = Math.min(discount, total);
  const raw = lineTotals.map((t) => (t * d) / total);
  const floors = raw.map(Math.floor);
  let rest = d - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    if (floors[i] < lineTotals[i]) {
      floors[i] += 1;
      rest -= 1;
    }
  }
  return floors;
}

/** Fecha ISO (YYYY-MM-DD) en una zona horaria IANA. */
export function localDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

/** Día de la semana (0=domingo) y minutos desde medianoche en la zona indicada. */
export function localWeekdayMinutes(instant: Date, timeZone: string): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const wd = parts.find((p) => p.type === 'weekday')!.value;
  const h = Number(parts.find((p) => p.type === 'hour')!.value);
  const m = Number(parts.find((p) => p.type === 'minute')!.value);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
  return { weekday, minutes: h * 60 + m };
}

/**
 * Edad cumplida por fecha completa (no por resta de años). Ej.: nacido 2008-11-06 cumple 18 el
 * 2026-11-06; el 2026-11-05 aún tiene 17. Los nacidos un 29 de febrero cumplen el 1 de marzo en
 * años no bisiestos.
 */
export function ageOn(birthDate: string, onDate: string): number {
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const [y, m, d] = onDate.split('-').map(Number);
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age -= 1;
  return age;
}

export function isAdultOn(birthDate: string, onDate: string, minimumAge = 18): boolean {
  return ageOn(birthDate, onDate) >= minimumAge;
}

export interface WeeklyWindow {
  weekday: number; // 0 = domingo
  opens: number; // minutos desde 00:00
  closes: number; // minutos; si closes <= opens la franja cruza medianoche
}

/**
 * ¿Está el instante local dentro de alguna franja? Soporta franjas que cruzan medianoche: una
 * franja del viernes 18:00–02:00 cubre el sábado 01:30.
 */
export function isWithinWeeklyWindows(windows: WeeklyWindow[], weekday: number, minutes: number): boolean {
  for (const w of windows) {
    if (w.closes > w.opens) {
      if (w.weekday === weekday && minutes >= w.opens && minutes < w.closes) return true;
    } else {
      // cruza medianoche
      if (w.weekday === weekday && minutes >= w.opens) return true;
      if ((w.weekday + 1) % 7 === weekday && minutes < w.closes) return true;
    }
  }
  return false;
}

export function parseHHMM(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

/** stock_disponible_combo = min(floor(stock_componente / cantidad_requerida)). */
export function comboAvailableStock(components: { available: number; required: number }[]): number {
  if (components.length === 0) return 0;
  return Math.min(...components.map((c) => Math.floor(Math.max(0, c.available) / c.required)));
}

/**
 * Tarifa de reparto: base + km adicionales sobre lo incluido * precio por km + recargo. Redondeo:
 * se cobran kilómetros adicionales por décimas hacia arriba.
 */
export function deliveryFee(rule: {
  baseFeeCents: number;
  includedMeters: number;
  perKmCents: number;
  surchargeCents: number;
}, distanceMeters: number): number {
  const extra = Math.max(0, distanceMeters - rule.includedMeters);
  const extraTenths = Math.ceil(extra / 100);
  return rule.baseFeeCents + Math.ceil((extraTenths * rule.perKmCents) / 10) + rule.surchargeCents;
}

/** Distancia geodésica aproximada (haversine) en metros. Se etiqueta como aproximación. */
export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371008.8;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
