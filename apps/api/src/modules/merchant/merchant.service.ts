import { ComboInput, ProductInput, localDate } from '@aquisito/contracts';
import { db, tx } from '../../db/db';
import { AuthCtx, branchAccess } from '../../common/auth';
import { BizError } from '../../common/errors';
import { audit, emit } from '../../common/audit';
import { lockOrder, transition } from '../orders/state';
import { acceptDeadline, orderDto } from '../orders/orders.service';
import { cancelOrderTx } from '../orders/lifecycle';
import { adjustStock, commit, inspectReturn } from '../inventory/inventory.service';
import { loadProducts } from '../catalog/catalog.service';
import { alcoholSaleCheck } from '../alcohol/alcohol.service';
import { requestRefund } from '../payments/refunds';
import { LIMA } from '../../common/time';

export async function apply(a: AuthCtx, input: any) {
  return tx(async (t) => {
    const jur = await t.maybe(`SELECT id FROM jurisdictions WHERE city_id = $1 AND ST_Contains(geom, ST_SetSRID(ST_MakePoint($2,$3),4326)) LIMIT 1`, [input.branch.cityId, input.branch.lng, input.branch.lat]);
    const m = await t.one(
      `INSERT INTO merchants(trade_name, legal_name, ruc, owner_user_id, contact_phone, settlement_account) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [input.tradeName, input.legalName ?? null, input.ruc ?? null, a.userId, input.contactPhone, input.settlementAccount ?? null],
    );
    const b = await t.one(
      `INSERT INTO branches(merchant_id, city_id, jurisdiction_id, name, address, location) VALUES ($1,$2,$3,$4,$5, ST_SetSRID(ST_MakePoint($6,$7),4326)) RETURNING id`,
      [m.id, input.branch.cityId, jur?.id ?? null, input.branch.name, input.branch.address, input.branch.lng, input.branch.lat],
    );
    await t.q(`INSERT INTO memberships(user_id, role, merchant_id) VALUES ($1,'merchant_owner',$2)`, [a.userId, m.id]);
    await audit(t, a, 'merchant.applied', 'merchant', m.id, null);
    return { merchantId: m.id, branchId: b.id, status: 'pending', note: 'El comercio se publicará solo después de la revisión administrativa.' };
  });
}

export async function myBranches(a: AuthCtx) {
  const merchantIds = a.memberships.filter((m) => m.role === 'merchant_owner').map((m) => m.merchant_id);
  const branchIds = a.memberships.filter((m) => m.role === 'branch_operator').map((m) => m.branch_id);
  return db.q(
    `SELECT b.id, b.merchant_id, b.name, b.status, b.paused, b.pause_reason, b.city_id, c.name AS city_name, m.trade_name, m.status AS merchant_status, b.sells_alcohol, b.alcohol_permit_status, b.prep_minutes,
       (b.merchant_id = ANY($1::uuid[])) AS is_owner
     FROM branches b JOIN merchants m ON m.id = b.merchant_id JOIN cities c ON c.id = b.city_id
     WHERE b.merchant_id = ANY($1::uuid[]) OR b.id = ANY($2::uuid[]) ORDER BY b.name`,
    [merchantIds, branchIds],
  );
}

export async function inbox(a: AuthCtx, branchId: string, scope: string) {
  await branchAccess(a, branchId);
  const active = scope !== 'history';
  const rows = await db.q(
    `SELECT * FROM orders WHERE branch_id = $1 AND (
       ($2 AND commercial_status IN ('confirmado','aceptado_comercio','en_preparacion','listo_para_recojo')) OR
       ($2 AND delivery_status = 'retorno_pendiente') OR
       (NOT $2 AND commercial_status IN ('completado','cancelado','rechazado_comercio')))
     ORDER BY coalesce(scheduled_for, created_at) ${active ? 'ASC' : 'DESC'} LIMIT 100`,
    [branchId, active],
  );
  return Promise.all(rows.map((o) => orderDto(o, 'merchant')));
}

async function lockMerchantOrder(t: any, a: AuthCtx, orderId: string) {
  const o0 = await t.maybe(`SELECT branch_id FROM orders WHERE id = $1`, [orderId]);
  if (!o0) throw new BizError('NOT_FOUND', 'Pedido no encontrado', 404);
  await branchAccess(a, o0.branch_id); // 404 si no es su sucursal
  return lockOrder(t, orderId);
}

async function revalidateAlcohol(t: any, o: any) {
  if (!o.contains_alcohol) return;
  const at = o.scheduled_for && new Date(o.scheduled_for) > new Date() ? new Date(o.scheduled_for) : new Date();
  const chk = await alcoholSaleCheck({ branchId: o.branch_id, destinationJurisdictionId: o.destination_jurisdiction_id, instants: [at, new Date(at.getTime() + 30 * 60000)] }, t);
  if (!chk.ok) throw new BizError(chk.code, `${chk.message}. Rechaza el pedido indicando el motivo.`, 422);
}

export async function accept(a: AuthCtx, orderId: string) {
  return tx(async (t) => {
    const o = await lockMerchantOrder(t, a, orderId);
    if (o.accept_deadline && o.accept_deadline < new Date()) throw new BizError('ACCEPT_EXPIRED', 'Venció el plazo de aceptación', 409);
    await revalidateAlcohol(t, o);
    await transition(t, o, 'commercial', 'aceptado_comercio', 'merchant', { userId: a.userId, extraSet: { accepted_at: new Date() } });
    return orderDto(o, 'merchant');
  });
}

export async function reject(a: AuthCtx, orderId: string, reason: string) {
  return tx(async (t) => {
    const o = await lockMerchantOrder(t, a, orderId);
    await cancelOrderTx(t, o, { to: 'rechazado_comercio', actor: 'merchant', userId: a.userId, reason });
    return orderDto(o, 'merchant');
  });
}

export async function startPrep(a: AuthCtx, orderId: string) {
  return tx(async (t) => {
    const o = await lockMerchantOrder(t, a, orderId);
    await revalidateAlcohol(t, o);
    const pending = await t.maybe(`SELECT 1 FROM substitutions WHERE order_id = $1 AND status = 'pending'`, [o.id]);
    if (pending) throw new BizError('SUBSTITUTION_PENDING', 'Espera la respuesta del cliente al ajuste propuesto', 409);
    await transition(t, o, 'commercial', 'en_preparacion', 'merchant', { userId: a.userId });
    await commit(t, o.id, a.userId);
    return orderDto(o, 'merchant');
  });
}

export async function ready(a: AuthCtx, orderId: string) {
  return tx(async (t) => {
    const o = await lockMerchantOrder(t, a, orderId);
    await transition(t, o, 'commercial', 'listo_para_recojo', 'merchant', { userId: a.userId, extraSet: { ready_at: new Date() } });
    return orderDto(o, 'merchant');
  });
}

export async function setEta(a: AuthCtx, orderId: string, prepMinutes: number) {
  return tx(async (t) => {
    const o = await lockMerchantOrder(t, a, orderId);
    if (!['aceptado_comercio', 'en_preparacion'].includes(o.commercial_status)) throw new BizError('INVALID_STATE', 'Solo se ajusta la estimación durante la preparación', 409);
    const eta = new Date(Date.now() + (prepMinutes + 20) * 60000);
    await t.q(`UPDATE orders SET prep_minutes = $2, eta_at = $3, version = version + 1 WHERE id = $1`, [o.id, prepMinutes, eta]);
    await emit(t, 'order.eta_changed', o.id, { orderId: o.id });
    return { etaAt: eta };
  });
}

/** Faltantes: nunca se cambia producto ni importe en silencio; el cliente acepta o rechaza. */
export async function proposeSubstitution(a: AuthCtx, orderId: string, input: { orderLineId: string; kind: 'remove' | 'substitute'; substituteVariantId?: string; note?: string }) {
  return tx(async (t) => {
    const o = await lockMerchantOrder(t, a, orderId);
    if (!['aceptado_comercio', 'confirmado'].includes(o.commercial_status)) throw new BizError('INVALID_STATE', 'Los ajustes se proponen antes de iniciar la preparación', 409);
    const line = await t.maybe(`SELECT * FROM order_lines WHERE id = $1 AND order_id = $2 AND removed_at IS NULL`, [input.orderLineId, o.id]);
    if (!line) throw new BizError('NOT_FOUND', 'Línea no encontrada', 404);
    let diff = -line.line_total_cents;
    if (input.kind === 'substitute') {
      const v = await t.maybe(
        `SELECT v.price_cents, r.contains_alcohol, p.branch_id FROM product_variants v JOIN products p ON p.id = v.product_id JOIN v_product_restriction r ON r.product_id = p.id WHERE v.id = $1 AND v.active AND p.active`,
        [input.substituteVariantId],
      );
      if (!v || v.branch_id !== o.branch_id) throw new BizError('NOT_FOUND', 'Producto sustituto no encontrado', 404);
      // Una sustitución no puede introducir alcohol (exigiría todos los controles y nueva compra).
      if (v.contains_alcohol) throw new BizError('SUBSTITUTION_ALCOHOL', 'No se permite sustituir por productos con alcohol. Propón retirar el producto.', 422);
      diff = v.price_cents * line.quantity - (line.unit_price_cents + line.modifiers_cents) * line.quantity;
      if (diff > 0) throw new BizError('SUBSTITUTION_MORE_EXPENSIVE', 'El sustituto no puede aumentar el importe ya pagado', 422);
    }
    const s = await t.one(
      `INSERT INTO substitutions(order_id, order_line_id, kind, substitute_variant_id, price_diff_cents, note, proposed_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [o.id, line.id, input.kind, input.substituteVariantId ?? null, diff, input.note ?? null, a.userId],
    );
    await emit(t, 'substitution.proposed', o.id, { orderId: o.id, substitutionId: s.id });
    return { substitutionId: s.id, priceDiffCents: diff };
  });
}

export async function respondSubstitution(a: AuthCtx, orderId: string, sid: string, accept: boolean) {
  return tx(async (t) => {
    const o = await lockOrder(t, orderId);
    if (o.user_id !== a.userId) throw new BizError('NOT_FOUND', 'Pedido no encontrado', 404);
    const s = await t.maybe(`SELECT * FROM substitutions WHERE id = $1 AND order_id = $2 AND status = 'pending' FOR UPDATE`, [sid, o.id]);
    if (!s) throw new BizError('NOT_FOUND', 'Propuesta no encontrada', 404);
    await t.q(`UPDATE substitutions SET status = $2, responded_at = now() WHERE id = $1`, [s.id, accept ? 'accepted' : 'rejected']);
    if (accept) {
      const line = await t.one(`SELECT * FROM order_lines WHERE id = $1`, [s.order_line_id]);
      const reduction = -s.price_diff_cents;
      if (s.kind === 'remove') await t.q(`UPDATE order_lines SET removed_at = now() WHERE id = $1`, [line.id]);
      await t.q(`UPDATE order_lines SET line_total_cents = greatest(0, line_total_cents - $2) WHERE id = $1`, [line.id, reduction]);
      // Ajuste de reservas de los SKU de la línea retirada (si siguen activas).
      if (s.kind === 'remove') {
        const v = await t.maybe(`SELECT sku_id, sku_units FROM product_variants WHERE id = $1`, [line.variant_id]);
        const skus: [string, number][] = [];
        if (v?.sku_id) skus.push([v.sku_id, v.sku_units * line.quantity]);
        for (const c of await t.q(`SELECT sku_id, quantity FROM order_line_components WHERE order_line_id = $1 AND sku_id IS NOT NULL`, [line.id])) skus.push([c.sku_id, c.quantity]);
        for (const [sku, q] of skus) {
          const r = await t.maybe(`UPDATE inventory_reservations SET quantity = quantity - $3, updated_at = now() WHERE order_id = $1 AND sku_id = $2 AND status = 'active' AND quantity > $3 RETURNING id`, [o.id, sku, q]);
          if (!r) await t.q(`UPDATE inventory_reservations SET status = 'released', updated_at = now() WHERE order_id = $1 AND sku_id = $2 AND status = 'active' AND quantity = $3`, [o.id, sku, q]);
          await t.q(`UPDATE inventory SET reserved = reserved - $2 WHERE sku_id = $1`, [sku, q]);
        }
      }
      const newSubtotal = o.subtotal_cents - reduction;
      const newDiscount = Math.min(o.discount_cents, newSubtotal + o.delivery_fee_cents);
      const newTotal = newSubtotal - newDiscount + o.delivery_fee_cents + o.service_fee_cents + o.surcharge_cents + o.tip_cents;
      const wasPaid = o.payment_status === 'pagado';
      await t.q(`UPDATE orders SET subtotal_cents = $2, discount_cents = $3, total_cents = $4, version = version + 1 WHERE id = $1`, [o.id, newSubtotal, newDiscount, newTotal]);
      Object.assign(o, { subtotal_cents: newSubtotal, discount_cents: newDiscount, total_cents: newTotal });
      if (wasPaid) {
        await requestRefund(t, o, { amountCents: reduction + (o.discount_cents - newDiscount), concept: 'products', reason: 'Ajuste aceptado por faltante', idempotencyKey: `subst:${s.id}`, userId: a.userId, actor: 'system' });
      }
      await t.q(`UPDATE payments SET amount_cents = $2 WHERE order_id = $1 AND provider = 'cash' AND status = 'pendiente'`, [o.id, newTotal]);
    }
    await emit(t, 'substitution.responded', o.id, { orderId: o.id, accepted: accept });
    return { accepted: accept };
  });
}

export async function returnInspection(a: AuthCtx, orderId: string, input: { restockSellable: boolean; notes: string }) {
  return tx(async (t) => {
    const o = await lockMerchantOrder(t, a, orderId);
    if (o.delivery_status !== 'retorno_pendiente') throw new BizError('INVALID_STATE', 'El pedido no está en retorno', 409);
    await inspectReturn(t, o.id, input.restockSellable, input.notes, a.userId);
    await transition(t, o, 'delivery', 'devuelto', 'merchant', { userId: a.userId, reason: input.notes });
    await t.q(`UPDATE deliveries SET status = 'ended', ended_at = now(), end_reason = 'devuelto al comercio' WHERE order_id = $1 AND status = 'active'`, [o.id]);
    if (o.commercial_status === 'listo_para_recojo') {
      await transition(t, o, 'commercial', 'cancelado', 'system', { reason: 'Pedido devuelto; resolución económica por soporte', extraSet: { cancelled_at: new Date(), cancel_reason: 'devuelto' } });
    }
    await audit(t, a, 'order.return_inspected', 'order', o.id, input.notes, { restockSellable: input.restockSellable });
    return { returned: true };
  });
}

// ======================= Catálogo del comercio =======================

export async function catalog(a: AuthCtx, branchId: string) {
  await branchAccess(a, branchId);
  const products = await loadProducts(branchId, { includeRestricted: true, onlyActive: false });
  const skus = await db.q(
    `SELECT s.id, s.name, s.unit, s.contains_alcohol, i.on_hand, i.reserved FROM skus s JOIN inventory i ON i.sku_id = s.id WHERE s.branch_id = $1 ORDER BY s.name`,
    [branchId],
  );
  const categories = await db.q(`SELECT id, name, kind FROM categories WHERE branch_id = $1 ORDER BY sort, name`, [branchId]);
  return { products, skus: skus.map((s) => ({ id: s.id, name: s.name, unit: s.unit, containsAlcohol: s.contains_alcohol, onHand: s.on_hand, reserved: s.reserved, available: s.on_hand - s.reserved })), categories };
}

export async function createProduct(a: AuthCtx, branchId: string, input: ProductInput) {
  const { isOwner } = await branchAccess(a, branchId);
  void isOwner;
  return tx(async (t) => {
    const cat = await t.maybe(`SELECT kind FROM categories WHERE id = $1 AND branch_id = $2`, [input.categoryId, branchId]);
    if (!cat) throw new BizError('NOT_FOUND', 'Categoría no encontrada', 404);
    const alcohol = input.containsAlcohol || cat.kind === 'alcohol';
    if (alcohol) {
      const b = await t.one(`SELECT sells_alcohol, alcohol_permit_status FROM branches WHERE id = $1`, [branchId]);
      if (!b.sells_alcohol || b.alcohol_permit_status !== 'approved') throw new BizError('ALCOHOL_PERMIT', 'La sucursal no tiene habilitación aprobada para alcohol', 422);
    }
    const p = await t.one(
      `INSERT INTO products(branch_id, category_id, name, description, kind, image_url, contains_alcohol, minimum_age) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [branchId, input.categoryId, input.name, input.description, input.kind, input.imageUrl ?? null, alcohol, alcohol ? (input.minimumAge ?? 18) : null],
    );
    for (const [i, v] of input.variants.entries()) {
      let skuId: string | null = null;
      if (input.kind === 'stock') {
        if (!v.unit) throw new BizError('UNIT_REQUIRED', 'Los artículos con inventario requieren una unidad explícita', 422);
        const s = await t.one(`INSERT INTO skus(branch_id, name, unit, contains_alcohol, minimum_age) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [branchId, `${input.name} ${v.name}`.trim(), v.unit, alcohol, alcohol ? (input.minimumAge ?? 18) : null]);
        await t.q(`INSERT INTO inventory(sku_id, on_hand) VALUES ($1,$2)`, [s.id, v.initialStock ?? 0]);
        skuId = s.id;
      }
      await t.q(`INSERT INTO product_variants(product_id, name, price_cents, sku_id, sort) VALUES ($1,$2,$3,$4,$5)`, [p.id, v.name, v.priceCents, skuId, i]);
    }
    await audit(t, a, 'product.created', 'product', p.id, null);
    return { productId: p.id };
  });
}

