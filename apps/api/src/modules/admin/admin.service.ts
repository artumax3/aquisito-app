import { isAdultOn, localDate } from '@aquisito/contracts';
import { db, tx } from '../../db/db';
import { AuthCtx, assertCityScope, opsCityScope } from '../../common/auth';
import { BizError } from '../../common/errors';
import { audit, emit } from '../../common/audit';
import { lockOrder } from '../orders/state';
import { orderDto } from '../orders/orders.service';
import { cancelOrderTx } from '../orders/lifecycle';
import { requestRefund } from '../payments/refunds';
import { recomputeSettlement } from '../finance/ledger.service';
import { anonymizeUser } from '../identity/identity.service';
import { LIMA } from '../../common/time';
import { validAlcoholPermitDocument } from '../documents/documents.service';

const scopeParam = (a: AuthCtx) => opsCityScope(a);

/**
 * Indicadores (definiciones en docs/indicadores.md):
 *  - pedidos: pedidos creados en el período (excluye pendientes sin pago vencidos? no: se informan aparte)
 *  - valor bruto vendido (GMV): suma de subtotal de productos de pedidos COMPLETADOS. No es ingreso.
 *  - comisión de plataforma: suma de asientos platform_commission (ingreso propio).
 *  - ticket promedio: total cobrado / pedidos completados.
 *  - tiempos: medianas en minutos (confirmación→aceptación, aceptación→listo, recojo→entrega).
 *  - recompra: clientes con 2+ pedidos completados / clientes con 1+ completado.
 */
export async function dashboard(a: AuthCtx, q: { cityId?: string; from?: string; to?: string }) {
  const scope = scopeParam(a);
  if (q.cityId) assertCityScope(a, q.cityId);
  const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86400000);
  const to = q.to ? new Date(q.to) : new Date();
  const rows = await db.q(
    `SELECT c.id AS city_id, c.name AS city,
       count(o.*)::int AS orders,
       count(o.*) FILTER (WHERE o.commercial_status = 'completado')::int AS completed,
       count(o.*) FILTER (WHERE o.commercial_status IN ('cancelado','rechazado_comercio'))::int AS cancelled,
       coalesce(sum(o.subtotal_cents) FILTER (WHERE o.commercial_status = 'completado'),0)::bigint AS gmv,
       coalesce(sum(o.total_cents) FILTER (WHERE o.commercial_status = 'completado'),0)::bigint AS collected,
       coalesce(sum(o.refunded_cents),0)::bigint AS refunded,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM o.accepted_at - o.confirmed_at)/60) FILTER (WHERE o.accepted_at IS NOT NULL) AS accept_min,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM o.ready_at - o.accepted_at)/60) FILTER (WHERE o.ready_at IS NOT NULL) AS prep_min,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM o.delivered_at - o.picked_up_at)/60) FILTER (WHERE o.delivered_at IS NOT NULL) AS delivery_min
     FROM cities c LEFT JOIN orders o ON o.city_id = c.id AND o.created_at >= $1 AND o.created_at < $2
     WHERE ($3::uuid IS NULL OR c.id = $3) AND ($4::uuid[] IS NULL OR c.id = ANY($4))
     GROUP BY c.id ORDER BY c.name`,
    [from, to, q.cityId ?? null, scope],
  );
  const commission = await db.q(
    `SELECT o.city_id, coalesce(sum(l.amount_cents),0)::bigint AS s FROM ledger_entries l JOIN orders o ON o.id = l.order_id
     WHERE l.entry_type = 'platform_commission' AND l.created_at >= $1 AND l.created_at < $2 GROUP BY o.city_id`,
    [from, to],
  );
  const repurchase = await db.q(
    `SELECT city_id, count(*) FILTER (WHERE n >= 2)::int AS repeat, count(*)::int AS buyers FROM (
       SELECT city_id, user_id, count(*) AS n FROM orders WHERE commercial_status = 'completado' AND created_at >= $1 AND created_at < $2 GROUP BY city_id, user_id) x GROUP BY city_id`,
    [from, to],
  );
  const ops = await db.one(
    `SELECT (SELECT count(*) FROM outbox_events WHERE processed_at IS NULL AND dead_at IS NULL)::int AS outbox_pending,
            (SELECT count(*) FROM outbox_events WHERE dead_at IS NOT NULL)::int AS outbox_dead,
            (SELECT count(*) FROM payments WHERE status = 'en_conciliacion')::int AS payments_uncertain,
            (SELECT count(*) FROM refunds WHERE status = 'pending')::int AS refunds_pending,
            (SELECT count(*) FROM orders WHERE commercial_status IN ('confirmado','aceptado_comercio','en_preparacion','listo_para_recojo') AND created_at < now() - interval '2 hours')::int AS stuck_orders,
            (SELECT count(*) FROM incidents WHERE status = 'open')::int AS open_incidents,
            (SELECT count(*) FROM complaints WHERE response IS NULL AND due_date <= (now() AT TIME ZONE 'America/Lima')::date + 3)::int AS complaints_due_soon`,
  );
  return {
    period: { from: from.toISOString(), to: to.toISOString(), timezone: LIMA },
    definitions: 'docs/indicadores.md',
    cities: rows.map((r) => {
      const rp = repurchase.find((x) => x.city_id === r.city_id);
      return {
        cityId: r.city_id,
        city: r.city,
        orders: r.orders,
        completed: r.completed,
        cancelled: r.cancelled,
        cancellationRate: r.orders ? r.cancelled / r.orders : 0,
        gmvCents: Number(r.gmv),
        platformCommissionCents: Number(commission.find((c) => c.city_id === r.city_id)?.s ?? 0),
        avgTicketCents: r.completed ? Math.round(Number(r.collected) / r.completed) : 0,
        refundedCents: Number(r.refunded),
        medianAcceptMinutes: r.accept_min != null ? Number(Number(r.accept_min).toFixed(1)) : null,
        medianPrepMinutes: r.prep_min != null ? Number(Number(r.prep_min).toFixed(1)) : null,
        medianDeliveryMinutes: r.delivery_min != null ? Number(Number(r.delivery_min).toFixed(1)) : null,
        repurchaseRate: rp?.buyers ? rp.repeat / rp.buyers : 0,
      };
    }),
    operations: ops,
  };
}

