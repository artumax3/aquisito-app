import {
  CartDto,
  CartItemInput,
  CreateOrderInput,
  distributeDiscount,
  deliveryFee as computeFee,
  ALCOHOL_LEGAL_NOTICES,
  OrderDto,
  QuoteDto,
  QuoteInput,
  localWeekdayMinutes,
  isWithinWeeklyWindows,
} from '@aquisito/contracts';
import { createHash } from 'crypto';
import { config } from '../../config';
import { db, Tx, tx } from '../../db/db';
import { AuthCtx } from '../../common/auth';
import { BizError } from '../../common/errors';
import { emit } from '../../common/audit';
import { decrypt, encrypt, randomDigits, sha256 } from '../../common/crypto';
import { timeToMinutes } from '../../common/time';
import { branchOpenState, feeRuleFor, priceItems, PricingResult } from '../catalog/catalog.service';
import { requireCoverage } from '../geo/geo.service';
import { alcoholSaleCheck, requireRestrictedBuyer } from '../alcohol/alcohol.service';
import { reserve } from '../inventory/inventory.service';
import { routeDistance, travelMinutes } from '../../providers/geo';
import { cancelOrderTx } from './lifecycle';
import { lockOrder } from './state';

// ======================= Carrito =======================

export async function getCart(a: AuthCtx): Promise<CartDto> {
  const c = await db.maybe(`SELECT c.*, b.name AS branch_name FROM carts c LEFT JOIN branches b ON b.id = c.branch_id WHERE c.user_id = $1`, [a.userId]);
  if (!c || !c.branch_id || !c.items.length) return { branchId: null, branchName: null, lines: [], subtotalCents: 0, containsAlcohol: false, problems: [] };
  try {
    const priced = await priceItems(db, c.branch_id, c.items, { auth: a, userId: a.userId });
    return toCartDto(c.branch_id, c.branch_name, priced);
  } catch (e) {
    if (e instanceof BizError && e.code === 'ITEM_NOT_FOUND') {
      // Un producto dejó de existir o el usuario perdió acceso: se retira del carrito y se avisa.
      const idx = (e.details as any)?.index;
      const items = c.items.filter((_: unknown, i: number) => i !== idx);
      await db.q(`UPDATE carts SET items = $2, updated_at = now() WHERE user_id = $1`, [a.userId, JSON.stringify(items)]);
      const dto = await getCart(a);
      dto.problems.unshift('Se retiró un producto que ya no está disponible');
      return dto;
    }
    throw e;
  }
}

function toCartDto(branchId: string, branchName: string, p: PricingResult): CartDto {
  return {
    branchId,
    branchName,
    lines: p.lines.map((l) => ({
      index: l.index,
      productId: l.productId,
      variantId: l.variantId,
      name: l.name,
      variantName: l.variantName,
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents,
      modifiersCents: l.modifiersCents,
      lineTotalCents: l.lineTotalCents,
      modifierOptionIds: l.modifierOptionIds,
      comboSelections: l.comboSelections,
      notes: l.notes,
      containsAlcohol: l.containsAlcohol,
      problem: l.problem,
    })),
    subtotalCents: p.subtotalCents,
    containsAlcohol: p.containsAlcohol,
    problems: p.problems,
  };
}

/** Una sucursal por pedido: cambiar de comercio exige confirmación explícita (replaceOtherBranch). */
export async function putCart(a: AuthCtx, input: { branchId: string; items: CartItemInput[]; replaceOtherBranch: boolean }) {
  const current = await db.maybe(`SELECT branch_id, items FROM carts WHERE user_id = $1`, [a.userId]);
  if (current?.branch_id && current.branch_id !== input.branchId && current.items.length && !input.replaceOtherBranch) {
    throw new BizError('CART_OTHER_BRANCH', 'Tu carrito tiene productos de otro comercio. ¿Deseas reemplazarlo?', 409, { currentBranchId: current.branch_id });
  }
  const b = await db.maybe(`SELECT id FROM branches WHERE id = $1 AND status = 'active'`, [input.branchId]);
  if (!b) throw new BizError('NOT_FOUND', 'Comercio no encontrado', 404);
  // Valida (lanza si hay variantes inexistentes/restringidas); los problemas de stock se muestran.
  if (input.items.length) await priceItems(db, input.branchId, input.items, { auth: a, userId: a.userId });
  await db.q(
    `INSERT INTO carts(user_id, branch_id, items, updated_at) VALUES ($1,$2,$3, now())
     ON CONFLICT (user_id) DO UPDATE SET branch_id = EXCLUDED.branch_id, items = EXCLUDED.items, updated_at = now()`,
    [a.userId, input.branchId, JSON.stringify(input.items)],
  );
  return getCart(a);
}

export async function clearCart(a: AuthCtx) {
  await db.q(`DELETE FROM carts WHERE user_id = $1`, [a.userId]);
  return { cleared: true };
}

// ======================= Franjas programadas =======================

