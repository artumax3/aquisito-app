import { CourierDeliveryDto, OfferDto } from '@aquisito/contracts';
import { config } from '../../config';
import { db, Tx, tx } from '../../db/db';
import { AuthCtx, assertCityScope } from '../../common/auth';
import { BizError } from '../../common/errors';
import { audit, emit } from '../../common/audit';
import { sha256 } from '../../common/crypto';
import { lockOrder, transition } from '../orders/state';
import { postCompletion } from '../finance/ledger.service';
import { alcoholSaleCheck } from '../alcohol/alcohol.service';
import { requireCoverage } from '../geo/geo.service';
import { routeDistance } from '../../providers/geo';

const DISPATCHABLE = ['confirmado', 'aceptado_comercio', 'en_preparacion', 'listo_para_recojo'];

async function requireApprovedCourier(t: Tx, userId: string) {
  const c = await t.maybe(`SELECT * FROM couriers WHERE user_id = $1`, [userId]);
  if (!c) throw new BizError('NOT_COURIER', 'No tienes perfil de repartidor', 403);
  if (c.status !== 'approved') throw new BizError('COURIER_NOT_APPROVED', 'Tu cuenta de repartidor aún no está aprobada', 403);
  return c;
}

/**
 * Asignación automática: un pedido puede buscar repartidor mientras se prepara. Candidatos:
 * aprobados, disponibles, de la misma ciudad, sin entrega activa ni oferta abierta, con ubicación
 * reciente (<10 min), que no hayan rechazado/dejado vencer ese pedido; para alcohol, con
 * capacitación registrada. Se ordena por distancia al comercio.
 */
export async function autoDispatch(): Promise<number> {
  const orders = await db.q(
    `SELECT o.id FROM orders o
     WHERE o.commercial_status = ANY($1) AND o.delivery_status = 'sin_asignar'
       AND (o.scheduled_for IS NULL OR o.scheduled_for - make_interval(mins => coalesce(o.prep_minutes,20) + 20) <= now())
       AND NOT EXISTS (SELECT 1 FROM delivery_offers f WHERE f.order_id = o.id AND f.status = 'offered')
       AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.order_id = o.id AND d.status = 'active')
     ORDER BY o.confirmed_at NULLS LAST LIMIT 20`,
    [DISPATCHABLE],
  );
  let created = 0;
  for (const { id } of orders) {
    try {
      const ok = await tx(async (t) => {
        const o = await lockOrder(t, id);
        if (!DISPATCHABLE.includes(o.commercial_status) || o.delivery_status !== 'sin_asignar') return false;
        const b = await t.one(`SELECT ST_Y(location) AS lat, ST_X(location) AS lng FROM branches WHERE id = $1`, [o.branch_id]);
        const cand = await t.maybe(
          `SELECT c.user_id, ST_Y(l.location) AS lat, ST_X(l.location) AS lng FROM couriers c JOIN courier_locations l ON l.courier_id = c.user_id
           JOIN memberships m ON m.user_id = c.user_id AND m.role = 'courier' AND m.revoked_at IS NULL AND m.city_id = c.city_id
           WHERE c.city_id = $1 AND c.status = 'approved' AND c.available AND l.recorded_at > now() - interval '10 minutes'
             AND ($3 = false OR c.alcohol_training_at IS NOT NULL)
             AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.courier_id = c.user_id AND d.status = 'active')
             AND NOT EXISTS (SELECT 1 FROM delivery_offers f WHERE f.courier_id = c.user_id AND f.status = 'offered')
             AND NOT EXISTS (SELECT 1 FROM delivery_offers f WHERE f.courier_id = c.user_id AND f.order_id = $2)
           ORDER BY ST_Distance(l.location::geography, ST_SetSRID(ST_MakePoint($4,$5),4326)::geography) LIMIT 1`,
          [o.city_id, o.id, o.contains_alcohol, b.lng, b.lat],
        );
        if (!cand) return false;
        await createOffer(t, o, cand.user_id, { lat: cand.lat, lng: cand.lng }, b);
        await transition(t, o, 'delivery', 'oferta_enviada', 'system', { reason: 'Asignación automática por proximidad' });
        return true;
      });
      if (ok) created++;
    } catch (e: any) {
      if (e?.code !== '23505') throw e; // carrera con otra instancia: el índice único lo resolvió
    }
  }
  return created;
}