export async function listOrders(a: AuthCtx, q: Record<string, string | undefined>) {
  const scope = scopeParam(a);
  const rows = await db.q(
    `SELECT o.* FROM orders o
     WHERE ($1::uuid[] IS NULL OR o.city_id = ANY($1)) AND ($2::uuid IS NULL OR o.city_id = $2) AND ($3::uuid IS NULL OR o.branch_id = $3)
       AND ($4::text IS NULL OR o.commercial_status = $4) AND ($5::text IS NULL OR o.payment_status = $5)
       AND ($6::text IS NULL OR o.delivery_status = $6)
       AND ($7::uuid IS NULL OR EXISTS (SELECT 1 FROM deliveries d WHERE d.order_id = o.id AND d.courier_id = $7))
       AND ($8 = false OR EXISTS (SELECT 1 FROM incidents i WHERE i.order_id = o.id AND i.status = 'open'))
       AND ($9 = false OR o.commercial_status NOT IN ('completado','cancelado','rechazado_comercio') OR o.delivery_status = 'retorno_pendiente')
     ORDER BY o.created_at DESC LIMIT 200`,
    [scope, q.cityId ?? null, q.branchId ?? null, q.status ?? null, q.payment ?? null, q.delivery ?? null, q.courierId ?? null, q.incidents === 'true', q.active === 'true'],
  );
  return Promise.all(rows.map((o) => orderDto(o, 'ops')));
}

export async function orderDetail(a: AuthCtx, id: string) {
  const o = await db.maybe(`SELECT * FROM orders WHERE id = $1`, [id]);
  if (!o) throw new BizError('NOT_FOUND', 'Pedido no encontrado', 404);
  assertCityScope(a, o.city_id);
  const dto = await orderDto(o, 'ops');
  const payments = await db.q(`SELECT id, provider, method, amount_cents, status, provider_reference, created_at FROM payments WHERE order_id = $1 ORDER BY created_at`, [id]);
  const refunds = await db.q(`SELECT id, amount_cents, concept, reason, status, created_at FROM refunds WHERE order_id = $1 ORDER BY created_at`, [id]);
  const deliveries = await db.q(`SELECT d.*, u.full_name FROM deliveries d JOIN users u ON u.id = d.courier_id WHERE d.order_id = $1 ORDER BY assigned_at`, [id]);
  const offers = await db.q(`SELECT id, courier_id, status, expires_at, created_at FROM delivery_offers WHERE order_id = $1 ORDER BY created_at`, [id]);
  const incidents = await db.q(`SELECT * FROM incidents WHERE order_id = $1 ORDER BY created_at`, [id]);
  const ageChecks = await db.q(`SELECT result, document_type, rejection_reason, checked_at, courier_id FROM door_age_checks WHERE order_id = $1`, [id]);
  const ledger = await db.q(`SELECT party_type, entry_type, amount_cents, description, created_at FROM ledger_entries WHERE order_id = $1 ORDER BY id`, [id]);
  const inventory = await db.q(`SELECT m.kind, m.quantity, s.name, m.created_at FROM inventory_movements m JOIN skus s ON s.id = m.sku_id WHERE m.order_id = $1 ORDER BY m.id`, [id]);
  return { order: dto, payments, refunds, deliveries: deliveries.map((d) => ({ ...d, full_name: d.full_name })), offers, incidents, ageChecks, ledger, inventory };
}

export async function cancelOrder(a: AuthCtx, id: string, reason: string) {
  await tx(async (t) => {
    const o = await lockOrder(t, id);
    assertCityScope(a, o.city_id);
    await cancelOrderTx(t, o, { to: 'cancelado', actor: o.commercial_status === 'pendiente_confirmacion' ? 'system' : 'support', userId: a.userId, reason, refundActor: 'support' });
    await audit(t, a, 'order.cancelled_by_ops', 'order', id, reason);
  });
  return orderDetail(a, id);
}

export async function couriers(a: AuthCtx) {
  const scope = scopeParam(a);
  return db.q(
    `SELECT c.user_id AS id, u.full_name, c.city_id, c.vehicle_type, c.status, c.available, c.identity_review, c.alcohol_training_at, c.birth_date, c.created_at,
       l.recorded_at AS last_location_at,
       EXISTS (SELECT 1 FROM deliveries d WHERE d.courier_id = c.user_id AND d.status = 'active') AS busy
     FROM couriers c JOIN users u ON u.id = c.user_id LEFT JOIN courier_locations l ON l.courier_id = c.user_id
     WHERE ($1::uuid[] IS NULL OR c.city_id = ANY($1)) ORDER BY c.status, u.full_name`,
    [scope],
  );
}

