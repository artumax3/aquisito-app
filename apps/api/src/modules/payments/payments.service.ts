import { config } from '../../config';
import { db, tx } from '../../db/db';
import { AuthCtx } from '../../common/auth';
import { BizError } from '../../common/errors';
import { audit, emit } from '../../common/audit';
import { logger } from '../../common/logger';
import { paymentProvider, providerForMethod, SandboxProvider, VerifiedEvent } from '../../providers/payments';
import { lockOrder, transition } from '../orders/state';
import { acceptDeadline } from '../orders/orders.service';
import { post } from '../finance/ledger.service';
import { requestRefund } from './refunds';
import { cancelOrderTx } from '../orders/lifecycle';
import { alcoholSaleCheck } from '../alcohol/alcohol.service';

/** Configuración pública de cobro (nunca incluye llaves secretas). */
export function publicPaymentsConfig() {
  const c = config();
  const enabled = c.PAYMENT_PROVIDERS.split(',').map((x) => x.trim());
  const describe = (name: string) => ({
    provider: name,
    enabled: enabled.includes(name),
    simulator: name === 'sandbox',
    publicKey: name === 'culqi' ? c.CULQI_PUBLIC_KEY || null : null,
    // El checkout de Culqi corre en navegador (Culqi Checkout JS). En apps móviles queda pendiente su SDK.
    mobileCheckout: name === 'sandbox',
  });
  return { card: describe(c.CARD_PROVIDER), wallet: describe(c.WALLET_PROVIDER), cash: { enabled: true }, transfer: { enabled: c.TRANSFER_PAYMENTS_ENABLED } };
}

function paymentDto(p: any) {
  return {
    id: p.id,
    orderId: p.order_id,
    provider: p.provider,
    method: p.method,
    amountCents: p.amount_cents,
    status: p.status,
    checkoutUrl: p.checkout_url,
    expiresAt: p.expires_at,
    failureReason: p.failure_reason,
    simulated: p.provider === 'sandbox',
    // Referencia de la orden del proveedor (p. ej. ord_… de Culqi) para abrir su checkout de billeteras.
    checkoutReference: p.provider === 'culqi' && p.provider_reference?.startsWith('ord_') ? p.provider_reference : null,
  };
}

/**
 * Inicia el intento de pago digital. Idempotente: la clave del cliente y el índice único "un pago
 * vivo por pedido" impiden un segundo cargo. Si la respuesta del proveedor es incierta, el pago
 * queda "en_conciliacion" y no se reintenta a ciegas: el job consulta al proveedor.
 */