export async function listSlots(branchId: string, days = 2) {
  const b = await db.one(`SELECT b.slot_minutes, b.slot_capacity, b.prep_minutes, c.timezone FROM branches b JOIN cities c ON c.id = b.city_id WHERE b.id = $1`, [branchId]);
  const hours = await db.q(`SELECT weekday, opens::text AS o, closes::text AS c FROM branch_hours WHERE branch_id = $1`, [branchId]);
  const windows = hours.map((h) => ({ weekday: h.weekday, opens: timeToMinutes(h.o), closes: timeToMinutes(h.c) }));
  const step = b.slot_minutes * 60000;
  const earliest = Date.now() + (b.prep_minutes + 30) * 60000;
  const start = Math.ceil(earliest / step) * step;
  const bookings = await db.q(`SELECT slot_start, booked, capacity FROM scheduled_slot_bookings WHERE branch_id = $1 AND slot_start >= now()`, [branchId]);
  const out: { start: string; end: string; available: number }[] = [];
  for (let ts = start; ts < Date.now() + days * 86400000 && out.length < 96; ts += step) {
    const { weekday, minutes } = localWeekdayMinutes(new Date(ts), b.timezone);
    if (!isWithinWeeklyWindows(windows, weekday, minutes)) continue;
    const bk = bookings.find((x) => x.slot_start.getTime() === ts);
    const available = (bk?.capacity ?? b.slot_capacity) - (bk?.booked ?? 0);
    out.push({ start: new Date(ts).toISOString(), end: new Date(ts + step).toISOString(), available: Math.max(0, available) });
  }
  return out;
}

// ======================= Cotización =======================

interface Computed {
  priced: PricingResult;
  branch: any;
  address: any;
  coverage: Awaited<ReturnType<typeof requireCoverage>>;
  rule: any;
  route: { meters: number; method: 'route' | 'approx_haversine' };
  etaMin: number;
  etaMax: number;
  deliveryFee: number;
  serviceFee: number;
  surcharge: number;
  discount: number;
  productDiscount: number;
  coupon: any | null;
  courierPay: number;
  total: number;
  scheduledSlotStart: Date | null;
}

async function evaluateCoupon(t: Tx, code: string, ctx: { userId: string; cityId: string; merchantId: string; kinds: Set<string>; subtotal: number; deliveryFee: number; at: Date }) {
  const c = await t.maybe(`SELECT * FROM coupons WHERE code = $1 AND active`, [code.toUpperCase()]);
  const no = (m: string) => new BizError('COUPON_INVALID', m, 422);
  if (!c) throw no('Cupón no válido');
  if (c.starts_at > ctx.at || c.ends_at < ctx.at) throw no('El cupón no está vigente');
  if (c.city_id && c.city_id !== ctx.cityId) throw no('El cupón no aplica en esta ciudad');
  if (c.merchant_id && c.merchant_id !== ctx.merchantId) throw no('El cupón no aplica a este comercio');
  if (c.category_kind && !ctx.kinds.has(c.category_kind)) throw no('El cupón no aplica a estos productos');
  if (ctx.subtotal < c.min_subtotal_cents) throw no(`Compra mínima para el cupón: S/ ${(c.min_subtotal_cents / 100).toFixed(2)}`);
  if (c.uses_count >= c.max_uses || c.budget_used_cents >= c.budget_cents) throw no('El cupón alcanzó su límite');
  const used = await t.one(`SELECT count(*)::int AS n FROM coupon_redemptions WHERE coupon_id = $1 AND user_id = $2 AND status = 'active'`, [c.id, ctx.userId]);
  if (used.n >= c.per_user_limit) throw no('Ya usaste este cupón');
  let productDiscount = 0;
  let deliveryDiscount = 0;
  if (c.discount_type === 'percent') productDiscount = Math.floor((ctx.subtotal * c.value) / 100);
  if (c.discount_type === 'fixed') productDiscount = c.value;
  if (c.discount_type === 'free_delivery') deliveryDiscount = ctx.deliveryFee;
  if (c.max_discount_cents != null) {
    productDiscount = Math.min(productDiscount, c.max_discount_cents);
    deliveryDiscount = Math.min(deliveryDiscount, c.max_discount_cents);
  }
  productDiscount = Math.min(productDiscount, ctx.subtotal); // nunca total negativo
  deliveryDiscount = Math.min(deliveryDiscount, ctx.deliveryFee);
  const remainingBudget = c.budget_cents - c.budget_used_cents;
  const total = Math.min(productDiscount + deliveryDiscount, remainingBudget);
  if (total < productDiscount + deliveryDiscount) {
    productDiscount = Math.min(productDiscount, total);
    deliveryDiscount = total - productDiscount;
  }
  return { coupon: c, productDiscount, deliveryDiscount };
}

