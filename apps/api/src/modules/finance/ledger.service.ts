import type { Tx } from '../../db/db';

export interface Entry {
  orderId: string | null;
  partyType: 'platform' | 'merchant' | 'courier' | 'customer' | 'gateway';
  partyId: string | null;
  type: string;
  amount: number;
  description: string;
  reference?: string | null;
  /** Clave determinística: repetir el mismo hecho no duplica el asiento. */
  dedupeKey: string;
  createdBy?: string | null;
}

export async function post(t: Tx, entries: Entry[]) {
  for (const e of entries) {
    if (e.amount === 0) continue;
    await t.q(
      `INSERT INTO ledger_entries(order_id, party_type, party_id, entry_type, amount_cents, description, reference, dedupe_key, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (dedupe_key) DO NOTHING`,
      [e.orderId, e.partyType, e.partyId, e.type, e.amount, e.description, e.reference ?? null, e.dedupeKey, e.createdBy ?? null],
    );
  }
}

/** Comisión vigente del comercio en la fecha del pedido (puntos básicos). */
export async function commissionBp(t: Tx, merchantId: string, at: Date): Promise<number> {
  const r = await t.maybe(
    `SELECT percent_bp FROM commission_rules WHERE merchant_id = $1 AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2) ORDER BY valid_from DESC LIMIT 1`,
    [merchantId, at],
  );
  return r?.percent_bp ?? 0;
}

/**
 * Asientos al completar un pedido. Fórmulas (docs/finanzas.md):
 *  base_comisionable = subtotal - descuento financiado por el comercio
 *  comision          = round(base_comisionable * bp / 10000)
 *  comercio          = +base_comisionable  -comision
 *  repartidor        = +pago_reparto (cotizado) +propina
 *  plataforma        = +comision +tarifa_servicio +recargo +(tarifa_reparto - pago_reparto) -descuento financiado por plataforma
 *  efectivo          = el repartidor queda debiendo el monto cobrado (saldo por rendir)
 */
export async function postCompletion(t: Tx, order: any) {
  const bp = await commissionBp(t, order.merchant_id, new Date(order.created_at));
  const merchantDiscount = order.coupon_funded_by === 'merchant' ? order.discount_cents : 0;
  const platformDiscount = order.coupon_funded_by === 'platform' ? order.discount_cents : 0;
  const base = order.subtotal_cents - merchantDiscount;
  const commission = Math.round((base * bp) / 10000);
  const courier = await t.maybe(`SELECT courier_id FROM deliveries WHERE order_id = $1 ORDER BY assigned_at DESC LIMIT 1`, [order.id]);
  const k = (s: string) => `order:${order.id}:${s}`;
  const entries: Entry[] = [
    { orderId: order.id, partyType: 'merchant', partyId: order.merchant_id, type: 'merchant_sale', amount: base, description: 'Venta de productos (neto de descuento del comercio)', dedupeKey: k('merchant_sale') },
    { orderId: order.id, partyType: 'merchant', partyId: order.merchant_id, type: 'merchant_commission', amount: -commission, description: `Comisión plataforma ${bp / 100}%`, dedupeKey: k('merchant_commission') },
    { orderId: order.id, partyType: 'platform', partyId: null, type: 'platform_commission', amount: commission, description: 'Ingreso por comisión', dedupeKey: k('platform_commission') },
    { orderId: order.id, partyType: 'platform', partyId: null, type: 'platform_service_fee', amount: order.service_fee_cents + order.surcharge_cents, description: 'Tarifa de servicio y recargos', dedupeKey: k('platform_service_fee') },
    { orderId: order.id, partyType: 'platform', partyId: null, type: 'platform_delivery_margin', amount: order.delivery_fee_cents - order.courier_pay_cents, description: 'Margen de reparto', dedupeKey: k('platform_delivery_margin') },
    { orderId: order.id, partyType: 'platform', partyId: null, type: 'platform_promo_cost', amount: -platformDiscount, description: 'Descuento financiado por la plataforma', dedupeKey: k('platform_promo_cost') },
  ];
  if (courier) {
    entries.push(
      { orderId: order.id, partyType: 'courier', partyId: courier.courier_id, type: 'courier_delivery_pay', amount: order.courier_pay_cents, description: 'Pago por reparto', dedupeKey: k('courier_delivery_pay') },
      { orderId: order.id, partyType: 'courier', partyId: courier.courier_id, type: 'courier_tip', amount: order.tip_cents, description: 'Propina (100% al repartidor)', dedupeKey: k('courier_tip') },
    );
    if (order.payment_method === 'cash') {
      entries.push({ orderId: order.id, partyType: 'courier', partyId: courier.courier_id, type: 'courier_cash_held', amount: -order.total_cents, description: 'Efectivo cobrado por rendir', dedupeKey: k('courier_cash_held') });
    }
  }
  await post(t, entries);
}

/** Recalcula una liquidación desde sus movimientos (debe coincidir con total_cents). */
export async function recomputeSettlement(t: Tx, settlementId: string) {
  const r = await t.one(
    `SELECT coalesce(sum(l.amount_cents),0)::bigint AS total, count(*)::int AS n FROM settlement_items si JOIN ledger_entries l ON l.id = si.ledger_entry_id WHERE si.settlement_id = $1`,
    [settlementId],
  );
  return { totalCents: Number(r.total), entries: r.n };
}
