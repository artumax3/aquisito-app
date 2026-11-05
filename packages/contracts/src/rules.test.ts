import { describe, expect, it } from 'vitest';
import {
  ageOn,
  comboAvailableStock,
  deliveryFee,
  distributeDiscount,
  isAdultOn,
  isWithinWeeklyWindows,
  localDate,
  localWeekdayMinutes,
  parseHHMM,
} from './rules';
import { COMMERCIAL_TRANSITIONS, DELIVERY_TRANSITIONS, canTransition } from './state-machines';

describe('edad por fecha completa (criterio 16)', () => {
  it('cumple 18 exactamente el día de su cumpleaños', () => {
    expect(isAdultOn('2008-11-06', '2026-11-05')).toBe(false);
    expect(isAdultOn('2008-11-06', '2026-11-06')).toBe(true);
    expect(ageOn('2008-12-31', '2026-01-01')).toBe(17);
  });
  it('29 de febrero en año no bisiesto', () => {
    expect(isAdultOn('2008-02-29', '2026-02-28')).toBe(false);
    expect(isAdultOn('2008-02-29', '2026-03-01')).toBe(true);
  });
  it('la fecha local de Lima difiere de UTC cerca de medianoche', () => {
    // 2026-11-06 03:00 UTC = 2026-11-05 22:00 en Lima
    const instant = new Date('2026-11-06T03:00:00Z');
    expect(localDate(instant, 'America/Lima')).toBe('2026-11-05');
    expect(isAdultOn('2008-11-06', localDate(instant, 'America/Lima'))).toBe(false);
  });
});

describe('franjas horarias (criterio 21)', () => {
  const fridayNight = [{ weekday: 5, opens: parseHHMM('18:00'), closes: parseHHMM('02:00') }];
  it('cruza medianoche', () => {
    expect(isWithinWeeklyWindows(fridayNight, 5, parseHHMM('23:59'))).toBe(true);
    expect(isWithinWeeklyWindows(fridayNight, 6, parseHHMM('01:30'))).toBe(true);
    expect(isWithinWeeklyWindows(fridayNight, 6, parseHHMM('02:00'))).toBe(false);
    expect(isWithinWeeklyWindows(fridayNight, 5, parseHHMM('17:59'))).toBe(false);
  });
  it('sábado→domingo envuelve la semana', () => {
    const sat = [{ weekday: 6, opens: parseHHMM('20:00'), closes: parseHHMM('01:00') }];
    expect(isWithinWeeklyWindows(sat, 0, parseHHMM('00:30'))).toBe(true);
  });
  it('convierte instantes a hora local', () => {
    const r = localWeekdayMinutes(new Date('2026-11-07T05:30:00Z'), 'America/Lima'); // vie 00:30
    expect(r).toEqual({ weekday: 6, minutes: 30 });
  });
});

describe('dinero', () => {
  it('reparte descuentos sin perder céntimos', () => {
    const r = distributeDiscount([333, 333, 334], 100);
    expect(r.reduce((a, b) => a + b, 0)).toBe(100);
    expect(distributeDiscount([100], 500)).toEqual([100]);
  });
  it('tarifa de reparto', () => {
    const rule = { baseFeeCents: 500, includedMeters: 2000, perKmCents: 150, surchargeCents: 0 };
    expect(deliveryFee(rule, 1500)).toBe(500);
    expect(deliveryFee(rule, 3000)).toBe(650);
    expect(deliveryFee(rule, 2050)).toBe(515);
  });
});

describe('combo', () => {
  it('stock = mínimo floor(disponible/requerido)', () => {
    expect(comboAvailableStock([{ available: 5, required: 2 }, { available: 10, required: 1 }])).toBe(2);
    expect(comboAvailableStock([{ available: 1, required: 2 }])).toBe(0);
  });
});

describe('máquinas de estado', () => {
  it('rechaza transiciones no definidas o con actor no autorizado', () => {
    expect(canTransition(COMMERCIAL_TRANSITIONS, 'confirmado', 'aceptado_comercio', 'merchant')).toBe(true);
    expect(canTransition(COMMERCIAL_TRANSITIONS, 'confirmado', 'aceptado_comercio', 'customer')).toBe(false);
    expect(canTransition(COMMERCIAL_TRANSITIONS, 'pendiente_confirmacion', 'completado', 'system')).toBe(false);
    expect(canTransition(DELIVERY_TRANSITIONS, 'en_destino', 'entregado', 'courier')).toBe(true);
    expect(canTransition(DELIVERY_TRANSITIONS, 'verificacion_requerida', 'entregado', 'support')).toBe(false);
  });
});