async function createOffer(t: Tx, o: any, courierId: string, courierPt: { lat: number; lng: number }, branchPt: { lat: number; lng: number }) {
  const dest = await t.one(`SELECT ST_Y(destination) AS lat, ST_X(destination) AS lng FROM orders WHERE id = $1`, [o.id]);
  const toStore = await routeDistance(courierPt, branchPt);
  const toCustomer = await routeDistance(branchPt, dest);
  await t.q(
    `INSERT INTO delivery_offers(order_id, courier_id, estimated_distance_meters, estimated_pay_cents, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(secs => $5))`,
    [o.id, courierId, toStore.meters + toCustomer.meters, o.courier_pay_cents + o.tip_cents, config().OFFER_TTL_SECONDS],
  );
  await emit(t, 'offer.created', o.id, { orderId: o.id, courierId });
}

export async function expireOffers(): Promise<number> {
  const rows = await db.q(`SELECT id, order_id FROM delivery_offers WHERE status = 'offered' AND expires_at < now() LIMIT 50`);
  for (const r of rows) {
    await tx(async (t) => {
      const o = await lockOrder(t, r.order_id);
      const f = await t.maybe(`UPDATE delivery_offers SET status = 'expired', responded_at = now() WHERE id = $1 AND status = 'offered' RETURNING id`, [r.id]);
      if (f && o.delivery_status === 'oferta_enviada') await transition(t, o, 'delivery', 'sin_asignar', 'system', { reason: 'Oferta vencida' });
    });
  }
  return rows.length;
}

export async function listOffers(a: AuthCtx): Promise<OfferDto[]> {
  const rows = await db.q(
    `SELECT f.*, b.name AS branch_name, ST_Y(b.location) AS blat, ST_X(b.location) AS blng, z.name AS zone_name, o.contains_alcohol, o.payment_method, o.total_cents
     FROM delivery_offers f JOIN orders o ON o.id = f.order_id JOIN branches b ON b.id = o.branch_id LEFT JOIN zones z ON z.id = o.destination_zone_id
     WHERE f.courier_id = $1 AND f.status = 'offered' AND f.expires_at > now()`,
    [a.userId],
  );
  // Sin nombre, teléfono ni dirección exacta del cliente antes de aceptar.
  return rows.map((r) => ({
    id: r.id,
    orderId: r.order_id,
    expiresAt: r.expires_at.toISOString(),
    branchName: r.branch_name,
    branchLocation: { lat: r.blat, lng: r.blng },
    destinationArea: r.zone_name ?? 'Zona urbana',
    estimatedDistanceMeters: r.estimated_distance_meters,
    estimatedPayCents: r.estimated_pay_cents,
    containsAlcohol: r.contains_alcohol,
    cashToCollectCents: r.payment_method === 'cash' ? r.total_cents : null,
  }));
}

/** Aceptación atómica: bloqueo de la oferta y del pedido + índices únicos de asignación activa. */
export async function acceptOffer(a: AuthCtx, offerId: string) {
  try {
    return await tx(async (t) => {
      await requireApprovedCourier(t, a.userId);
      const f0 = await t.maybe(`SELECT order_id FROM delivery_offers WHERE id = $1 AND courier_id = $2`, [offerId, a.userId]);
      if (!f0) throw new BizError('NOT_FOUND', 'Oferta no encontrada', 404);
      const o = await lockOrder(t, f0.order_id);
      const f = await t.one(`SELECT * FROM delivery_offers WHERE id = $1 FOR UPDATE`, [offerId]);
      if (f.status !== 'offered' || f.expires_at < new Date()) throw new BizError('OFFER_UNAVAILABLE', 'La oferta ya no está disponible', 409);
      if (o.delivery_status !== 'oferta_enviada' || !DISPATCHABLE.includes(o.commercial_status)) throw new BizError('OFFER_UNAVAILABLE', 'El pedido ya no requiere repartidor', 409);
      await t.q(`UPDATE delivery_offers SET status = 'accepted', responded_at = now() WHERE id = $1`, [offerId]);
      await t.q(`INSERT INTO deliveries(order_id, courier_id, offer_id) VALUES ($1,$2,$3)`, [o.id, a.userId, offerId]);
      await transition(t, o, 'delivery', 'asignado', 'courier', { userId: a.userId });
      return { orderId: o.id, assigned: true };
    });
  } catch (e: any) {
    if (e?.code === '23505') throw new BizError('ALREADY_ASSIGNED', 'El pedido ya tiene repartidor o tienes otra entrega activa', 409);
    throw e;
  }
}