export async function patchProduct(a: AuthCtx, productId: string, input: { name?: string; description?: string; active?: boolean; priceByVariant?: Record<string, number> }) {
  const p = await db.maybe(`SELECT branch_id FROM products WHERE id = $1`, [productId]);
  if (!p) throw new BizError('NOT_FOUND', 'Producto no encontrado', 404);
  await branchAccess(a, p.branch_id);
  return tx(async (t) => {
    await t.q(`UPDATE products SET name = coalesce($2, name), description = coalesce($3, description), active = coalesce($4, active), updated_at = now() WHERE id = $1`, [productId, input.name ?? null, input.description ?? null, input.active ?? null]);
    // Los pedidos confirmados conservan su fotografía de precios: este cambio no los altera.
    for (const [vid, price] of Object.entries(input.priceByVariant ?? {})) {
      const r = await t.q(`UPDATE product_variants SET price_cents = $3 WHERE id = $1 AND product_id = $2 RETURNING id`, [vid, productId, price]);
      if (!r.length) throw new BizError('NOT_FOUND', 'Variante no encontrada', 404);
    }
    await audit(t, a, 'product.updated', 'product', productId, null, input as any);
    return { updated: true };
  });
}

export async function stockAdjust(a: AuthCtx, skuId: string, input: { delta: number; reason: string }) {
  const s = await db.maybe(`SELECT branch_id FROM skus WHERE id = $1`, [skuId]);
  if (!s) throw new BizError('NOT_FOUND', 'SKU no encontrado', 404);
  await branchAccess(a, s.branch_id);
  return tx((t) => adjustStock(t, skuId, input.delta, input.reason, a.userId));
}

