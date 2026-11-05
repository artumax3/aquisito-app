import { localDate, localWeekdayMinutes } from '@aquisito/contracts';
import { db } from '../db/db';

export const LIMA = 'America/Lima';

/** Suma días hábiles (lun–vie, excluye feriados registrados en peru_holidays) en hora de Lima. */
export async function addBusinessDays(from: Date, days: number, tz = LIMA): Promise<Date> {
  const holidays = new Set(
    (await db.q(`SELECT to_char(day, 'YYYY-MM-DD') AS d FROM peru_holidays WHERE day >= $1::date - 1`, [localDate(from, tz)])).map((r) => r.d),
  );
  let d = new Date(from.getTime());
  let added = 0;
  while (added < days) {
    d = new Date(d.getTime() + 24 * 3600 * 1000);
    const { weekday } = localWeekdayMinutes(d, tz);
    if (weekday === 0 || weekday === 6) continue;
    if (holidays.has(localDate(d, tz))) continue;
    added++;
  }
  return d;
}

export function localNow(tz = LIMA, at = new Date()) {
  return { date: localDate(at, tz), ...localWeekdayMinutes(at, tz) };
}

export function minutesToHHMM(m: number) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