export async function rejectOffer(a: AuthCtx, offerId: string) {
  await tx(async (t) => {
    const f0 = await t.maybe(`SELECT order_id FROM delivery_offers WHERE id = $1 AND courier_id = $2`, [offerId, a.userId]);
    if (!f0) throw new BizError('NOT_FOUND', 'Oferta no encontrada', 404);
    const o = await lockOrder(t, f0.order_id);
    const f = await t.maybe(`UPDATE delivery_offers SET status = 'rejected', responded_at = now() WHERE id = $1 AND status = 'offered' RETURNING id`, [offerId]);
    if (f && o.delivery_status === 'oferta_enviada') await transition(t, o, 'delivery', 'sin_asignar', 'courier', { userId: a.userId, reason: 'Oferta rechazada' });
  });
  return { rejected: true };
}

/** Asignación manual supervisada (despachador de la ciudad o admin), con motivo y auditoría. */
export async function manualAssign(a: AuthCtx, orderId: string, courierId: string, reason: string) {
  try {
    return await tx(async (t) => {
      const o = await lockOrder(t, orderId);
      assertCityScope(a, o.city_id, ['admin', 'city_dispatcher']);
      if (!DISPATCHABLE.includes(o.commercial_status)) throw new BizError('NOT_DISPATCHABLE', 'El pedido no está en un estado asignable', 409);
      const c = await t.maybe(`SELECT * FROM couriers WHERE user_id = $1 AND status = 'approved' AND city_id = $2`, [courierId, o.city_id]);
      if (!c) throw new BizError('COURIER_INVALID', 'Repartidor no aprobado en esta ciudad', 422);
      if (o.contains_alcohol && !c.alcohol_training_at) throw new BizError('COURIER_TRAINING', 'El repartidor no tiene capacitación registrada para entregas restringidas', 422);
      // Coherencia de cobertura al reasignar.
      const dest = await t.one(`SELECT ST_Y(destination) AS lat, ST_X(destination) AS lng FROM orders WHERE id = $1`, [o.id]);
      await requireCoverage(o.city_id, dest.lat, dest.lng, new Date(), t);
      if (o.delivery_status === 'oferta_enviada') {
        await t.q(`UPDATE delivery_offers SET status = 'cancelled', responded_at = now() WHERE order_id = $1 AND status = 'offered'`, [o.id]);
        await transition(t, o, 'delivery', 'sin_asignar', 'system', { reason: 'Oferta cancelada por asignación manual' });
      }
      await t.q(`INSERT INTO deliveries(order_id, courier_id, assigned_by, assign_reason) VALUES ($1,$2,$3,$4)`, [o.id, courierId, a.userId, reason]);
      await transition(t, o, 'delivery', 'asignado', 'dispatcher', { userId: a.userId, reason });
      await audit(t, a, 'dispatch.manual_assign', 'order', o.id, reason, { courierId });
      return { assigned: true };
    });
  } catch (e: any) {
    if (e?.code === '23505') throw new BizError('ALREADY_ASSIGNED', 'El pedido ya tiene repartidor o el repartidor tiene otra entrega activa', 409);
    throw e;
  }
}

export async function unassign(a: AuthCtx, orderId: string, reason: string, actor: 'dispatcher' | 'courier' = 'dispatcher') {
  return tx(async (t) => {
    const o = await lockOrder(t, orderId);
    if (actor === 'dispatcher') assertCityScope(a, o.city_id, ['admin', 'city_dispatcher']);
    if (!['asignado', 'en_camino_al_comercio'].includes(o.delivery_status)) throw new BizError('UNASSIGN_NOT_ALLOWED', 'Solo se puede reasignar antes del recojo', 409);
    const d = await t.one(`UPDATE deliveries SET status = 'ended', ended_at = now(), end_reason = $2 WHERE order_id = $1 AND status = 'active' RETURNING courier_id`, [o.id, reason]);
    if (actor === 'courier' && d.courier_id !== a.userId) throw new BizError('NOT_FOUND', 'Entrega no encontrada', 404);
    await transition(t, o, 'delivery', 'sin_asignar', actor, { userId: a.userId, reason });
    await audit(t, a, 'dispatch.unassign', 'order', o.id, reason, { courierId: d.courier_id });
    return { unassigned: true };
  });
}

