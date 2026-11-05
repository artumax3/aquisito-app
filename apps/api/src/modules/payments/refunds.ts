import type { Tx } from '../../db/db';
import { emit } from '../../common/audit';
import { BizError } from '../../common/errors';
import { transition } from '../orders/state';

/**
 * Solicita un reembolso (idempotente por clave). Solo REGISTRA la solicitud dentro de la
 * transacción; la llamada al proveedor la ejecuta el job fuera de la transacción. El reembolso se
 * marca realizado únicamente con confirmación del proveedor (o "not_required" si nunca se cobró).
 */
export async function requestRefund(
  t: Tx,
  order: any,
  opts: { amountCents: number; concept: string; reason: string; idempotencyKey: string; userId: string | null; actor: 'system' | 'support' | 'finance' },
) {
  const existing = await t.maybe(`SELECT * FROM refunds WHERE idempotency_key = $1`, [opts.idempotencyKey]);
  if (existing) return existing;
  const pendingSum = await t.one(`SELECT coalesce(sum(amount_cents),0)::bigint AS s FROM refunds WHERE order_id = $1 AND status IN ('pending','succeeded')`, [order.id]);
  const payment = await t.maybe(`SELECT * FROM payments WHERE order_id = $1 AND status IN ('pagado','reembolso_pendiente','parcialmente_reembolsado') ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [order.id]);
  const collectedCash = order.payment_method === 'cash' && order.payment_status === 'pagado';
  const paidAmount = payment?.amount_cents ?? (collectedCash ? order.total_cents : 0);
  if (opts.amountCents <= 0) throw new BizError('REFUND_INVALID', 'Importe inválido', 422);
  if (Number(pendingSum.s) + opts.amountCents > paidAmount) {
    if (paidAmount === 0) {
      // Nunca se cobró: no hay nada que devolver; se deja constancia.
      return t.one(
        `INSERT INTO refunds(order_id, amount_cents, concept, reason, status, idempotency_key, requested_by, confirmed_at) VALUES ($1,$2,$3,$4,'not_required',$5,$6, now()) RETURNING *`,
        [order.id, opts.amountCents, opts.concept, opts.reason + ' (sin cobro previo)', opts.idempotencyKey, opts.userId],
      );
    }
    throw new BizError('REFUND_EXCEEDS', 'El reembolso supera lo cobrado', 422);
  }
  const r = await t.one(
    `INSERT INTO refunds(payment_id, order_id, amount_cents, concept, reason, idempotency_key, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [payment?.id ?? null, order.id, opts.amountCents, opts.concept, opts.reason, opts.idempotencyKey, opts.userId],
  );
  if (order.payment_status === 'pagado' || order.payment_status === 'parcialmente_reembolsado') {
    await transition(t, order, 'payment', 'reembolso_pendiente', opts.actor, { userId: opts.userId, reason: opts.reason });
  }
  if (payment) await t.q(`UPDATE payments SET status = 'reembolso_pendiente', updated_at = now() WHERE id = $1`, [payment.id]);
  await emit(t, 'refund.requested', order.id, { refundId: r.id, orderId: order.id });
  return r;
}