export async function reviewCourier(a: AuthCtx, id: string, input: { approve: boolean; reason: string }) {
  return tx(async (t) => {
    const c = await t.maybe(`SELECT * FROM couriers WHERE user_id = $1 FOR UPDATE`, [id]);
    if (!c) throw new BizError('NOT_FOUND', 'Repartidor no encontrado', 404);
    assertCityScope(a, c.city_id, ['admin', 'city_dispatcher']);
    if (input.approve && !isAdultOn(c.birth_date, localDate(new Date(), LIMA), 18)) throw new BizError('UNDERAGE', 'El repartidor debe tener 18 años cumplidos', 422);
    await t.q(
      `UPDATE couriers SET status = $2, identity_review = $3, review_reason = $4, reviewed_by = $5, reviewed_at = now() WHERE user_id = $1`,
      [id, input.approve ? 'approved' : 'rejected', input.approve ? 'manual_reviewed' : 'rejected', input.reason, a.userId],
    );
    await audit(t, a, input.approve ? 'courier.approved' : 'courier.rejected', 'courier', id, input.reason, { note: 'Revisión manual de documentos; no constituye validación oficial' });
    await emit(t, 'courier.reviewed', null, { userId: id, approved: input.approve });
    return { status: input.approve ? 'approved' : 'rejected' };
  });
}

export async function recordTraining(a: AuthCtx, courierId: string, topics: string[]) {
  return tx(async (t) => {
    for (const topic of topics) await t.q(`INSERT INTO courier_trainings(courier_id, topic, recorded_by) VALUES ($1,$2,$3)`, [courierId, topic, a.userId]);
    const all = await t.one(`SELECT count(DISTINCT topic)::int AS n FROM courier_trainings WHERE courier_id = $1`, [courierId]);
    if (all.n >= 5) await t.q(`UPDATE couriers SET alcohol_training_at = coalesce(alcohol_training_at, now()) WHERE user_id = $1`, [courierId]);
    await audit(t, a, 'courier.training_recorded', 'courier', courierId, null, { topics });
    return { topicsCompleted: all.n, alcoholEnabled: all.n >= 5 };
  });
}

export async function merchants(a: AuthCtx) {
  const scope = scopeParam(a);
  return db.q(
    `SELECT m.id, m.trade_name, m.legal_name, m.ruc, m.status, m.created_at, json_agg(json_build_object('id', b.id, 'name', b.name, 'cityId', b.city_id, 'status', b.status, 'sellsAlcohol', b.sells_alcohol, 'alcoholPermit', b.alcohol_permit_status)) AS branches
     FROM merchants m JOIN branches b ON b.merchant_id = m.id WHERE ($1::uuid[] IS NULL OR b.city_id = ANY($1)) GROUP BY m.id ORDER BY m.status, m.trade_name`,
    [scope],
  );
}

export async function reviewMerchant(a: AuthCtx, id: string, input: { approve: boolean; reason: string }) {
  return tx(async (t) => {
    const m = await t.maybe(`SELECT * FROM merchants WHERE id = $1 FOR UPDATE`, [id]);
    if (!m) throw new BizError('NOT_FOUND', 'Comercio no encontrado', 404);
    await t.q(`UPDATE merchants SET status = $2, review_reason = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1`, [id, input.approve ? 'approved' : 'rejected', input.reason, a.userId]);
    if (input.approve) await t.q(`UPDATE branches SET status = 'active' WHERE merchant_id = $1 AND status = 'pending' AND jurisdiction_id IS NOT NULL`, [id]);
    await audit(t, a, input.approve ? 'merchant.approved' : 'merchant.rejected', 'merchant', id, input.reason);
    return { status: input.approve ? 'approved' : 'rejected' };
  });
}

export async function reviewAlcoholPermit(a: AuthCtx, branchId: string, input: { approve: boolean; reason: string }) {
  return tx(async (t) => {
    const b = await t.maybe(`SELECT id FROM branches WHERE id = $1`, [branchId]);
    if (!b) throw new BizError('NOT_FOUND', 'Sucursal no encontrada', 404);
    let expires: string | null = null;
    if (input.approve) {
      // Requisito: documento de autorización aprobado y vigente; el permiso vence con el documento.
      const doc = await validAlcoholPermitDocument(t, branchId);
      if (!doc) throw new BizError('PERMIT_DOCUMENT_REQUIRED', 'Falta un documento de autorización para alcohol aprobado y vigente', 422);
      expires = doc.expires_at;
    }
    await t.q(`UPDATE branches SET sells_alcohol = $2, alcohol_permit_status = $3, alcohol_permit_expires_at = $4 WHERE id = $1`, [branchId, input.approve, input.approve ? 'approved' : 'suspended', expires]);
    await audit(t, a, 'branch.alcohol_permit_reviewed', 'branch', branchId, input.reason, { approve: input.approve });
    return { approved: input.approve };
  });
}

// ---------- Verificación de edad: revisión humana documentada ----------
export async function ageQueue(a: AuthCtx) {
  void a;
  const rows = await db.q(
    `SELECT v.id, v.user_id, u.full_name AS account_name, v.full_name_on_document, v.document_type, v.document_last4, v.birth_date, v.created_at, v.policy_version
     FROM age_verifications v JOIN users u ON u.id = v.user_id WHERE v.status = 'pending' ORDER BY v.created_at`,
  );
  return rows;
}