// ======================= Repartidor: entrega activa =======================

async function myActiveDelivery(t: Tx, a: AuthCtx, orderId: string) {
  const d = await t.maybe(`SELECT * FROM deliveries WHERE order_id = $1 AND courier_id = $2 AND status = 'active'`, [orderId, a.userId]);
  // Un repartidor no puede operar (ni ver) pedidos que no le corresponden.
  if (!d) throw new BizError('NOT_FOUND', 'Entrega no encontrada', 404);
  const o = await lockOrder(t, orderId);
  return { d, o };
}

export async function currentDelivery(a: AuthCtx): Promise<CourierDeliveryDto | null> {
  const r = await db.maybe(
    `SELECT o.*, ST_Y(o.destination) AS dlat, ST_X(o.destination) AS dlng, b.name AS bname, b.address AS baddr, ST_Y(b.location) AS blat, ST_X(b.location) AS blng,
            u.full_name, coalesce(o.contact_phone, u.phone) AS phone, d.id AS delivery_id
     FROM deliveries d JOIN orders o ON o.id = d.order_id JOIN branches b ON b.id = o.branch_id JOIN users u ON u.id = o.user_id
     WHERE d.courier_id = $1 AND d.status = 'active'`,
    [a.userId],
  );
  if (!r) return null;
  const check = await db.maybe(`SELECT result FROM door_age_checks WHERE delivery_id = $1`, [r.delivery_id]);
  return {
    orderId: r.id,
    orderNumber: r.number,
    deliveryStatus: r.delivery_status,
    commercialStatus: r.commercial_status,
    branch: { name: r.bname, address: r.baddr, lat: r.blat, lng: r.blng },
    customer: {
      name: r.full_name.split(' ')[0],
      phoneMasked: r.phone ? r.phone.replace(/^(\+51)(\d{3})\d{3}(\d{3})$/, '$1 $2 *** $3') : null,
      address: r.address_line1,
      reference: r.address_reference,
      instructions: r.address_instructions,
      lat: r.dlat,
      lng: r.dlng,
    },
    containsAlcohol: r.contains_alcohol,
    cashToCollectCents: r.payment_method === 'cash' ? r.total_cents : null,
    cashChangeForCents: r.cash_change_for_cents,
    packages: r.packages,
    ageCheckApproved: check?.result === 'approved',
  };
}

export async function headingToStore(a: AuthCtx, orderId: string) {
  return tx(async (t) => {
    const { o } = await myActiveDelivery(t, a, orderId);
    await transition(t, o, 'delivery', 'en_camino_al_comercio', 'courier', { userId: a.userId });
    return { ok: true };
  });
}

export async function pickup(a: AuthCtx, orderId: string, input: { pickupCode: string; packages: number }) {
  return tx(async (t) => {
    const { o } = await myActiveDelivery(t, a, orderId);
    if (o.commercial_status !== 'listo_para_recojo') throw new BizError('NOT_READY', 'El comercio aún no marcó el pedido como listo', 409);
    if (input.pickupCode !== o.pickup_code) throw new BizError('PICKUP_CODE_INVALID', 'El código de recojo no coincide con este pedido', 422);
    if (input.packages !== o.packages) throw new BizError('PACKAGES_MISMATCH', `El pedido tiene ${o.packages} paquete(s). Verifica con el comercio.`, 422);
    if (o.contains_alcohol) {
      const chk = await alcoholSaleCheck({ branchId: o.branch_id, destinationJurisdictionId: o.destination_jurisdiction_id, instants: [new Date()] }, t);
      if (!chk.ok) throw new BizError(chk.code, `${chk.message}. No retires el pedido; contacta a soporte.`, 422);
    }
    await transition(t, o, 'delivery', 'recogido', 'courier', { userId: a.userId, extraSet: { picked_up_at: new Date() } });
    return { ok: true };
  });
}