export async function startPayment(a: AuthCtx, input: { orderId: string; providerToken?: string }, idempotencyKey?: string) {
  if (!idempotencyKey || !/^[A-Za-z0-9_-]{8,80}$/.test(idempotencyKey)) throw new BizError('IDEMPOTENCY_KEY_REQUIRED', 'Falta el encabezado Idempotency-Key', 400);
  const o = await db.maybe(`SELECT * FROM orders WHERE id = $1 AND user_id = $2`, [input.orderId, a.userId]);
  if (!o) throw new BizError('NOT_FOUND', 'Pedido no encontrado', 404);
  if (!['card', 'wallet'].includes(o.payment_method)) throw new BizError('PAYMENT_METHOD', 'Este pedido no se paga en línea', 422);
  const byKey = await db.maybe(`SELECT * FROM payments WHERE idempotency_key = $1`, [`${a.userId}:${idempotencyKey}`]);
  if (byKey) {
    if (byKey.order_id !== o.id) throw new BizError('IDEMPOTENCY_KEY_REUSED', 'Clave de idempotencia usada para otro pedido', 409);
    return paymentDto(byKey);
  }
  const live = await db.maybe(`SELECT * FROM payments WHERE order_id = $1 AND status IN ('pendiente','autorizado','en_conciliacion','pagado','reembolso_pendiente','parcialmente_reembolsado','reembolsado')`, [o.id]);
  if (live) return paymentDto(live);
  if (o.commercial_status !== 'pendiente_confirmacion' || o.payment_status !== 'pendiente')
    throw new BizError('PAYMENT_NOT_ALLOWED', 'Este pedido ya no admite pago', 409);
  if (o.payment_deadline && o.payment_deadline < new Date()) throw new BizError('PAYMENT_EXPIRED', 'El plazo de pago venció', 409);

  const provider = providerForMethod(o.payment_method);
  let payment: any;
  try {
    payment = await db.one(
      `INSERT INTO payments(order_id, provider, method, amount_cents, idempotency_key, expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [o.id, provider.name, o.payment_method, o.total_cents, `${a.userId}:${idempotencyKey}`, o.payment_deadline],
    );
  } catch (e: any) {
    if (e?.code === '23505') {
      const p = await db.one(`SELECT * FROM payments WHERE order_id = $1 AND status IN ('pendiente','autorizado','en_conciliacion','pagado') ORDER BY created_at DESC LIMIT 1`, [o.id]);
      return paymentDto(p);
    }
    throw e;
  }
  const email = (await db.maybe(`SELECT email FROM users WHERE id = $1`, [a.userId]))?.email;
  try {
    const r = await provider.createCharge({
      paymentId: payment.id,
      orderId: o.id,
      orderNumber: o.number,
      amountCents: o.total_cents,
      currency: 'PEN',
      method: o.payment_method,
      providerToken: input.providerToken,
      customerEmail: email,
      idempotencyKey: payment.id,
    });
    if (r.outcome === 'uncertain') {
      await db.q(`UPDATE payments SET status = 'en_conciliacion', provider_reference = $2, updated_at = now() WHERE id = $1`, [payment.id, r.providerReference ?? null]);
      await markOrderPayment(o.id, 'en_conciliacion', 'Respuesta incierta del proveedor');
    } else {
      await db.q(`UPDATE payments SET provider_reference = $2, checkout_url = $3, updated_at = now() WHERE id = $1`, [payment.id, r.providerReference ?? null, r.checkoutUrl ?? null]);
      if (r.outcome === 'paid' || r.outcome === 'failed') {
        await applyProviderResult(payment.id, r.outcome, { amountCents: o.total_cents, currency: 'PEN', providerReference: r.providerReference!, source: 'respuesta síncrona' });
      }
    }
  } catch (e: any) {
    // Falla de red/timeout: NO sabemos si se cobró. Conciliación antes de cualquier nuevo cargo.
    logger.warn('pago con resultado incierto', { paymentId: payment.id, err: e.message });
    await db.q(`UPDATE payments SET status = 'en_conciliacion', provider_reference = coalesce($2, provider_reference), updated_at = now() WHERE id = $1`, [payment.id, e.uncertainReference ?? null]);
    await markOrderPayment(o.id, 'en_conciliacion', 'Respuesta incierta del proveedor');
  }
  return paymentDto(await db.one(`SELECT * FROM payments WHERE id = $1`, [payment.id]));
}

async function markOrderPayment(orderId: string, to: string, reason: string) {
  await tx(async (t) => {
    const o = await lockOrder(t, orderId);
    if (o.payment_status === 'pendiente' && to === 'en_conciliacion') await transition(t, o, 'payment', 'en_conciliacion', 'system', { reason });
  });
}

export async function getPayment(a: AuthCtx, id: string) {
  const p = await db.maybe(`SELECT p.* FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.id = $1 AND o.user_id = $2`, [id, a.userId]);
  if (!p) throw new BizError('NOT_FOUND', 'Pago no encontrado', 404);
  return paymentDto(p);
}

/**
 * Webhook: 1) autenticidad (firma o consulta directa), 2) deduplicación por id de evento,
 * 3) verificación de importe/moneda/referencia, 4) aplicación idempotente y tolerante al orden.
 */
export async function handleWebhook(providerName: string, headers: Record<string, any>, rawBody: string) {
  let provider;
  try {
    provider = paymentProvider(providerName);
  } catch {
    throw new BizError('NOT_FOUND', 'Proveedor no habilitado', 404);
  }
  const ev = await provider.verifyWebhook(headers, rawBody);
  if (!ev) {
    logger.warn('webhook rechazado: autenticidad no verificada', { provider: providerName });
    throw new BizError('WEBHOOK_UNVERIFIED', 'Firma inválida', 401);
  }
  const inserted = await db.maybe(
    `INSERT INTO payment_events(provider, provider_event_id, event_type, occurred_at, verified, verification_note, payload)
     VALUES ($1,$2,$3,$4,true,$5,$6) ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`,
    [providerName, ev.eventId, ev.type, ev.occurredAt, ev.verificationNote, rawBody],
  );
  if (!inserted) return { received: true, duplicate: true };
  const outcome = await applyVerifiedEvent(providerName, ev);
  await db.q(`UPDATE payment_events SET processed_at = now(), outcome = $2, payment_id = $3 WHERE id = $1`, [inserted.id, outcome.outcome, outcome.paymentId]);
  return { received: true, duplicate: false, outcome: outcome.outcome };
}

async function applyVerifiedEvent(providerName: string, ev: VerifiedEvent): Promise<{ outcome: string; paymentId: string | null }> {
  const p = await db.maybe(`SELECT * FROM payments WHERE provider = $1 AND provider_reference = $2`, [providerName, ev.providerReference]);
  if (!p) return { outcome: 'unknown_reference', paymentId: null };
  if (ev.status !== 'paid' && ev.status !== 'failed') return { outcome: 'ignored_status', paymentId: p.id };
  const r = await applyProviderResult(p.id, ev.status, { amountCents: ev.amountCents, currency: ev.currency, providerReference: ev.providerReference, source: `webhook ${ev.type}` });
  return { outcome: r, paymentId: p.id };
}

/**
 * Aplica un resultado CONFIRMADO del proveedor. Idempotente y tolerante a eventos fuera de orden:
 *  - pagado es terminal frente a "failed" posteriores (se ignoran);
 *  - importe/moneda/referencia distintos => no se aplica y se deja para revisión;
 *  - pago llegado tras vencer/cancelar => re-reserva atómica o devolución automática.
 */
export async function applyProviderResult(
  paymentId: string,
  status: 'paid' | 'failed',
  info: { amountCents: number; currency: string; providerReference: string; source: string },
): Promise<string> {
  return tx(async (t) => {
    const p0 = await t.one(`SELECT order_id FROM payments WHERE id = $1`, [paymentId]);
    const order = await lockOrder(t, p0.order_id);
    const p = await t.one(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [paymentId]);
    if (status === 'paid' && (info.amountCents !== p.amount_cents || info.currency !== 'PEN' || info.providerReference !== p.provider_reference)) {
      await audit(t, null, 'payment.mismatch', 'payment', p.id, 'Importe, moneda o referencia no coinciden', { expected: p.amount_cents, got: info.amountCents, currency: info.currency });
      await t.q(`UPDATE payments SET status = 'en_conciliacion', failure_reason = 'Datos del proveedor no coinciden', updated_at = now() WHERE id = $1`, [p.id]);
      return 'mismatch_needs_review';
    }
    if (['pagado', 'reembolso_pendiente', 'parcialmente_reembolsado', 'reembolsado'].includes(p.status)) return 'already_applied';
    if (p.status === 'fallido' && status === 'failed') return 'already_applied';

    if (status === 'failed') {
      if (p.status === 'fallido') return 'already_applied';
      await t.q(`UPDATE payments SET status = 'fallido', failure_reason = $2, updated_at = now() WHERE id = $1`, [p.id, `Rechazado (${info.source})`]);
      if (['pendiente', 'en_conciliacion'].includes(order.payment_status)) {
        await transition(t, order, 'payment', 'fallido', order.payment_status === 'pendiente' ? 'payment_provider' : 'system', { reason: info.source });
        if (order.commercial_status === 'pendiente_confirmacion') {
          await cancelOrderTx(t, order, { to: 'cancelado', actor: 'system', userId: null, reason: 'Pago rechazado' });
        }
      }
      return 'failed_applied';
    }

    // status === 'paid'
    await t.q(`UPDATE payments SET status = 'pagado', paid_at = now(), updated_at = now() WHERE id = $1`, [p.id]);
    await post(t, [{ orderId: order.id, partyType: 'gateway', partyId: null, type: 'customer_payment', amount: p.amount_cents, description: `Cobro ${p.provider}/${p.method}`, reference: p.provider_reference, dedupeKey: `payment:${p.id}:paid` }]);

    if (order.commercial_status === 'pendiente_confirmacion') {
      await transition(t, order, 'payment', 'pagado', order.payment_status === 'pendiente' ? 'payment_provider' : 'system', { reason: info.source });
      // Revalidación de alcohol al pagar.
      if (order.contains_alcohol) {
        const chk = await alcoholSaleCheck({ branchId: order.branch_id, destinationJurisdictionId: order.destination_jurisdiction_id, instants: [new Date()] }, t);
        if (!chk.ok) {
          await cancelOrderTx(t, order, { to: 'cancelado', actor: 'system', userId: null, reason: `Restricción al confirmar pago: ${chk.message}` });
          return 'paid_but_restricted_refund';
        }
      }
      await t.q(`UPDATE inventory_reservations SET expires_at = NULL WHERE order_id = $1 AND status = 'active'`, [order.id]);
      const b = await t.one(`SELECT accept_timeout_seconds FROM branches WHERE id = $1`, [order.branch_id]);
      await transition(t, order, 'commercial', 'confirmado', 'payment_provider', { reason: 'Pago confirmado por el proveedor', extraSet: { confirmed_at: new Date(), accept_deadline: acceptDeadline(order, b.accept_timeout_seconds) } });
      return 'paid_confirmed';
    }

    // Pago tardío: el pedido ya fue cancelado/vencido. Intentar recuperar; si no, devolver.
    if (order.payment_status === 'vencido' || order.payment_status === 'fallido') {
      await transition(t, order, 'payment', 'pagado', 'payment_provider', { reason: `Pago tardío (${info.source})` });
    } else if (order.payment_status === 'pendiente' || order.payment_status === 'en_conciliacion') {
      await transition(t, order, 'payment', 'pagado', order.payment_status === 'pendiente' ? 'payment_provider' : 'system', { reason: info.source });
    }
    await requestRefund(t, order, {
      amountCents: p.amount_cents,
      concept: 'mixed',
      reason: 'Pago recibido después de vencer/cancelar el pedido: devolución automática',
      idempotencyKey: `late:${p.id}`,
      userId: null,
      actor: 'system',
    });
    return 'late_payment_refund';
  });
}

/** Conciliación: consulta al proveedor los pagos inciertos o pendientes antiguos. */
export async function reconcilePending(olderThanSeconds = 60) {
  const rows = await db.q(
    `SELECT * FROM payments WHERE provider NOT IN ('cash','transfer') AND status IN ('en_conciliacion','pendiente') AND provider_reference IS NOT NULL
       AND (last_checked_at IS NULL OR last_checked_at < now() - interval '30 seconds') AND created_at < now() - make_interval(secs => $1) LIMIT 50`,
    [olderThanSeconds],
  );
  const results: { paymentId: string; result: string }[] = [];
  for (const p of rows) {
    await db.q(`UPDATE payments SET last_checked_at = now() WHERE id = $1`, [p.id]);
    try {
      const st = await paymentProvider(p.provider).getStatus(p.provider_reference);
      if (st.status === 'paid' || st.status === 'failed') {
        const r = await applyProviderResult(p.id, st.status, { amountCents: st.amountCents ?? -1, currency: st.currency ?? '', providerReference: p.provider_reference, source: 'conciliación' });
        results.push({ paymentId: p.id, result: r });
      } else if (st.status === 'not_found' && p.status === 'en_conciliacion') {
        // El proveedor confirma que no existe el cargo: es seguro marcar fallido.
        const r = await applyProviderResult(p.id, 'failed', { amountCents: p.amount_cents, currency: 'PEN', providerReference: p.provider_reference, source: 'conciliación: inexistente en proveedor' });
        results.push({ paymentId: p.id, result: r });
      }
    } catch (e) {
      logger.warn('conciliación falló', { paymentId: p.id, err: (e as Error).message });
    }
  }
  return results;
}

/** Ejecuta reembolsos solicitados (fuera de transacción) y registra la confirmación del proveedor. */
export async function executePendingRefunds() {
  const rows = await db.q(
    `SELECT r.*, p.provider, p.provider_reference FROM refunds r LEFT JOIN payments p ON p.id = r.payment_id
     WHERE r.status = 'pending' AND coalesce(p.provider,'') NOT IN ('cash','transfer') AND r.payment_id IS NOT NULL ORDER BY r.created_at LIMIT 20`,
  );
  for (const r of rows) {
    try {
      const res = await paymentProvider(r.provider).refund(r.provider_reference, r.amount_cents, r.idempotency_key);
      if (res.status === 'succeeded') await confirmRefund(r.id, res.providerReference ?? null, null);
      else if (res.status === 'failed') await db.q(`UPDATE refunds SET status = 'failed' WHERE id = $1 AND status = 'pending'`, [r.id]);
    } catch (e) {
      logger.warn('reembolso falló (se reintentará)', { refundId: r.id, err: (e as Error).message });
    }
  }
}

export async function confirmRefund(refundId: string, providerReference: string | null, a: AuthCtx | null) {
  await tx(async (t) => {
    const r = await t.one(`SELECT * FROM refunds WHERE id = $1 FOR UPDATE`, [refundId]);
    if (r.status !== 'pending') return;
    const order = await lockOrder(t, r.order_id);
    await t.q(`UPDATE refunds SET status = 'succeeded', provider_reference = $2, confirmed_at = now() WHERE id = $1`, [r.id, providerReference]);
    const refunded = order.refunded_cents + r.amount_cents;
    const fullPaid = (await t.maybe(`SELECT amount_cents FROM payments WHERE id = $1`, [r.payment_id]))?.amount_cents ?? order.total_cents;
    const pendingOthers = await t.one(`SELECT count(*)::int AS n FROM refunds WHERE order_id = $1 AND status = 'pending'`, [order.id]);
    const to = refunded >= fullPaid ? 'reembolsado' : 'parcialmente_reembolsado';
    await t.q(`UPDATE orders SET refunded_cents = $2 WHERE id = $1`, [order.id, refunded]);
    order.refunded_cents = refunded;
    if (order.payment_status === 'reembolso_pendiente' && pendingOthers.n === 0) {
      await transition(t, order, 'payment', to, a ? 'finance' : 'payment_provider', { reason: `Reembolso confirmado ${providerReference ?? ''}`.trim() });
    }
    if (r.payment_id) await t.q(`UPDATE payments SET status = $2, updated_at = now() WHERE id = $1`, [r.payment_id, pendingOthers.n === 0 ? to : 'reembolso_pendiente']);
    await post(t, [{ orderId: order.id, partyType: 'gateway', partyId: null, type: 'customer_refund', amount: -r.amount_cents, description: `Reembolso (${r.concept}): ${r.reason}`, reference: providerReference, dedupeKey: `refund:${r.id}` }]);
    // Si el pedido ya estaba liquidado (completado), el ajuste se carga a quien corresponde según concepto.
    if (order.commercial_status === 'completado' && (r.concept === 'products' || r.concept === 'mixed')) {
      await post(t, [{ orderId: order.id, partyType: 'merchant', partyId: order.merchant_id, type: 'merchant_refund_adjustment', amount: -Math.min(r.amount_cents, order.subtotal_cents), description: 'Ajuste por reembolso de productos', dedupeKey: `refund:${r.id}:merchant` }]);
    }
    await emit(t, 'refund.confirmed', order.id, { orderId: order.id, refundId: r.id });
    if (a) await audit(t, a, 'refund.confirmed_manual', 'refund', r.id, 'Confirmación manual', {});
  });
}

/** Transferencia manual: solo personal financiero, tras conciliar el abono real en el banco. */
export async function confirmManualPayment(a: AuthCtx, paymentId: string, input: { bankReference: string; amountCents: number; reason: string }) {
  const p = await db.maybe(`SELECT * FROM payments WHERE id = $1 AND provider = 'transfer'`, [paymentId]);
  if (!p) throw new BizError('NOT_FOUND', 'Pago no encontrado', 404);
  if (input.amountCents !== p.amount_cents) throw new BizError('AMOUNT_MISMATCH', 'El abono no coincide con el importe del pedido', 422);
  await db.q(`UPDATE payments SET provider_reference = $2 WHERE id = $1`, [p.id, input.bankReference]);
  await tx(async (t) => audit(t, a, 'payment.manual_confirmed', 'payment', p.id, input.reason, { bankReference: input.bankReference }));
  return applyProviderResult(p.id, 'paid', { amountCents: input.amountCents, currency: 'PEN', providerReference: input.bankReference, source: 'conciliación manual' });
}

/** SOLO DESARROLLO: emula el resultado en el proveedor sandbox y entrega el webhook firmado. */
export async function simulate(a: AuthCtx, paymentId: string, outcome: 'paid' | 'failed' | 'uncertain' | 'paid_late') {
  if (!config().isDevLike) throw new BizError('NOT_FOUND', 'No disponible', 404);
  const p = await db.maybe(`SELECT p.* FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.id = $1 AND (o.user_id = $2 OR $3)`, [paymentId, a.userId, a.roles.has('admin')]);
  if (!p || p.provider !== 'sandbox') throw new BizError('NOT_FOUND', 'Pago sandbox no encontrado', 404);
  if (outcome === 'uncertain') {
    await db.q(`UPDATE payments SET status = 'en_conciliacion' WHERE id = $1 AND status = 'pendiente'`, [p.id]);
    await markOrderPayment(p.order_id, 'en_conciliacion', 'Simulación: respuesta incierta');
    return { simulated: true, outcome };
  }
  const { body, signature } = await SandboxProvider.settle(p.provider_reference, outcome === 'failed' ? 'failed' : 'paid');
  const r = await handleWebhook('sandbox', { 'x-sandbox-signature': signature }, body);
  return { simulated: true, outcome, webhook: r };
}

export { requestRefund };