export async function ageDecide(a: AuthCtx, id: string, input: { decision: 'verified' | 'rejected' | 'revoked'; reason: string; method: string }) {
  return tx(async (t) => {
    const v = await t.maybe(`SELECT * FROM age_verifications WHERE id = $1 FOR UPDATE`, [id]);
    if (!v) throw new BizError('NOT_FOUND', 'Solicitud no encontrada', 404);
    if (input.decision === 'revoked') {
      if (v.status !== 'verified') throw new BizError('INVALID_STATE', 'Solo se revoca una verificación aprobada', 409);
    } else if (v.status !== 'pending') throw new BizError('INVALID_STATE', 'La solicitud ya fue decidida', 409);
    if (input.decision === 'verified' && !isAdultOn(v.birth_date, localDate(new Date(), LIMA), 18)) throw new BizError('UNDERAGE', 'La persona no tiene 18 años cumplidos', 422);
    if (v.reviewer_id === a.userId || v.user_id === a.userId) throw new BizError('SELF_REVIEW', 'No puedes revisar tu propia verificación', 403);
    await t.q(`UPDATE age_verifications SET status = $2, method = $3, decision_reason = $4, reviewer_id = $5, decided_at = now() WHERE id = $1`, [id, input.decision, input.method, input.reason, a.userId]);
    await audit(t, a, `age_verification.${input.decision}`, 'age_verification', id, input.reason, { method: input.method });
    await emit(t, 'age_verification.decided', null, { userId: v.user_id, status: input.decision });
    return { status: input.decision };
  });
}

// ---------- Ciudades, zonas, tarifas ----------
export async function patchCity(a: AuthCtx, id: string, input: { status?: string; alcoholEnabled?: boolean; reason: string }) {
  return tx(async (t) => {
    await t.q(
      `UPDATE cities SET status = coalesce($2, status), pause_reason = CASE WHEN $2 = 'paused' THEN $4 WHEN $2 = 'active' THEN NULL ELSE pause_reason END, alcohol_enabled = coalesce($3, alcohol_enabled) WHERE id = $1`,
      [id, input.status ?? null, input.alcoholEnabled ?? null, input.reason],
    );
    await audit(t, a, 'city.updated', 'city', id, input.reason, input as any);
    return t.one(`SELECT id, name, status, pause_reason, alcohol_enabled FROM cities WHERE id = $1`, [id]);
  });
}

export async function newZoneVersion(a: AuthCtx, zoneId: string, input: { geometry: any; reason: string }) {
  return tx(async (t) => {
    const z = await t.maybe(`SELECT * FROM zones WHERE id = $1 FOR UPDATE`, [zoneId]);
    if (!z) throw new BizError('NOT_FOUND', 'Zona no encontrada', 404);
    const valid = await t.one(`SELECT ST_IsValid(ST_SetSRID(ST_GeomFromGeoJSON($1),4326)) AS ok`, [JSON.stringify(input.geometry)]);
    if (!valid.ok) throw new BizError('INVALID_GEOMETRY', 'El polígono no es válido', 422);
    const last = await t.one(`SELECT coalesce(max(version),0) AS v FROM zone_versions WHERE zone_id = $1`, [zoneId]);
    await t.q(`UPDATE zone_versions SET is_current = false WHERE zone_id = $1 AND is_current`, [zoneId]);
    const r = await t.one(
      `INSERT INTO zone_versions(zone_id, version, geom, reason, created_by) VALUES ($1,$2, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($3),4326)), $4, $5) RETURNING id, version`,
      [zoneId, last.v + 1, JSON.stringify(input.geometry), input.reason, a.userId],
    );
    await audit(t, a, 'zone.version_created', 'zone', zoneId, input.reason, { version: r.version });
    return r;
  });
}

export async function suspendZone(a: AuthCtx, zoneId: string, input: { reason: string; detail?: string; startsAt: string; endsAt: string }) {
  return tx(async (t) => {
    const z = await t.maybe(`SELECT city_id FROM zones WHERE id = $1`, [zoneId]);
    if (!z) throw new BizError('NOT_FOUND', 'Zona no encontrada', 404);
    assertCityScope(a, z.city_id, ['admin', 'city_dispatcher']);
    const r = await t.one(`INSERT INTO zone_suspensions(zone_id, reason, detail, starts_at, ends_at, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [zoneId, input.reason, input.detail ?? null, input.startsAt, input.endsAt, a.userId]);
    await audit(t, a, 'zone.suspended', 'zone', zoneId, input.reason, input as any);
    return { suspensionId: r.id };
  });
}

export async function createFeeRule(a: AuthCtx, input: any) {
  return tx(async (t) => {
    const r = await t.one(
      `INSERT INTO delivery_fee_rules(city_id, zone_id, branch_id, base_fee_cents, included_meters, per_km_cents, min_order_cents, surcharge_cents, surcharge_label, max_distance_meters)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [input.cityId, input.zoneId ?? null, input.branchId ?? null, input.baseFeeCents, input.includedMeters, input.perKmCents, input.minOrderCents, input.surchargeCents, input.surchargeLabel ?? null, input.maxDistanceMeters],
    );
    await audit(t, a, 'fee_rule.created', 'fee_rule', r.id, input.reason, input);
    return r;
  });
}

export const feeRules = () => db.q(`SELECT * FROM delivery_fee_rules WHERE active ORDER BY city_id, created_at DESC`);

export const alcoholRules = () =>
  db.q(`SELECT r.*, j.name AS jurisdiction FROM alcohol_rules r JOIN jurisdictions j ON j.id = r.jurisdiction_id WHERE r.active ORDER BY j.name, weekday`);