export async function createCombo(a: AuthCtx, branchId: string, input: ComboInput) {
  await branchAccess(a, branchId);
  return tx(async (t) => {
    const cat = await t.maybe(`SELECT id FROM categories WHERE id = $1 AND branch_id = $2`, [input.categoryId, branchId]);
    if (!cat) throw new BizError('NOT_FOUND', 'Categoría no encontrada', 404);
    for (const c of input.components) {
      const vs = await t.q(`SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ANY($1) AND p.branch_id = $2 AND p.kind <> 'combo'`, [c.eligibleVariantIds, branchId]);
      if (vs.length !== new Set(c.eligibleVariantIds).size) throw new BizError('INVALID_COMPONENT', `Variantes inválidas en "${c.label}"`, 422);
    }
    const p = await t.one(
      `INSERT INTO products(branch_id, category_id, name, description, kind, image_url, combo_valid_from, combo_valid_to, combo_daily_start, combo_daily_end, combo_quota_total, combo_per_customer_limit, combo_discount_funded_by)
       VALUES ($1,$2,$3,$4,'combo',$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [branchId, input.categoryId, input.name, input.description, input.imageUrl ?? null, input.validFrom ?? null, input.validTo ?? null, input.dailyStart ?? null, input.dailyEnd ?? null, input.quotaTotal ?? null, input.perCustomerLimit ?? null, input.discountFundedBy],
    );
    await t.q(`INSERT INTO product_variants(product_id, name, price_cents) VALUES ($1,'Combo',$2)`, [p.id, input.priceCents]);
    for (const [i, c] of input.components.entries()) {
      const comp = await t.one(`INSERT INTO combo_components(combo_product_id, label, quantity, sort) VALUES ($1,$2,$3,$4) RETURNING id`, [p.id, c.label, c.quantity, i]);
      for (const v of c.eligibleVariantIds) await t.q(`INSERT INTO combo_component_options(component_id, variant_id) VALUES ($1,$2)`, [comp.id, v]);
    }
    // La restricción de alcohol se DERIVA de los componentes (vista v_product_restriction).
    const r = await t.one(`SELECT contains_alcohol FROM v_product_restriction WHERE product_id = $1`, [p.id]);
    if (r.contains_alcohol) {
      const b = await t.one(`SELECT sells_alcohol, alcohol_permit_status FROM branches WHERE id = $1`, [branchId]);
      if (!b.sells_alcohol || b.alcohol_permit_status !== 'approved') throw new BizError('ALCOHOL_PERMIT', 'El combo contiene alcohol y la sucursal no está habilitada', 422);
    }
    await audit(t, a, 'combo.created', 'product', p.id, null);
    return { productId: p.id, containsAlcohol: r.contains_alcohol };
  });
}

export async function setHours(a: AuthCtx, branchId: string, hours: { weekday: number; opens: string; closes: string }[]) {
  await branchAccess(a, branchId);
  return tx(async (t) => {
    await t.q(`DELETE FROM branch_hours WHERE branch_id = $1`, [branchId]);
    for (const h of hours) await t.q(`INSERT INTO branch_hours(branch_id, weekday, opens, closes) VALUES ($1,$2,$3,$4)`, [branchId, h.weekday, h.opens, h.closes]);
    await audit(t, a, 'branch.hours_updated', 'branch', branchId, null, { hours });
    return { saved: hours.length };
  });
}

export async function addClosure(a: AuthCtx, branchId: string, input: { startsAt: string; endsAt: string; reason: string }) {
  await branchAccess(a, branchId);
  if (new Date(input.endsAt) <= new Date(input.startsAt)) throw new BizError('INVALID_RANGE', 'Rango inválido', 422);
  const r = await db.one(`INSERT INTO branch_closures(branch_id, starts_at, ends_at, reason) VALUES ($1,$2,$3,$4) RETURNING id`, [branchId, input.startsAt, input.endsAt, input.reason]);
  return { closureId: r.id };
}

export async function pause(a: AuthCtx, branchId: string, input: { paused: boolean; reason: string }) {
  await branchAccess(a, branchId);
  return tx(async (t) => {
    await t.q(`UPDATE branches SET paused = $2, pause_reason = $3 WHERE id = $1`, [branchId, input.paused, input.paused ? input.reason : null]);
    await audit(t, a, input.paused ? 'branch.paused' : 'branch.resumed', 'branch', branchId, input.reason);
    return { paused: input.paused };
  });
}

export async function report(a: AuthCtx, branchId: string, from?: string, to?: string) {
  const { merchantId } = await branchAccess(a, branchId);
  const f = from ? new Date(from) : new Date(Date.now() - 30 * 86400000);
  const tt = to ? new Date(to) : new Date();
  const r = await db.one(
    `SELECT count(*) FILTER (WHERE commercial_status = 'completado')::int AS completed,
            count(*) FILTER (WHERE commercial_status IN ('cancelado','rechazado_comercio'))::int AS cancelled,
            coalesce(sum(subtotal_cents) FILTER (WHERE commercial_status = 'completado'),0)::bigint AS gross_products,
            coalesce(sum(refunded_cents),0)::bigint AS refunded
     FROM orders WHERE branch_id = $1 AND created_at >= $2 AND created_at < $3`,
    [branchId, f, tt],
  );
  const ledger = await db.q(
    `SELECT entry_type, coalesce(sum(l.amount_cents),0)::bigint AS total FROM ledger_entries l JOIN orders o ON o.id = l.order_id
     WHERE l.party_type = 'merchant' AND l.party_id = $1 AND o.branch_id = $2 AND l.created_at >= $3 AND l.created_at < $4 GROUP BY entry_type`,
    [merchantId, branchId, f, tt],
  );
  const settlements = await db.q(`SELECT id, period_start, period_end, total_cents, status FROM settlements WHERE party_type = 'merchant' AND party_id = $1 ORDER BY period_end DESC LIMIT 12`, [merchantId]);
  return {
    period: { from: f.toISOString(), to: tt.toISOString(), timezone: LIMA },
    completedOrders: r.completed,
    cancelledOrders: r.cancelled,
    grossProductsCents: Number(r.gross_products),
    refundedCents: Number(r.refunded),
    ledger: Object.fromEntries(ledger.map((l) => [l.entry_type, Number(l.total)])),
    netCents: ledger.reduce((s, l) => s + Number(l.total), 0),
    settlements,
  };
}

export async function exportCsv(a: AuthCtx, branchId: string, from?: string, to?: string) {
  await branchAccess(a, branchId);
  const f = from ? new Date(from) : new Date(Date.now() - 30 * 86400000);
  const tt = to ? new Date(to) : new Date();
  const rows = await db.q(
    `SELECT number, created_at, commercial_status, payment_status, payment_method, subtotal_cents, discount_cents, total_cents, refunded_cents FROM orders
     WHERE branch_id = $1 AND created_at >= $2 AND created_at < $3 ORDER BY created_at`,
    [branchId, f, tt],
  );
  const header = `# Exportación Aquisito · sucursal ${branchId} · generado ${new Date().toISOString()} · zona horaria ${LIMA} · filtros: desde ${f.toISOString()} hasta ${tt.toISOString()}\n`;
  const cols = 'pedido,fecha_local,estado_comercial,estado_pago,medio,subtotal,descuento,total,reembolsado\n';
  const body = rows
    .map((r) => [r.number, `${localDate(r.created_at, LIMA)} ${r.created_at.toLocaleTimeString('es-PE', { timeZone: LIMA, hour12: false })}`, r.commercial_status, r.payment_status, r.payment_method, (r.subtotal_cents / 100).toFixed(2), (r.discount_cents / 100).toFixed(2), (r.total_cents / 100).toFixed(2), (r.refunded_cents / 100).toFixed(2)].join(','))
    .join('\n');
  await tx((t) => audit(t, a, 'export.merchant_orders', 'branch', branchId, null, { from: f, to: tt }));
  return header + cols + body + '\n';
}

export async function addOperator(a: AuthCtx, branchId: string, email: string) {
  const { isOwner } = await branchAccess(a, branchId);
  if (!isOwner) throw new BizError('FORBIDDEN', 'Solo el propietario invita operadores', 403);
  const u = await db.maybe(`SELECT id FROM users WHERE email = $1 AND status = 'active'`, [email]);
  if (!u) throw new BizError('USER_NOT_FOUND', 'La persona debe crear primero su propia cuenta (no se comparten contraseñas)', 404);
  return tx(async (t) => {
    await t.q(`INSERT INTO memberships(user_id, role, branch_id, granted_by) VALUES ($1,'branch_operator',$2,$3) ON CONFLICT DO NOTHING`, [u.id, branchId, a.userId]);
    await audit(t, a, 'membership.operator_added', 'branch', branchId, null, { userId: u.id });
    return { added: true };
  });
}

export async function ticket(a: AuthCtx, orderId: string) {
  const o = await db.maybe(`SELECT * FROM orders WHERE id = $1`, [orderId]);
  if (!o) throw new BizError('NOT_FOUND', 'Pedido no encontrado', 404);
  await branchAccess(a, o.branch_id);
  const dto = await orderDto(o, 'merchant');
  const lines = dto.lines.filter((l) => !l.removed).map((l) => `${l.quantity} x ${l.name} ${l.variantName}${l.notes ? `\n   Nota: ${l.notes}` : ''}${l.components.map((c) => `\n   - ${c.quantity} ${c.name}`).join('')}`);
  return [`AQUISITO · COMANDA`, `Pedido #${dto.number}  Código recojo: ${dto.pickupCode}`, dto.scheduledFor ? `PROGRAMADO: ${new Date(dto.scheduledFor).toLocaleString('es-PE', { timeZone: LIMA })}` : 'INMEDIATO', dto.containsAlcohol ? '*** CONTIENE ALCOHOL: entrega solo con verificación de edad ***' : '', '', ...lines, '', `Paquetes: ${o.packages}`].filter((x) => x !== null).join('\n');
}