export async function depart(a: AuthCtx, orderId: string) {
  return tx(async (t) => {
    const { o } = await myActiveDelivery(t, a, orderId);
    await transition(t, o, 'delivery', 'en_camino_al_cliente', 'courier', { userId: a.userId });
    return { ok: true };
  });
}

export async function arrive(a: AuthCtx, orderId: string) {
  return tx(async (t) => {
    const { o } = await myActiveDelivery(t, a, orderId);
    await transition(t, o, 'delivery', 'en_destino', 'courier', { userId: a.userId });
    if (o.contains_alcohol) await transition(t, o, 'delivery', 'verificacion_requerida', 'system', { reason: 'Pedido con alcohol: verificación presencial obligatoria' });
    return { ok: true, ageCheckRequired: o.contains_alcohol };
  });
}

/** Comprobación presencial de edad e identidad. Sin foto del documento. Una por entrega. */
export async function ageCheck(
  a: AuthCtx,
  orderId: string,
  input: { result: 'approved' | 'rejected'; documentType?: string; rejectionReason?: string; notes?: string; identityMatchesBuyer: boolean },
) {
  return tx(async (t) => {
    const { d, o } = await myActiveDelivery(t, a, orderId);
    if (!o.contains_alcohol) throw new BizError('NOT_REQUIRED', 'Este pedido no requiere verificación de edad', 409);
    if (o.delivery_status !== 'verificacion_requerida') throw new BizError('INVALID_STATE', 'Primero marca que llegaste al destino', 409);
    const approved = input.result === 'approved' && input.identityMatchesBuyer && !!input.documentType;
    if (input.result === 'approved' && !approved) throw new BizError('AGE_CHECK_INCOMPLETE', 'Para aprobar debes confirmar el tipo de documento y que la persona coincide con el comprador', 422);
    if (input.result === 'rejected' && !input.rejectionReason) throw new BizError('AGE_CHECK_REASON', 'Indica el motivo del rechazo', 422);
    try {
      await t.q(
        `INSERT INTO door_age_checks(order_id, delivery_id, courier_id, result, document_type, rejection_reason, identity_matches_buyer, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [o.id, d.id, a.userId, input.result, input.documentType ?? null, input.rejectionReason ?? null, input.identityMatchesBuyer, input.notes ?? null],
      );
    } catch (e: any) {
      if (e?.code === '23505') throw new BizError('AGE_CHECK_DONE', 'La verificación de esta entrega ya fue registrada', 409);
      throw e;
    }
    if (input.result === 'rejected') {
      await transition(t, o, 'delivery', 'entrega_rechazada', 'courier', { userId: a.userId, reason: `Verificación de edad: ${input.rejectionReason}` });
      await transition(t, o, 'delivery', 'retorno_pendiente', 'system', { reason: 'Retorno al comercio' });
      const products = o.subtotal_cents - (o.coupon_funded_by ? Math.min(o.discount_cents, o.subtotal_cents) : 0);
      await t.q(
        `INSERT INTO incidents(order_id, reporter_user_id, reporter_role, kind, description) VALUES ($1,$2,'courier','age_check_failed',$3)`,
        [o.id, a.userId, `Entrega rechazada en verificación presencial (${input.rejectionReason}). Pedido completo retorna al comercio. Resolución sugerida según política informada: reembolso de productos S/ ${(products / 100).toFixed(2)}, tarifa de servicio y propina; la tarifa de reparto se retiene por servicio prestado (validar con política vigente).`],
      );
      await emit(t, 'incident.created', o.id, { orderId: o.id, kind: 'age_check_failed' });
    }
    return { recorded: true, result: input.result };
  });
}

export async function deliver(a: AuthCtx, orderId: string, input: { deliveryCode: string; cashCollectedCents?: number }) {
  try {
    return await deliverTx(a, orderId, input);
  } catch (e: any) {
    if (e?.persistAttempt) await db.q(`INSERT INTO delivery_code_attempts(order_id, courier_id, success) VALUES ($1,$2,false)`, [e.persistAttempt.orderId, e.persistAttempt.courierId]);
    throw e;
  }
}

async function deliverTx(a: AuthCtx, orderId: string, input: { deliveryCode: string; cashCollectedCents?: number }) {
  return tx(async (t) => {
    const { d, o } = await myActiveDelivery(t, a, orderId);
    const fails = await t.one(`SELECT count(*)::int AS n FROM delivery_code_attempts WHERE order_id = $1 AND NOT success AND created_at > now() - interval '1 hour'`, [o.id]);
    if (fails.n >= 5) throw new BizError('DELIVERY_CODE_LOCKED', 'Demasiados intentos con código incorrecto. Contacta a soporte.', 429);
    if (o.contains_alcohol) {
      // Bloqueo en servidor: sin comprobación presencial APROBADA asociada a esta entrega no hay "entregado".
      const chk = await t.maybe(`SELECT result FROM door_age_checks WHERE delivery_id = $1`, [d.id]);
      if (o.delivery_status !== 'verificacion_requerida' || chk?.result !== 'approved')
        throw new BizError('AGE_CHECK_REQUIRED', 'Pedido con alcohol: se requiere verificación presencial aprobada antes de entregar', 409);
      const sale = await alcoholSaleCheck({ branchId: o.branch_id, destinationJurisdictionId: o.destination_jurisdiction_id, instants: [new Date()] }, t);
      if (!sale.ok) throw new BizError(sale.code, `${sale.message}. No entregues; inicia el retorno con soporte.`, 409);
    } else if (o.delivery_status !== 'en_destino') {
      throw new BizError('INVALID_STATE', 'Marca primero que llegaste al destino', 409);
    }
    if (o.delivery_code_used_at || sha256(input.deliveryCode) !== o.delivery_code_hash) {
      // El intento fallido se persiste fuera de la transacción (que se revierte).
      throw Object.assign(new BizError('DELIVERY_CODE_INVALID', 'Código de entrega incorrecto', 422), { persistAttempt: { orderId: o.id, courierId: a.userId } });
    }
    await t.q(`INSERT INTO delivery_code_attempts(order_id, courier_id, success) VALUES ($1,$2,true)`, [o.id, a.userId]);
    if (o.payment_method === 'cash') {
      if (input.cashCollectedCents == null || input.cashCollectedCents < o.total_cents)
        throw new BizError('CASH_REQUIRED', `Registra el efectivo cobrado (mínimo S/ ${(o.total_cents / 100).toFixed(2)})`, 422);
      await t.q(`INSERT INTO cash_collections(order_id, courier_id, amount_due_cents, change_for_cents, collected_cents) VALUES ($1,$2,$3,$4,$5)`, [o.id, a.userId, o.total_cents, o.cash_change_for_cents, input.cashCollectedCents]);
      await t.q(`UPDATE payments SET status = 'pagado', paid_at = now(), provider_reference = $2 WHERE order_id = $1 AND provider = 'cash'`, [o.id, `cash:${o.id}`]);
      await transition(t, o, 'payment', 'pagado', 'courier', { userId: a.userId, reason: 'Efectivo cobrado en la entrega' });
    }
    await transition(t, o, 'delivery', 'entregado', 'courier', { userId: a.userId, extraSet: { delivered_at: new Date(), delivery_code_used_at: new Date() } });
    await transition(t, o, 'commercial', 'completado', 'system', { extraSet: { completed_at: new Date() } });
    await t.q(`UPDATE deliveries SET status = 'ended', ended_at = now(), end_reason = 'entregado' WHERE id = $1`, [d.id]);
    await postCompletion(t, o);
    return { delivered: true };
  });
}

export async function failDelivery(a: AuthCtx, orderId: string, input: { kind: string; notes: string }) {
  return tx(async (t) => {
    const { o } = await myActiveDelivery(t, a, orderId);
    await transition(t, o, 'delivery', 'entrega_fallida', 'courier', { userId: a.userId, reason: `${input.kind}: ${input.notes}` });
    await transition(t, o, 'delivery', 'retorno_pendiente', 'system', { reason: 'Retorno al comercio' });
    await t.q(`INSERT INTO incidents(order_id, reporter_user_id, reporter_role, kind, description) VALUES ($1,$2,'courier',$3,$4)`, [o.id, a.userId, input.kind, input.notes]);
    await emit(t, 'incident.created', o.id, { orderId: o.id, kind: input.kind });
    return { ok: true };
  });
}

export async function earnings(a: AuthCtx) {
  const sums = await db.q(
    `SELECT entry_type, coalesce(sum(amount_cents),0)::bigint AS total, count(*)::int AS n FROM ledger_entries WHERE party_type = 'courier' AND party_id = $1 GROUP BY entry_type`,
    [a.userId],
  );
  const get = (k: string) => Number(sums.find((s) => s.entry_type === k)?.total ?? 0);
  const settled = await db.one(
    `SELECT coalesce(sum(l.amount_cents),0)::bigint AS s FROM ledger_entries l JOIN settlement_items si ON si.ledger_entry_id = l.id JOIN settlements st ON st.id = si.settlement_id
     WHERE l.party_type = 'courier' AND l.party_id = $1 AND st.status <> 'void'`,
    [a.userId],
  );
  const settlements = await db.q(`SELECT id, period_start, period_end, total_cents, status FROM settlements WHERE party_type = 'courier' AND party_id = $1 ORDER BY period_end DESC LIMIT 20`, [a.userId]);
  return {
    deliveryPayCents: get('courier_delivery_pay'),
    tipsCents: get('courier_tip'),
    adjustmentsCents: get('courier_adjustment'),
    cashHeldCents: -get('courier_cash_held'),
    balanceCents: sums.reduce((s, r) => s + Number(r.total), 0),
    settledCents: Number(settled.s),
    settlements,
    note: 'Registros de operación. Aquisito no custodia fondos ni permite retiros; las liquidaciones se ejecutan fuera de la plataforma con autorización.',
  };
}

export async function history(a: AuthCtx) {
  const rows = await db.q(
    `SELECT o.id, o.number, o.delivery_status, o.delivered_at, d.assigned_at, d.end_reason, b.name AS branch_name, z.name AS zone_name
     FROM deliveries d JOIN orders o ON o.id = d.order_id JOIN branches b ON b.id = o.branch_id LEFT JOIN zones z ON z.id = o.destination_zone_id
     WHERE d.courier_id = $1 ORDER BY d.assigned_at DESC LIMIT 50`,
    [a.userId],
  );
  // Sin dirección exacta del cliente en el historial.
  return rows.map((r) => ({ orderId: r.id, number: r.number, status: r.delivery_status, branchName: r.branch_name, area: r.zone_name, assignedAt: r.assigned_at, deliveredAt: r.delivered_at, endReason: r.end_reason }));
}

export async function updateLocation(a: AuthCtx, input: { lat: number; lng: number; accuracyM: number; recordedAt: string }) {
  const c = await requireApprovedCourier(db, a.userId);
  const consent = await db.maybe(`SELECT granted FROM consents WHERE user_id = $1 AND purpose = 'location_tracking' ORDER BY created_at DESC LIMIT 1`, [a.userId]);
  if (!consent?.granted) throw new BizError('CONSENT_REQUIRED', 'Debes aceptar compartir tu ubicación mientras estás disponible', 403);
  const recorded = new Date(input.recordedAt);
  if (recorded.getTime() > Date.now() + 60000) throw new BizError('INVALID_TIMESTAMP', 'Marca de tiempo en el futuro', 422);
  await db.q(
    `INSERT INTO courier_locations(courier_id, location, accuracy_m, recorded_at) VALUES ($1, ST_SetSRID(ST_MakePoint($2,$3),4326), $4, $5)
     ON CONFLICT (courier_id) DO UPDATE SET location = EXCLUDED.location, accuracy_m = EXCLUDED.accuracy_m, recorded_at = EXCLUDED.recorded_at, received_at = now()
     WHERE courier_locations.recorded_at <= EXCLUDED.recorded_at`,
    [a.userId, input.lng, input.lat, input.accuracyM, recorded],
  );
  void c;
  return { ok: true };
}

export async function setAvailability(a: AuthCtx, available: boolean) {
  const c = await requireApprovedCourier(db, a.userId);
  if (available && !c.terms_accepted_at) throw new BizError('TERMS_REQUIRED', 'Acepta las condiciones operativas', 403);
  await db.q(`UPDATE couriers SET available = $2 WHERE user_id = $1`, [a.userId, available]);
  if (!available) await db.q(`DELETE FROM courier_locations WHERE courier_id = $1 AND NOT EXISTS (SELECT 1 FROM deliveries WHERE courier_id = $1 AND status = 'active')`, [a.userId]);
  return { available };
}