export async function createAlcoholRule(a: AuthCtx, input: any) {
  return tx(async (t) => {
    const r = await t.one(
      `INSERT INTO alcohol_rules(jurisdiction_id, weekday, start_time, end_time, source, source_reviewed_at, responsible, validated, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [input.jurisdictionId, input.weekday, input.start, input.end, input.source, input.sourceReviewedAt, input.responsible, input.validated, a.userId],
    );
    await audit(t, a, 'alcohol_rule.created', 'alcohol_rule', r.id, input.source, input);
    return r;
  });
}

export async function createBlackout(a: AuthCtx, input: any) {
  return tx(async (t) => {
    const r = await t.one(`INSERT INTO alcohol_blackouts(jurisdiction_id, starts_at, ends_at, reason, source, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [input.jurisdictionId, input.startsAt, input.endsAt, input.reason, input.source, a.userId]);
    await audit(t, a, 'alcohol_blackout.created', 'alcohol_blackout', r.id, input.reason, input);
    return r;
  });
}

export const coupons = () => db.q(`SELECT * FROM coupons ORDER BY created_at DESC`);

export async function createCoupon(a: AuthCtx, input: any) {
  return tx(async (t) => {
    const r = await t.one(
      `INSERT INTO coupons(code, city_id, merchant_id, category_kind, starts_at, ends_at, min_subtotal_cents, discount_type, value, max_discount_cents, budget_cents, max_uses, per_user_limit, funded_by, stackable, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [input.code, input.cityId ?? null, input.merchantId ?? null, input.categoryKind ?? null, input.startsAt, input.endsAt, input.minSubtotalCents, input.discountType, input.value, input.maxDiscountCents ?? null, input.budgetCents, input.maxUses, input.perUserLimit, input.fundedBy, input.stackable, a.userId],
    );
    await audit(t, a, 'coupon.created', 'coupon', r.id, null, input);
    return r;
  });
}

export async function setCommission(a: AuthCtx, input: { merchantId: string; percentBp: number; validFrom: string; reason: string }) {
  return tx(async (t) => {
    await t.q(`UPDATE commission_rules SET valid_to = $2 WHERE merchant_id = $1 AND valid_to IS NULL AND valid_from < $2`, [input.merchantId, input.validFrom]);
    const r = await t.one(`INSERT INTO commission_rules(merchant_id, percent_bp, valid_from, created_by) VALUES ($1,$2,$3,$4) RETURNING id`, [input.merchantId, input.percentBp, input.validFrom, a.userId]);
    await audit(t, a, 'commission.set', 'merchant', input.merchantId, input.reason, input);
    return r;
  });
}

export async function refund(a: AuthCtx, paymentId: string, input: { amountCents: number; reason: string; concept: string }, key?: string) {
  if (!key) throw new BizError('IDEMPOTENCY_KEY_REQUIRED', 'Falta el encabezado Idempotency-Key', 400);
  return tx(async (t) => {
    const p = await t.maybe(`SELECT order_id FROM payments WHERE id = $1`, [paymentId]);
    if (!p) throw new BizError('NOT_FOUND', 'Pago no encontrado', 404);
    const o = await lockOrder(t, p.order_id);
    assertCityScope(a, o.city_id);
    const r = await requestRefund(t, o, { amountCents: input.amountCents, concept: input.concept, reason: input.reason, idempotencyKey: `admin:${key}`, userId: a.userId, actor: a.roles.has('finance') ? 'finance' : 'support' });
    await audit(t, a, 'refund.requested', 'order', o.id, input.reason, { amount: input.amountCents });
    return { refundId: r.id, status: r.status };
  });
}

// ---------- Liquidaciones ----------
export async function createSettlement(a: AuthCtx, input: { partyType: 'merchant' | 'courier'; partyId: string; periodStart: string; periodEnd: string }) {
  return tx(async (t) => {
    await t.q(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`settle:${input.partyType}:${input.partyId}`]);
    const existing = await t.maybe(`SELECT id FROM settlements WHERE party_type = $1 AND party_id = $2 AND period_start = $3 AND period_end = $4 AND status <> 'void'`, [input.partyType, input.partyId, input.periodStart, input.periodEnd]);
    if (existing) return settlementDetail(a, existing.id, t);
    // Movimientos del período aún no incluidos en ninguna liquidación vigente.
    const entries = await t.q(
      `SELECT l.id, l.amount_cents FROM ledger_entries l WHERE l.party_type = $1 AND l.party_id = $2 AND l.created_at >= $3 AND l.created_at < $4
         AND NOT EXISTS (SELECT 1 FROM settlement_items si JOIN settlements s ON s.id = si.settlement_id WHERE si.ledger_entry_id = l.id AND s.status <> 'void') ORDER BY l.id`,
      [input.partyType, input.partyId, input.periodStart, input.periodEnd],
    );
    const total = entries.reduce((s, e) => s + Number(e.amount_cents), 0);
    const s = await t.one(
      `INSERT INTO settlements(party_type, party_id, period_start, period_end, total_cents, entries_count, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [input.partyType, input.partyId, input.periodStart, input.periodEnd, total, entries.length, a.userId],
    );
    for (const e of entries) await t.q(`INSERT INTO settlement_items(settlement_id, ledger_entry_id) VALUES ($1,$2)`, [s.id, e.id]);
    await audit(t, a, 'settlement.created', 'settlement', s.id, null, { total, entries: entries.length });
    return settlementDetail(a, s.id, t);
  });
}

export async function settlementDetail(a: AuthCtx, id: string, t: any = db) {
  void a;
  const s = await t.maybe(`SELECT * FROM settlements WHERE id = $1`, [id]);
  if (!s) throw new BizError('NOT_FOUND', 'Liquidación no encontrada', 404);
  const items = await t.q(
    `SELECT l.id, l.order_id, l.entry_type, l.amount_cents, l.description, l.created_at FROM settlement_items si JOIN ledger_entries l ON l.id = si.ledger_entry_id WHERE si.settlement_id = $1 ORDER BY l.id`,
    [id],
  );
  const re = await recomputeSettlement(t, id);
  return { ...s, items, recomputedTotalCents: re.totalCents, consistent: re.totalCents === Number(s.total_cents) && re.entries === s.entries_count, executionNote: 'La ejecución del pago al tercero es externa y requiere autorización; aquí solo se registra la orden de liquidación.' };
}

export const settlements = () => db.q(`SELECT * FROM settlements ORDER BY created_at DESC LIMIT 100`);
export const ledger = (q: Record<string, string | undefined>) =>
  db.q(`SELECT * FROM ledger_entries WHERE ($1::text IS NULL OR party_type = $1) AND ($2::uuid IS NULL OR party_id = $2) ORDER BY id DESC LIMIT 500`, [q.partyType ?? null, q.partyId ?? null]);

// ---------- Soporte ----------
export async function incidents(a: AuthCtx) {
  const scope = scopeParam(a);
  return db.q(
    `SELECT i.*, o.number, o.city_id FROM incidents i JOIN orders o ON o.id = i.order_id WHERE ($1::uuid[] IS NULL OR o.city_id = ANY($1)) ORDER BY i.status, i.created_at DESC LIMIT 200`,
    [scope],
  );
}

export async function resolveIncident(a: AuthCtx, id: string, input: { resolution: string; refundCents: number; refundConcept: string }) {
  return tx(async (t) => {
    const i = await t.maybe(`SELECT * FROM incidents WHERE id = $1 FOR UPDATE`, [id]);
    if (!i) throw new BizError('NOT_FOUND', 'Incidencia no encontrada', 404);
    if (i.status === 'resolved') throw new BizError('ALREADY_RESOLVED', 'Incidencia ya resuelta', 409);
    const o = await lockOrder(t, i.order_id);
    assertCityScope(a, o.city_id);
    let refundId: string | null = null;
    if (input.refundCents > 0) {
      const r = await requestRefund(t, o, { amountCents: input.refundCents, concept: input.refundConcept, reason: `Incidencia: ${input.resolution}`, idempotencyKey: `incident:${id}`, userId: a.userId, actor: 'support' });
      refundId = r.id;
    }
    await t.q(`UPDATE incidents SET status = 'resolved', resolution = $2, resolved_by = $3, resolved_at = now() WHERE id = $1`, [id, input.resolution, a.userId]);
    await audit(t, a, 'incident.resolved', 'incident', id, input.resolution, { refundCents: input.refundCents, concept: input.refundConcept });
    await emit(t, 'incident.resolved', o.id, { orderId: o.id });
    return { resolved: true, refundId };
  });
}

export async function confirmManualRefund(a: AuthCtx, refundId: string, reference: string) {
  const { confirmRefund } = await import('../payments/payments.service');
  const r = await db.maybe(`SELECT r.*, p.provider FROM refunds r LEFT JOIN payments p ON p.id = r.payment_id WHERE r.id = $1 AND r.status = 'pending'`, [refundId]);
  if (!r) throw new BizError('NOT_FOUND', 'Reembolso pendiente no encontrado', 404);
  // Los reembolsos de pasarela se confirman SOLO con la respuesta del proveedor.
  if (r.provider && !['cash', 'transfer'].includes(r.provider)) throw new BizError('PROVIDER_REFUND', 'Este reembolso lo confirma el proveedor de pagos, no una acción manual', 409);
  await confirmRefund(refundId, reference, a);
  return { confirmed: true };
}

export const auditLog = () => db.q(`SELECT * FROM audit_log ORDER BY id DESC LIMIT 300`);
export const outbox = () => db.q(`SELECT id, topic, aggregate_id, attempts, created_at, processed_at, dead_at, last_error FROM outbox_events ORDER BY id DESC LIMIT 200`);

export async function grantRole(a: AuthCtx, input: { userId: string; role: string; cityId?: string; merchantId?: string; branchId?: string; reason: string }) {
  return tx(async (t) => {
    const r = await t.one(
      `INSERT INTO memberships(user_id, role, city_id, merchant_id, branch_id, granted_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [input.userId, input.role, input.cityId ?? null, input.merchantId ?? null, input.branchId ?? null, a.userId],
    );
    await audit(t, a, 'membership.granted', 'user', input.userId, input.reason, input);
    return r;
  });
}

export const dataRequests = () => db.q(`SELECT d.*, u.full_name FROM data_requests d JOIN users u ON u.id = d.user_id ORDER BY d.status, d.due_at`);

export async function processDataRequest(a: AuthCtx, id: string, reason: string) {
  return tx(async (t) => {
    const d = await t.maybe(`SELECT * FROM data_requests WHERE id = $1 FOR UPDATE`, [id]);
    if (!d) throw new BizError('NOT_FOUND', 'Solicitud no encontrada', 404);
    if (d.status === 'completed') throw new BizError('ALREADY_DONE', 'Solicitud ya atendida', 409);
    let resolution = reason;
    if (d.kind === 'account_deletion' || d.kind === 'cancellation') {
      const active = await t.maybe(`SELECT 1 FROM orders WHERE user_id = $1 AND commercial_status NOT IN ('completado','cancelado','rechazado_comercio') LIMIT 1`, [d.user_id]);
      if (active) throw new BizError('ACTIVE_ORDERS', 'El usuario tiene pedidos en curso; procesar al finalizar', 409);
      await anonymizeUser(t, d.user_id);
      resolution = `${reason}. Datos personales anonimizados; se conservan pedidos, movimientos y reclamaciones por obligaciones de conservación (plazo a validar).`;
    }
    if (d.kind === 'access') {
      const summary = await t.one(
        `SELECT (SELECT row_to_json(u) FROM (SELECT full_name, email, phone, declared_birth_date, created_at FROM users WHERE id = $1) u) AS profile,
                (SELECT count(*) FROM orders WHERE user_id = $1)::int AS orders, (SELECT count(*) FROM addresses WHERE user_id = $1 AND deleted_at IS NULL)::int AS addresses,
                (SELECT json_agg(c) FROM (SELECT purpose, granted, policy_version, created_at FROM consents WHERE user_id = $1) c) AS consents`,
        [d.user_id],
      );
      resolution = `${reason}. Resumen entregado: ${JSON.stringify(summary)}`;
    }
    await t.q(`UPDATE data_requests SET status = 'completed', resolution = $2, resolved_by = $3, resolved_at = now() WHERE id = $1`, [id, resolution, a.userId]);
    await audit(t, a, 'data_request.processed', 'data_request', id, reason, { kind: d.kind });
    return { completed: true, kind: d.kind };
  });
}

export async function exportOrdersCsv(a: AuthCtx, q: { cityId?: string; from?: string; to?: string }) {
  const scope = scopeParam(a);
  const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86400000);
  const to = q.to ? new Date(q.to) : new Date();
  const rows = await db.q(
    `SELECT o.number, o.created_at, c.name AS city, b.name AS branch, o.commercial_status, o.delivery_status, o.payment_status, o.payment_method, o.subtotal_cents, o.discount_cents, o.delivery_fee_cents, o.total_cents, o.refunded_cents
     FROM orders o JOIN cities c ON c.id = o.city_id JOIN branches b ON b.id = o.branch_id
     WHERE ($1::uuid[] IS NULL OR o.city_id = ANY($1)) AND ($2::uuid IS NULL OR o.city_id = $2) AND o.created_at >= $3 AND o.created_at < $4 ORDER BY o.created_at`,
    [scope, q.cityId ?? null, from, to],
  );
  await tx((t) => audit(t, a, 'export.orders', 'orders', null, null, { ...q }));
  const head = `# Exportación Aquisito · ${new Date().toISOString()} · zona horaria ${LIMA} · ciudad=${q.cityId ?? 'todas'} desde=${from.toISOString()} hasta=${to.toISOString()} · sin datos personales\n`;
  const cols = 'pedido,fecha_local,ciudad,sucursal,estado_comercial,estado_reparto,estado_pago,medio,subtotal,descuento,envio,total,reembolsado\n';
  return head + cols + rows.map((r) => [r.number, localDate(r.created_at, LIMA), r.city, `"${r.branch}"`, r.commercial_status, r.delivery_status, r.payment_status, r.payment_method, ...[r.subtotal_cents, r.discount_cents, r.delivery_fee_cents, r.total_cents, r.refunded_cents].map((x) => (x / 100).toFixed(2))].join(',')).join('\n') + '\n';
}

// ---------- Reembolsos, liquidaciones y efectivo ----------
export async function refunds(status?: string) {
  return db.q(
    `SELECT r.id, r.order_id, o.number, r.amount_cents, r.concept, r.reason, r.status, r.created_at, r.confirmed_at, coalesce(p.provider, o.payment_method) AS provider
     FROM refunds r JOIN orders o ON o.id = r.order_id LEFT JOIN payments p ON p.id = r.payment_id
     WHERE ($1::text IS NULL OR r.status = $1) ORDER BY r.created_at DESC LIMIT 200`,
    [status ?? null],
  );
}

/** Cuatro ojos: quien aprueba una liquidación no puede ser quien la generó. */
export async function approveSettlement(a: AuthCtx, id: string, reason: string) {
  return tx(async (t) => {
    const s = await t.maybe(`SELECT * FROM settlements WHERE id = $1 FOR UPDATE`, [id]);
    if (!s) throw new BizError('NOT_FOUND', 'Liquidación no encontrada', 404);
    if (s.status !== 'draft') throw new BizError('INVALID_STATE', 'Solo se aprueban liquidaciones en borrador', 409);
    if (s.created_by === a.userId) throw new BizError('FOUR_EYES', 'La aprobación debe hacerla una persona distinta de quien generó la liquidación', 403);
    const re = await recomputeSettlement(t, id);
    if (re.totalCents !== Number(s.total_cents)) throw new BizError('SETTLEMENT_INCONSISTENT', 'El total recalculado no coincide', 409);
    await t.q(`UPDATE settlements SET status = 'approved' WHERE id = $1`, [id]);
    await audit(t, a, 'settlement.approved', 'settlement', id, reason, { total: s.total_cents });
    return settlementDetail(a, id, t);
  });
}

/** Solo registra la ejecución externa (transferencia hecha por el titular); no mueve dinero. */
export async function executeSettlement(a: AuthCtx, id: string, input: { reference: string; reason: string }) {
  return tx(async (t) => {
    const s = await t.maybe(`SELECT * FROM settlements WHERE id = $1 FOR UPDATE`, [id]);
    if (!s) throw new BizError('NOT_FOUND', 'Liquidación no encontrada', 404);
    if (s.status !== 'approved') throw new BizError('INVALID_STATE', 'Solo se ejecutan liquidaciones aprobadas', 409);
    await t.q(`UPDATE settlements SET status = 'executed', execution_reference = $2 WHERE id = $1`, [id, input.reference]);
    await audit(t, a, 'settlement.executed', 'settlement', id, input.reason, { reference: input.reference });
    return settlementDetail(a, id, t);
  });
}

export async function voidSettlement(a: AuthCtx, id: string, reason: string) {
  return tx(async (t) => {
    const s = await t.maybe(`SELECT * FROM settlements WHERE id = $1 FOR UPDATE`, [id]);
    if (!s) throw new BizError('NOT_FOUND', 'Liquidación no encontrada', 404);
    if (!['draft', 'approved'].includes(s.status)) throw new BizError('INVALID_STATE', 'Una liquidación ejecutada no se anula: registre un ajuste', 409);
    const items = await t.q(`DELETE FROM settlement_items WHERE settlement_id = $1 RETURNING ledger_entry_id`, [id]);
    await t.q(`UPDATE settlements SET status = 'void' WHERE id = $1`, [id]);
    await audit(t, a, 'settlement.voided', 'settlement', id, reason, { releasedEntries: items.map((i) => i.ledger_entry_id) });
    return { voided: true, releasedEntries: items.length };
  });
}

export async function courierCash(a: AuthCtx, courierId: string) {
  const c = await db.maybe(`SELECT city_id FROM couriers WHERE user_id = $1`, [courierId]);
  if (!c) throw new BizError('NOT_FOUND', 'Repartidor no encontrado', 404);
  assertCityScope(a, c.city_id, ['admin', 'finance', 'city_dispatcher']);
  const rows = await db.q(
    `SELECT cc.order_id, o.number, cc.amount_due_cents, cc.collected_cents, cc.collected_at FROM cash_collections cc JOIN orders o ON o.id = cc.order_id
     WHERE cc.courier_id = $1 AND cc.remitted_at IS NULL ORDER BY cc.collected_at`,
    [courierId],
  );
  return { pendingCents: rows.reduce((a, r) => a + Number(r.amount_due_cents), 0), collections: rows };
}

/**
 * Rendición de efectivo: el importe debe coincidir con todo lo pendiente (evita rendiciones
 * parciales ambiguas). Asiento positivo que compensa los "courier_cash_held".
 */
export async function cashRemittance(a: AuthCtx, courierId: string, input: { amountCents: number; reference: string }) {
  return tx(async (t) => {
    await t.q(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`cash:${courierId}`]);
    const c = await t.maybe(`SELECT city_id FROM couriers WHERE user_id = $1`, [courierId]);
    if (!c) throw new BizError('NOT_FOUND', 'Repartidor no encontrado', 404);
    assertCityScope(a, c.city_id, ['admin', 'finance']);
    const pending = await t.q(`SELECT order_id, amount_due_cents FROM cash_collections WHERE courier_id = $1 AND remitted_at IS NULL FOR UPDATE`, [courierId]);
    const total = pending.reduce((s, r) => s + Number(r.amount_due_cents), 0);
    if (total === 0) throw new BizError('NOTHING_PENDING', 'No hay efectivo pendiente de rendir', 409);
    if (input.amountCents !== total) throw new BizError('AMOUNT_MISMATCH', `El monto pendiente es S/ ${(total / 100).toFixed(2)}`, 422, { pendingCents: total });
    await t.q(`UPDATE cash_collections SET remitted_at = now() WHERE courier_id = $1 AND remitted_at IS NULL`, [courierId]);
    const { post } = await import('../finance/ledger.service');
    await post(t, [{ orderId: null, partyType: 'courier', partyId: courierId, type: 'courier_cash_remitted', amount: total, description: `Rendición de efectivo (${pending.length} pedidos)`, reference: input.reference, dedupeKey: `cash_remit:${courierId}:${input.reference}`, createdBy: a.userId }]);
    await audit(t, a, 'courier.cash_remitted', 'courier', courierId, null, { total, reference: input.reference, orders: pending.map((p) => p.order_id) });
    return { remittedCents: total, orders: pending.length };
  });
}

export async function findUser(email: string) {
  const u = await db.maybe(`SELECT id, full_name, email FROM users WHERE email = $1 AND status = 'active'`, [email ?? '']);
  if (!u) throw new BizError('NOT_FOUND', 'Cuenta no encontrada', 404);
  const ms = await db.q(`SELECT id, role, city_id, merchant_id, branch_id, created_at FROM memberships WHERE user_id = $1 AND revoked_at IS NULL`, [u.id]);
  return { id: u.id, fullName: u.full_name, email: u.email, memberships: ms };
}

export async function revokeRole(a: AuthCtx, membershipId: string, reason: string) {
  return tx(async (t) => {
    const m = await t.maybe(`UPDATE memberships SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING user_id, role`, [membershipId]);
    if (!m) throw new BizError('NOT_FOUND', 'Membresía no encontrada', 404);
    if (m.user_id === a.userId && m.role === 'admin') throw new BizError('SELF_REVOKE', 'No puedes revocar tu propio rol de administrador', 403);
    await audit(t, a, 'membership.revoked', 'user', m.user_id, reason, { role: m.role, membershipId });
    return { revoked: true };
  });
}