async function compute(t: Tx, a: AuthCtx, input: { addressId: string; paymentMethod: string; tipCents: number; couponCode?: string; scheduledSlotStart?: string }, items: CartItemInput[], branchId: string): Promise<Computed> {
  const now = new Date();
  const address = await t.maybe(`SELECT *, ST_Y(location) AS lat, ST_X(location) AS lng FROM addresses WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [input.addressId, a.userId]);
  if (!address) throw new BizError('NOT_FOUND', 'Dirección no encontrada', 404);
  const branch = await t.one(
    `SELECT b.*, ST_Y(b.location) AS lat, ST_X(b.location) AS lng, c.service_fee_cents, c.cash_max_cents, c.alcohol_cash_allowed, c.timezone
     FROM branches b JOIN cities c ON c.id = b.city_id WHERE b.id = $1`,
    [branchId],
  );
  if (branch.city_id !== address.city_id) throw new BizError('CROSS_CITY', 'El comercio y la dirección están en ciudades distintas. Los pedidos no se envían entre ciudades.', 422);
  const coverage = await requireCoverage(address.city_id, address.lat, address.lng, now, t);
  if (!items.length) throw new BizError('CART_EMPTY', 'Tu carrito está vacío', 422);

  let scheduled: Date | null = null;
  if (input.scheduledSlotStart) {
    scheduled = new Date(input.scheduledSlotStart);
    const slots = await listSlots(branchId);
    const slot = slots.find((s) => new Date(s.start).getTime() === scheduled!.getTime());
    if (!slot) throw new BizError('SLOT_INVALID', 'La franja elegida no está disponible', 422);
    if (slot.available <= 0) throw new BizError('SLOT_FULL', 'La franja elegida está completa', 409);
    const open = await branchOpenState(branchId, scheduled, t);
    if (!open.isOpen) throw new BizError('STORE_CLOSED', `El comercio estará cerrado en esa franja: ${open.reason}`, 422);
  } else {
    const open = await branchOpenState(branchId, now, t);
    if (!open.isOpen) throw new BizError('STORE_CLOSED', `El comercio está cerrado: ${open.reason}`, 422);
  }

  const priced = await priceItems(t, branchId, items, { auth: a, userId: a.userId, at: scheduled ?? now });
  if (priced.problems.length) throw new BizError('CART_PROBLEMS', 'Revisa tu carrito', 422, { problems: priced.problems });

  const rule = await feeRuleFor(t, branch.city_id, coverage.zoneId, branchId);
  if (!rule) throw new BizError('NO_FEE_RULE', 'No hay tarifa de reparto configurada para esta zona', 422);
  const route = await routeDistance({ lat: branch.lat, lng: branch.lng }, { lat: address.lat, lng: address.lng });
  if (route.meters > rule.max_distance_meters) throw new BizError('TOO_FAR', 'La dirección supera la distancia máxima de reparto de este comercio', 422);
  if (priced.subtotalCents < rule.min_order_cents) throw new BizError('MIN_ORDER', `Compra mínima: S/ ${(rule.min_order_cents / 100).toFixed(2)}`, 422);

  const deliveryFee = computeFee({ baseFeeCents: rule.base_fee_cents, includedMeters: rule.included_meters, perKmCents: rule.per_km_cents, surchargeCents: 0 }, route.meters);
  const surcharge = rule.surcharge_cents;
  const serviceFee = branch.service_fee_cents;
  const travel = travelMinutes(route);
  const etaMin = branch.prep_minutes + travel;
  const etaMax = branch.prep_minutes + travel + 15;
  const courierPay = rule.courier_base_pay_cents + Math.ceil((route.meters / 1000) * rule.courier_per_km_cents);

  let coupon = null;
  let productDiscount = 0;
  let deliveryDiscount = 0;
  if (input.couponCode) {
    const ev = await evaluateCoupon(t, input.couponCode, { userId: a.userId, cityId: branch.city_id, merchantId: branch.merchant_id, kinds: priced.categoryKinds, subtotal: priced.subtotalCents, deliveryFee, at: now });
    coupon = ev.coupon;
    productDiscount = ev.productDiscount;
    deliveryDiscount = ev.deliveryDiscount;
  }
  const discount = productDiscount + deliveryDiscount;
  const total = priced.subtotalCents - discount + deliveryFee + serviceFee + surcharge + input.tipCents;
  if (total < 0) throw new BizError('TOTAL_NEGATIVE', 'Total inválido', 422);

  // Medio de pago
  const pm = input.paymentMethod;
  if (pm === 'cash') {
    if (!branch.accepts_cash) throw new BizError('PAYMENT_METHOD', 'Este comercio no acepta efectivo', 422);
    if (total > branch.cash_max_cents) throw new BizError('PAYMENT_METHOD', `El pago en efectivo admite hasta S/ ${(branch.cash_max_cents / 100).toFixed(2)}`, 422);
    if (priced.containsAlcohol && !branch.alcohol_cash_allowed) throw new BizError('PAYMENT_METHOD', 'Los pedidos con alcohol no admiten efectivo en esta ciudad', 422);
  }
  if (pm === 'transfer' && !config().TRANSFER_PAYMENTS_ENABLED) throw new BizError('PAYMENT_METHOD', 'La transferencia no está habilitada', 422);

  // Alcohol: comprador verificado + reglas de venta para ahora/franja y la hora estimada de entrega.
  if (priced.containsAlcohol) {
    await requireRestrictedBuyer(a, priced.minimumAge ?? 18, t);
    const base = scheduled ?? now;
    const check = await alcoholSaleCheck({ branchId, destinationJurisdictionId: coverage.jurisdictionId, instants: [base, new Date(base.getTime() + etaMax * 60000)] }, t);
    if (!check.ok) throw new BizError(check.code, check.message, 422);
  }

  return { priced, branch, address, coverage, rule, route, etaMin, etaMax, deliveryFee, serviceFee, surcharge, discount, productDiscount, coupon, courierPay, total, scheduledSlotStart: scheduled };
}

function quoteDto(q: any, lines: any[]): QuoteDto {
  const breakdown = [
    { label: 'Productos', amountCents: q.subtotal_cents },
    ...(q.discount_cents ? [{ label: 'Descuento', amountCents: -q.discount_cents }] : []),
    { label: q.distance_method === 'route' ? 'Envío' : 'Envío (distancia aproximada)', amountCents: q.delivery_fee_cents },
    ...(q.service_fee_cents ? [{ label: 'Tarifa de servicio', amountCents: q.service_fee_cents }] : []),
    ...(q.surcharge_cents ? [{ label: q.surcharge_label ?? 'Recargo', amountCents: q.surcharge_cents }] : []),
    ...(q.tip_cents ? [{ label: 'Propina (opcional, 100% al repartidor)', amountCents: q.tip_cents }] : []),
  ];
  return {
    id: q.id,
    version: q.version,
    expiresAt: q.expires_at.toISOString(),
    branchId: q.branch_id,
    addressId: q.address_id,
    lines,
    subtotalCents: q.subtotal_cents,
    discountCents: q.discount_cents,
    deliveryFeeCents: q.delivery_fee_cents,
    serviceFeeCents: q.service_fee_cents,
    surchargeCents: q.surcharge_cents,
    surchargeLabel: q.surcharge_label,
    tipCents: q.tip_cents,
    totalCents: q.total_cents,
    distanceMeters: q.distance_meters,
    distanceMethod: q.distance_method,
    etaMinutes: { min: q.eta_min, max: q.eta_max },
    paymentMethod: q.payment_method,
    containsAlcohol: q.contains_alcohol,
    alcoholNotice: q.contains_alcohol
      ? `${ALCOHOL_LEGAL_NOTICES.join('. ')}. Al recibir deberás mostrar tu DNI, carné de extranjería o pasaporte; solo se entrega al comprador verificado. Si la verificación falla, el pedido completo no se entrega y vuelve al comercio para su revisión y reembolso según la política informada.`
      : null,
    couponCode: q.coupon_code ?? null,
    scheduledSlotStart: q.scheduled_slot_start?.toISOString() ?? null,
    breakdown,
  };
}

async function insertQuote(t: Tx, a: AuthCtx, input: any, items: CartItemInput[], c: Computed, version: number) {
  const lines = toCartDto(c.branch.id, c.branch.name, c.priced).lines;
  const q = await t.one(
    `INSERT INTO quotes(user_id, branch_id, city_id, address_id, version, items, lines, request, payment_method, coupon_id, subtotal_cents, discount_cents, delivery_fee_cents,
       service_fee_cents, surcharge_cents, surcharge_label, tip_cents, total_cents, distance_meters, distance_method, eta_min, eta_max, contains_alcohol, minimum_age,
       scheduled_slot_start, fee_rule_id, zone_version_id, courier_pay_cents, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$29,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27, now() + make_interval(mins => $28)) RETURNING *`,
    [a.userId, c.branch.id, c.branch.city_id, c.address.id, version, JSON.stringify(items), JSON.stringify(lines), input.paymentMethod, c.coupon?.id ?? null,
      c.priced.subtotalCents, c.discount, c.deliveryFee, c.serviceFee, c.surcharge, c.rule.surcharge_label, input.tipCents, c.total, c.route.meters, c.route.method,
      c.etaMin, c.etaMax, c.priced.containsAlcohol, c.priced.minimumAge, c.scheduledSlotStart, c.rule.id, c.coverage.zoneVersionId, c.courierPay, config().QUOTE_TTL_MINUTES, JSON.stringify(input)],
  );
  q.coupon_code = c.coupon?.code ?? null;
  q.input = input;
  return quoteDto(q, lines);
}

export async function createQuote(a: AuthCtx, input: QuoteInput): Promise<QuoteDto> {
  const cart = await db.maybe(`SELECT * FROM carts WHERE user_id = $1`, [a.userId]);
  if (!cart?.branch_id || !cart.items.length) throw new BizError('CART_EMPTY', 'Tu carrito está vacío', 422);
  return tx(async (t) => {
    const c = await compute(t, a, input, cart.items, cart.branch_id);
    return insertQuote(t, a, input, cart.items, c, 1);
  });
}

// ======================= Confirmación del pedido =======================

function orderCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(createHash('sha256').update(Math.random().toString() + Date.now()).digest()).slice(0, 6).map((b) => alphabet[b % alphabet.length]).join('');
}

/**
 * Confirma un pedido de forma idempotente (Idempotency-Key + UNIQUE(user_id, idempotency_key) +
 * UNIQUE(quote_id)). Revalida todo en servidor; si algo cambió respecto de la cotización aceptada,
 * NO cobra ni crea: devuelve QUOTE_CHANGED con una nueva versión que el cliente debe aceptar.
 */
export async function createOrder(a: AuthCtx, input: CreateOrderInput, idempotencyKey: string | undefined): Promise<{ order: OrderDto; replayed: boolean }> {
  if (!idempotencyKey || !/^[A-Za-z0-9_-]{8,80}$/.test(idempotencyKey)) throw new BizError('IDEMPOTENCY_KEY_REQUIRED', 'Falta el encabezado Idempotency-Key', 400);
  const prior = await db.maybe(`SELECT id FROM orders WHERE user_id = $1 AND idempotency_key = $2`, [a.userId, idempotencyKey]);
  if (prior) return { order: await getOrder(a, prior.id), replayed: true };
  try {
    const id = await tx(async (t) => {
      // Serializa confirmaciones concurrentes del mismo usuario+clave.
      await t.q(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`order:${a.userId}:${idempotencyKey}`]);
      const again = await t.maybe(`SELECT id FROM orders WHERE user_id = $1 AND idempotency_key = $2`, [a.userId, idempotencyKey]);
      if (again) return again.id as string;
      const q = await t.maybe(`SELECT * FROM quotes WHERE id = $1 AND user_id = $2 FOR UPDATE`, [input.quoteId, a.userId]);
      if (!q) throw new BizError('NOT_FOUND', 'Cotización no encontrada', 404);
      if (q.used_at) {
        const used = await t.maybe(`SELECT id FROM orders WHERE quote_id = $1`, [q.id]);
        throw new BizError('QUOTE_USED', 'Esta cotización ya generó un pedido', 409, { orderId: used?.id });
      }
      if (q.version !== input.quoteVersion) throw new BizError('QUOTE_VERSION', 'La versión de la cotización no coincide', 409);
      if (q.expires_at < new Date()) throw new BizError('QUOTE_EXPIRED', 'La cotización venció. Genera una nueva.', 409);
      if (q.contains_alcohol && !input.alcoholTermsAccepted)
        throw new BizError('ALCOHOL_TERMS_REQUIRED', 'Debes aceptar que mostrarás tu documento al recibir y la política de retorno', 422);
      const qInput = q.request;

      const c = await compute(t, a, qInput, q.items, q.branch_id);
      const changed =
        c.total !== q.total_cents || c.priced.subtotalCents !== q.subtotal_cents || c.deliveryFee !== q.delivery_fee_cents || c.discount !== q.discount_cents || c.priced.containsAlcohol !== q.contains_alcohol;
      if (changed) {
        const nq = await insertQuote(t, a, qInput, q.items, c, q.version + 1);
        await t.q(`UPDATE quotes SET expires_at = now() WHERE id = $1`, [q.id]);
        throw new BizError('QUOTE_CHANGED', 'El total cambió desde tu cotización. Revisa y acepta el nuevo total.', 409, { newQuote: nq });
      }

      const isCash = q.payment_method === 'cash';
      const deadline = isCash ? null : new Date(Date.now() + (q.payment_method === 'transfer' ? 60 : config().PAYMENT_DEADLINE_MINUTES) * 60000);
      const deliveryCode = randomDigits(4);
      const order = await t.one(
        `INSERT INTO orders(code, user_id, branch_id, merchant_id, city_id, quote_id, idempotency_key, address_id, address_line1, address_reference, address_instructions,
           destination, destination_jurisdiction_id, destination_zone_id, contact_phone, payment_method, subtotal_cents, discount_cents, delivery_fee_cents, service_fee_cents,
           surcharge_cents, tip_cents, total_cents, courier_pay_cents, coupon_id, coupon_funded_by, contains_alcohol, minimum_age, alcohol_terms_accepted_at, scheduled_for,
           payment_deadline, prep_minutes, pickup_code, delivery_code_hash, delivery_code_enc, cash_change_for_cents, invoice_type, invoice_doc_type, invoice_doc_number, invoice_name, eta_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, ST_SetSRID(ST_MakePoint($12,$13),4326), $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42)
         RETURNING *`,
        [orderCode(), a.userId, q.branch_id, c.branch.merchant_id, c.branch.city_id, q.id, idempotencyKey, c.address.id,
          [c.address.line1, c.address.number].filter(Boolean).join(' '), c.address.reference, c.address.instructions, c.address.lng, c.address.lat,
          c.coverage.jurisdictionId, c.coverage.zoneId, input.contactPhone ?? null, q.payment_method, q.subtotal_cents, q.discount_cents, q.delivery_fee_cents,
          q.service_fee_cents, q.surcharge_cents, q.tip_cents, q.total_cents, q.courier_pay_cents, q.coupon_id, c.coupon?.funded_by ?? null, q.contains_alcohol, q.minimum_age,
          q.contains_alcohol ? new Date() : null, q.scheduled_slot_start, deadline, c.branch.prep_minutes, randomDigits(6), sha256(`${deliveryCode}`),
          encrypt(deliveryCode), input.cashChangeForCents ?? null, input.invoice.type, input.invoice.docType ?? null, input.invoice.docNumber ?? null, input.invoice.name ?? null,
          new Date(((q.scheduled_slot_start as Date | null)?.getTime() ?? Date.now()) + q.eta_max * 60000)],
      );

      // Líneas con fotografía lógica de precios, descuentos y componentes.
      const lineDiscounts = distributeDiscount(c.priced.lines.map((l) => l.lineTotalCents), c.productDiscount);
      for (const [i, l] of c.priced.lines.entries()) {
        const ol = await t.one(
          `INSERT INTO order_lines(order_id, product_id, variant_id, name, variant_name, product_kind, quantity, unit_price_cents, modifiers_cents, discount_cents, line_total_cents, contains_alcohol, notes, modifiers, sort)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
          [order.id, l.productId, l.variantId, l.name, l.variantName, l.productKind, l.quantity, l.unitPriceCents, l.modifiersCents, lineDiscounts[i], l.lineTotalCents - lineDiscounts[i], l.containsAlcohol, l.notes, JSON.stringify(l.modifiers), i],
        );
        for (const comp of l.components) {
          await t.q(
            `INSERT INTO order_line_components(order_line_id, variant_id, sku_id, name, quantity, unit_reference_cents, contains_alcohol) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [ol.id, comp.variantId, comp.skuId, comp.name, comp.quantity * l.quantity, comp.unitReferenceCents, comp.containsAlcohol],
          );
        }
      }

      // Reservas atómicas (stock agregado), cupón con cupo/presupuesto, franja y cupo de combo.
      await reserve(t, order.id, c.priced.demand, deadline, a.userId);
      if (c.coupon) {
        const ok = await t.maybe(
          `UPDATE coupons SET uses_count = uses_count + 1, budget_used_cents = budget_used_cents + $2
           WHERE id = $1 AND uses_count < max_uses AND budget_used_cents + $2 <= budget_cents RETURNING id`,
          [c.coupon.id, c.discount],
        );
        if (!ok) throw new BizError('COUPON_EXHAUSTED', 'El cupón alcanzó su límite', 409);
        const per = await t.one(`SELECT count(*)::int AS n FROM coupon_redemptions WHERE coupon_id = $1 AND user_id = $2 AND status = 'active'`, [c.coupon.id, a.userId]);
        if (per.n >= c.coupon.per_user_limit) throw new BizError('COUPON_INVALID', 'Ya usaste este cupón', 409);
        await t.q(`INSERT INTO coupon_redemptions(coupon_id, user_id, order_id, amount_cents) VALUES ($1,$2,$3,$4)`, [c.coupon.id, a.userId, order.id, c.discount]);
      }
      if (q.scheduled_slot_start) {
        const ok = await t.maybe(
          `INSERT INTO scheduled_slot_bookings(branch_id, slot_start, booked, capacity) VALUES ($1,$2,1,$3)
           ON CONFLICT (branch_id, slot_start) DO UPDATE SET booked = scheduled_slot_bookings.booked + 1 WHERE scheduled_slot_bookings.booked < scheduled_slot_bookings.capacity RETURNING booked`,
          [q.branch_id, q.scheduled_slot_start, c.branch.slot_capacity],
        );
        if (!ok) throw new BizError('SLOT_FULL', 'La franja se completó', 409);
      }
      for (const [productId, qty] of c.priced.comboUsage) {
        const ok = await t.maybe(
          `UPDATE products SET combo_quota_used = combo_quota_used + $2 WHERE id = $1 AND (combo_quota_total IS NULL OR combo_quota_used + $2 <= combo_quota_total) RETURNING id`,
          [productId, qty],
        );
        if (!ok) throw new BizError('COMBO_QUOTA', 'El cupo del combo se agotó', 409);
      }
      await t.q(`UPDATE quotes SET used_at = now() WHERE id = $1`, [q.id]);
      await t.q(
        `INSERT INTO order_status_history(order_id, cycle, from_status, to_status, actor_user_id, actor_role, order_version) VALUES ($1,'commercial',NULL,'pendiente_confirmacion',$2,'customer',1),($1,'payment',NULL,'pendiente',$2,'customer',1),($1,'delivery',NULL,'sin_asignar',$2,'customer',1)`,
        [order.id, a.userId],
      );
      if (isCash) {
        // Efectivo: el pedido se confirma, pero el pago sigue PENDIENTE hasta el cobro en la entrega.
        await t.q(`INSERT INTO payments(order_id, provider, method, amount_cents, idempotency_key) VALUES ($1,'cash','cash',$2,$3)`, [order.id, order.total_cents, `cash:${order.id}`]);
        const { transition } = await import('./state');
        const locked = await lockOrder(t, order.id);
        await transition(t, locked, 'commercial', 'confirmado', 'system', { reason: 'Pago contra entrega en efectivo', extraSet: { confirmed_at: new Date(), accept_deadline: acceptDeadline(locked, c.branch.accept_timeout_seconds) } });
      }
      await t.q(`DELETE FROM carts WHERE user_id = $1`, [a.userId]);
      await emit(t, 'order.created', order.id, { orderId: order.id });
      return order.id as string;
    });
    return { order: await getOrder(a, id), replayed: false };
  } catch (e: any) {
    if (e?.code === '23505' && /idempotency|quote_id/.test(e?.constraint ?? '')) {
      const o = await db.maybe(`SELECT id FROM orders WHERE user_id = $1 AND idempotency_key = $2`, [a.userId, idempotencyKey]);
      if (o) return { order: await getOrder(a, o.id), replayed: true };
    }
    throw e;
  }
}

export function acceptDeadline(order: any, timeoutSeconds: number): Date {
  if (order.scheduled_for) return new Date(new Date(order.scheduled_for).getTime() - (order.prep_minutes ?? 20) * 60000);
  return new Date(Date.now() + timeoutSeconds * 1000);
}

// ======================= Consulta =======================

export async function orderDto(o: any, viewer: 'customer' | 'merchant' | 'ops'): Promise<OrderDto> {
  const lines = await db.q(`SELECT * FROM order_lines WHERE order_id = $1 ORDER BY sort`, [o.id]);
  const comps = await db.q(`SELECT * FROM order_line_components WHERE order_line_id = ANY($1)`, [lines.map((l) => l.id)]);
  const hist = await db.q(`SELECT * FROM order_status_history WHERE order_id = $1 AND reason IS DISTINCT FROM '__allocations_reverted' ORDER BY id`, [o.id]);
  const courier = await db.maybe(
    `SELECT u.full_name, c.vehicle_type FROM deliveries d JOIN couriers c ON c.user_id = d.courier_id JOIN users u ON u.id = c.user_id WHERE d.order_id = $1 AND d.status = 'active'`,
    [o.id],
  );
  const branch = await db.one(`SELECT name FROM branches WHERE id = $1`, [o.branch_id]);
  const pay = await db.maybe(`SELECT id FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`, [o.id]);
  const subs = await db.q(`SELECT * FROM substitutions WHERE order_id = $1 ORDER BY created_at`, [o.id]);
  const dest = await db.one(`SELECT ST_Y(destination) AS lat, ST_X(destination) AS lng FROM orders WHERE id = $1`, [o.id]);
  return {
    id: o.id,
    number: o.number,
    code: o.code,
    cityId: o.city_id,
    branchId: o.branch_id,
    branchName: branch.name,
    commercialStatus: o.commercial_status,
    deliveryStatus: o.delivery_status,
    paymentStatus: o.payment_status,
    paymentMethod: o.payment_method,
    subtotalCents: o.subtotal_cents,
    discountCents: o.discount_cents,
    deliveryFeeCents: o.delivery_fee_cents,
    serviceFeeCents: o.service_fee_cents,
    surchargeCents: o.surcharge_cents,
    tipCents: o.tip_cents,
    totalCents: o.total_cents,
    refundedCents: o.refunded_cents,
    containsAlcohol: o.contains_alcohol,
    scheduledFor: o.scheduled_for?.toISOString() ?? null,
    createdAt: o.created_at.toISOString(),
    acceptDeadline: o.accept_deadline?.toISOString() ?? null,
    etaAt: o.eta_at?.toISOString() ?? null,
    address: viewer === 'merchant' ? null : { line1: o.address_line1, reference: o.address_reference, lat: dest.lat, lng: dest.lng },
    courier: courier ? { name: courier.full_name.split(' ')[0], vehicleType: courier.vehicle_type } : null,
    lines: lines.map((l) => ({
      id: l.id,
      name: l.name,
      variantName: l.variant_name,
      quantity: l.quantity,
      unitPriceCents: l.unit_price_cents,
      modifiersCents: l.modifiers_cents,
      discountCents: l.discount_cents,
      lineTotalCents: l.line_total_cents,
      containsAlcohol: l.contains_alcohol,
      notes: l.notes,
      components: comps.filter((c) => c.order_line_id === l.id).map((c) => ({ name: c.name, quantity: c.quantity })),
      removed: !!l.removed_at,
    })),
    history: hist.map((h) => ({ cycle: h.cycle, from: h.from_status, to: h.to_status, at: h.created_at.toISOString(), reason: h.reason, actorRole: h.actor_role })),
    version: o.version,
    latestPaymentId: pay?.id ?? null,
    substitutions: subs.map((s) => ({ id: s.id, orderLineId: s.order_line_id, kind: s.kind, status: s.status, note: s.note, priceDiffCents: s.price_diff_cents })),
    canCancel: viewer === 'customer' && ['pendiente_confirmacion', 'confirmado'].includes(o.commercial_status),
    canRate: viewer === 'customer' && o.commercial_status === 'completado',
    ...(viewer === 'merchant' ? { pickupCode: o.pickup_code } : {}),
  };
}

export async function getOrder(a: AuthCtx, id: string): Promise<OrderDto> {
  const o = await db.maybe(`SELECT * FROM orders WHERE id = $1 AND user_id = $2`, [id, a.userId]);
  if (!o) throw new BizError('NOT_FOUND', 'Pedido no encontrado', 404);
  return orderDto(o, 'customer');
}

export async function listOrders(a: AuthCtx) {
  const rows = await db.q(`SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [a.userId]);
  return Promise.all(rows.map((o) => orderDto(o, 'customer')));
}

export async function cancelByCustomer(a: AuthCtx, id: string, reason: string) {
  await tx(async (t) => {
    const o = await lockOrder(t, id);
    if (o.user_id !== a.userId) throw new BizError('NOT_FOUND', 'Pedido no encontrado', 404);
    if (!['pendiente_confirmacion', 'confirmado'].includes(o.commercial_status))
      throw new BizError('CANCEL_NOT_ALLOWED', 'El comercio ya aceptó tu pedido. Reporta un problema y soporte lo revisará.', 409);
    await cancelOrderTx(t, o, { to: 'cancelado', actor: 'customer', userId: a.userId, reason });
  });
  return getOrder(a, id);
}

export async function deliveryCode(a: AuthCtx, id: string) {
  const o = await db.maybe(`SELECT delivery_code_enc, delivery_status, contains_alcohol FROM orders WHERE id = $1 AND user_id = $2`, [id, a.userId]);
  if (!o) throw new BizError('NOT_FOUND', 'Pedido no encontrado', 404);
  return {
    code: decrypt(o.delivery_code_enc),
    note: o.contains_alcohol ? 'El código NO reemplaza la verificación de tu documento de identidad al recibir.' : 'Díctalo al repartidor solo cuando recibas tu pedido.',
  };
}

export async function reorder(a: AuthCtx, id: string) {
  const o = await db.maybe(`SELECT * FROM orders WHERE id = $1 AND user_id = $2`, [id, a.userId]);
  if (!o) throw new BizError('NOT_FOUND', 'Pedido no encontrado', 404);
  const q = await db.one(`SELECT items FROM quotes WHERE id = $1`, [o.quote_id]);
  const kept: CartItemInput[] = [];
  for (const it of q.items as CartItemInput[]) {
    try {
      await priceItems(db, o.branch_id, [it], { auth: a });
      kept.push(it);
    } catch {
      /* omitido: ya no disponible */
    }
  }
  const cart = await putCart(a, { branchId: o.branch_id, items: kept, replaceOtherBranch: true });
  return { cart, omitted: (q.items as unknown[]).length - kept.length };
}

/** Ubicación del repartidor SOLO para el comprador, SOLO durante el tramo activo y con marca de desactualizada. */
export async function tracking(a: AuthCtx, id: string) {
  const o = await db.maybe(`SELECT id, delivery_status FROM orders WHERE id = $1 AND user_id = $2`, [id, a.userId]);
  if (!o) throw new BizError('NOT_FOUND', 'Pedido no encontrado', 404);
  const active = ['asignado', 'en_camino_al_comercio', 'recogido', 'en_camino_al_cliente', 'en_destino', 'verificacion_requerida'].includes(o.delivery_status);
  if (!active) return { available: false, lat: null, lng: null, accuracyM: null, recordedAt: null, stale: false };
  const l = await db.maybe(
    `SELECT ST_Y(cl.location) AS lat, ST_X(cl.location) AS lng, cl.accuracy_m, cl.recorded_at FROM deliveries d JOIN courier_locations cl ON cl.courier_id = d.courier_id
     WHERE d.order_id = $1 AND d.status = 'active'`,
    [id],
  );
  if (!l) return { available: false, lat: null, lng: null, accuracyM: null, recordedAt: null, stale: true };
  const stale = Date.now() - new Date(l.recorded_at).getTime() > 2 * 60000;
  return { available: true, lat: l.lat, lng: l.lng, accuracyM: l.accuracy_m, recordedAt: l.recorded_at.toISOString(), stale };
}
