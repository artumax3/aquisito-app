import type { Tx } from '../../db/db';
import { emit } from '../../common/audit';
import { release } from '../inventory/inventory.service';
import { requestRefund } from '../payments/refunds';
import { transition } from './state';
import type { Actor } from '@aquisito/contracts';

/** Revierte efectos de reserva no monetarios: cupón, franja, cupo de combo. Idempotente. */
async function revertAllocations(t: Tx, order: any) {
  const red = await t.maybe(`UPDATE coupon_redemptions SET status = 'reversed' WHERE order_id = $1 AND status = 'active' RETURNING coupon_id, amount_cents`, [order.id]);
  if (red) await t.q(`UPDATE coupons SET uses_count = uses_count - 1, budget_used_cents = budget_used_cents - $2 WHERE id = $1`, [red.coupon_id, red.amount_cents]);
  const marker = await t.maybe(`SELECT 1 FROM order_status_history WHERE order_id = $1 AND cycle = 'commercial' AND reason = '__allocations_reverted' LIMIT 1`, [order.id]);
  if (marker) return;
  if (order.scheduled_for) await t.q(`UPDATE scheduled_slot_bookings SET booked = booked - 1 WHERE branch_id = $1 AND slot_start = $2 AND booked > 0`, [order.branch_id, order.scheduled_for]);
  const combos = await t.q(`SELECT product_id, sum(quantity)::int AS q FROM order_lines WHERE order_id = $1 AND product_kind = 'combo' GROUP BY product_id`, [order.id]);
  for (const c of combos) await t.q(`UPDATE products SET combo_quota_used = greatest(0, combo_quota_used - $2) WHERE id = $1 AND combo_quota_total IS NOT NULL`, [c.product_id, c.q]);
  await t.q(
    `INSERT INTO order_status_history(order_id, cycle, from_status, to_status, actor_role, reason, order_version) VALUES ($1,'commercial',$2,$2,'system','__allocations_reverted',$3)`,
    [order.id, order.commercial_status, order.version],
  );
}

/**
 * Cancelación/rechazo con todos sus efectos: estado comercial, fin de asignación y ofertas,
 * liberación de reservas, reversión de cupón/franja/cupo y reembolso del pago confirmado.
 */
export async function cancelOrderTx(
  t: Tx,
  order: any,
  opts: { to: 'cancelado' | 'rechazado_comercio'; actor: Actor; userId: string | null; reason: string; refundActor?: 'system' | 'support' | 'finance' },
) {
  await transition(t, order, 'commercial', opts.to, opts.actor, {
    userId: opts.userId,
    reason: opts.reason,
    extraSet: { cancelled_at: new Date(), cancel_reason: opts.reason },
  });
  await t.q(`UPDATE delivery_offers SET status = 'cancelled', responded_at = now() WHERE order_id = $1 AND status = 'offered'`, [order.id]);
  await t.q(`UPDATE deliveries SET status = 'ended', ended_at = now(), end_reason = 'pedido cancelado' WHERE order_id = $1 AND status = 'active' AND $2::text IN ('sin_asignar','oferta_enviada','asignado','en_camino_al_comercio')`, [order.id, order.delivery_status]);
  await release(t, order.id, opts.reason, opts.userId);
  await revertAllocations(t, order);
  if (order.payment_status === 'pagado') {
    await requestRefund(t, order, {
      amountCents: order.total_cents - order.refunded_cents,
      concept: 'mixed',
      reason: `Reembolso por ${opts.to === 'rechazado_comercio' ? 'rechazo del comercio' : 'cancelación'}: ${opts.reason}`,
      idempotencyKey: `cancel:${order.id}`,
      userId: opts.userId,
      actor: opts.refundActor ?? 'system',
    });
  } else if (order.payment_status === 'pendiente' || order.payment_status === 'en_conciliacion') {
    // El pago no se confirmó: se cierra como vencido. Si el proveedor confirma después, el
    // manejador de pagos tardíos inicia la devolución automáticamente.
    if (order.payment_status === 'pendiente') await transition(t, order, 'payment', 'vencido', 'system', { reason: 'Pedido cancelado antes de confirmar el pago' });
  }
  await emit(t, 'order.cancelled', order.id, { orderId: order.id, to: opts.to });
}
