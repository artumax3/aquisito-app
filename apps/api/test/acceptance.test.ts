/**
 * Pruebas de aceptación (sección 23) contra PostgreSQL+PostGIS reales (base aquisito_test).
 * Cada bloque indica el criterio que valida. Las de concurrencia lanzan peticiones simultáneas
 * reales: un mock no demostraría bloqueo de filas ni aislamiento.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { as, cleanup, Client, courierOnline, Ctx, E, expectOk, jobs, key, payCard, placeOrder, setup, teardown, toReadyAndAssigned, variantOf } from './helpers';
import { db } from '../src/db/db';
import { SandboxProvider } from '../src/providers/payments';
import { logSink } from '../src/common/logger';
import { loadConfig, productionConfigProblems } from '../src/config';

let c: Ctx;
let ids: Record<string, string>;
beforeAll(async () => {
  c = await setup();
  ids = c.ids;
});
afterAll(async () => teardown(c));
beforeEach(async () => {
  if (c) await cleanup(c);
});

async function fullDelivery(customer: Client, merchant: Client, courier: Client, orderId: string, courierPt: [number, number]) {
  await courierOnline(courier, courierPt[0], courierPt[1]);
  const { pickupCode } = await toReadyAndAssigned(c, merchant, courier, orderId);
  expectOk(await courier.post(`/courier/deliveries/${orderId}/heading-to-store`));
  expectOk(await courier.post(`/courier/deliveries/${orderId}/pickup`, { pickupCode, packages: 1 }));
  expectOk(await courier.post(`/courier/deliveries/${orderId}/depart`));
  expectOk(await courier.post(`/courier/deliveries/${orderId}/arrive`));
  const code = (await customer.get(`/orders/${orderId}/delivery-code`)).body.code;
  return { code };
}

describe('01/02 circuito completo en cada ciudad', () => {
  it('01 Aguaytía: cliente, comercio, repartidor y admin ven el mismo pedido', async () => {
    const cust = await as(c, E.cAgu);
    const v = await variantOf(ids.branch_sazon, 'Juane de gallina');
    const r = await placeOrder(cust, ids.branch_sazon, [{ variantId: v, quantity: 1 }], { addressId: ids.address_aguaytia, tipCents: 300 });
    expect(r.res.status).toBe(201);
    const orderId = r.res.body.id;
    await payCard(cust, orderId);
    const merchant = await as(c, E.m1);
    const courier = await as(c, E.rAgu1);
    const { code } = await fullDelivery(cust, merchant, courier, orderId, [-9.037, -75.508]);
    expectOk(await courier.post(`/courier/deliveries/${orderId}/deliver`, { deliveryCode: code }));
    const o = (await cust.get(`/orders/${orderId}`)).body;
    expect([o.commercialStatus, o.deliveryStatus, o.paymentStatus]).toEqual(['completado', 'entregado', 'pagado']);
    const inbox = (await merchant.get(`/merchant/branches/${ids.branch_sazon}/orders?scope=history`)).body;
    expect(inbox.some((x: any) => x.id === orderId)).toBe(true);
    const admin = await as(c, E.admin, true);
    const detail = (await admin.get(`/admin/orders/${orderId}`)).body;
    expect(detail.ledger.map((l: any) => l.entry_type)).toEqual(expect.arrayContaining(['customer_payment', 'merchant_sale', 'merchant_commission', 'platform_commission', 'courier_delivery_pay', 'courier_tip']));
    const sale = detail.ledger.find((l: any) => l.entry_type === 'merchant_sale').amount_cents;
    const commission = detail.ledger.find((l: any) => l.entry_type === 'merchant_commission').amount_cents;
    expect(commission).toBe(-Math.round(sale * 0.12));
    const earn = (await courier.get('/courier/earnings')).body;
    expect(earn.tipsCents).toBeGreaterThanOrEqual(300);
  });

  it('02 Tingo María: mismo circuito con su configuración (efectivo)', async () => {
    const cust = await as(c, E.cTgm);
    const v = await variantOf(ids.branch_huallaga, 'Ceviche de doncella');
    const r = await placeOrder(cust, ids.branch_huallaga, [{ variantId: v, quantity: 1 }], { addressId: ids.address_tingo, paymentMethod: 'cash' });
    expect(r.res.status).toBe(201);
    const orderId = r.res.body.id;
    // Efectivo: confirmado pero NO pagado al crear.
    expect([r.res.body.commercialStatus, r.res.body.paymentStatus]).toEqual(['confirmado', 'pendiente']);
    const merchant = await as(c, E.m4);
    const courier = await as(c, E.rTgm1);
    const { code } = await fullDelivery(cust, merchant, courier, orderId, [-9.295, -75.998]);
    const short = await courier.post(`/courier/deliveries/${orderId}/deliver`, { deliveryCode: code, cashCollectedCents: 100 });
    expect(short.body.error.code).toBe('CASH_REQUIRED');
    expectOk(await courier.post(`/courier/deliveries/${orderId}/deliver`, { deliveryCode: code, cashCollectedCents: r.res.body.totalCents + 1000 }));
    const o = (await cust.get(`/orders/${orderId}`)).body;
    expect(o.paymentStatus).toBe('pagado');
    const earn = (await courier.get('/courier/earnings')).body;
    expect(earn.cashHeldCents).toBe(o.totalCents);
  });
});

describe('03 cobertura y ciudades', () => {
  it('rechaza dirección fuera del polígono', async () => {
    const cust = await as(c, E.cAgu);
    const v = await variantOf(ids.branch_sazon, 'Inchicapi');
    const r = await placeOrder(cust, ids.branch_sazon, [{ variantId: v, quantity: 1 }], { addressId: ids.address_fuera });
    expect(r.stage).toBe('quote');
    expect(r.res.body.error.code).toBe('OUT_OF_COVERAGE');
  });
  it('rechaza pedido entre ciudades', async () => {
    const cust = await as(c, E.cAgu);
    const v = await variantOf(ids.branch_huallaga, 'Ceviche de doncella');
    const r = await placeOrder(cust, ids.branch_huallaga, [{ variantId: v, quantity: 1 }], { addressId: ids.address_aguaytia });
    expect(r.res.body.error.code).toBe('CROSS_CITY');
  });
  it('detecta punto de otra ciudad en /coverage/check', async () => {
    const r = await new Client(c).post('/coverage/check', { cityId: ids.aguaytia, lat: -9.2962, lng: -75.9962 });
    expect(r.body.code).toBe('OTHER_CITY');
  });
  it('zona suspendida por lluvia bloquea cotización', async () => {
    const disp = await as(c, E.dispTgm);
    const now = Date.now();
    expectOk(await disp.post(`/admin/zones/${ids.zoneCastillo}/suspensions`, { reason: 'lluvia', startsAt: new Date(now - 1000).toISOString(), endsAt: new Date(now + 3600000).toISOString() }));
    const r = await new Client(c).post('/coverage/check', { cityId: ids.tingo, lat: -9.28, lng: -76.04 });
    expect(r.body.code).toBe('ZONE_SUSPENDED');
    // El despachador de Tingo no puede suspender zonas de Aguaytía.
    const other = await disp.post(`/admin/zones/${ids.zoneAguaytia}/suspensions`, { reason: 'lluvia', startsAt: new Date(now).toISOString(), endsAt: new Date(now + 1000).toISOString() });
    expect(other.status).toBe(404);
  });
});

describe('04/05 aislamiento de permisos', () => {
  it('04 un comercio no ve pedidos, catálogo ni reportes de otro', async () => {
    const m1 = await as(c, E.m1);
    for (const p of [`/merchant/branches/${ids.branch_frontera}/orders`, `/merchant/branches/${ids.branch_frontera}/catalog`, `/merchant/branches/${ids.branch_frontera}/report`, `/merchant/branches/${ids.branch_frontera}/export.csv`]) {
      expect((await m1.get(p)).status).toBe(404);
    }
    const anyFrontera = await db.maybe(`SELECT id FROM orders WHERE branch_id = $1 LIMIT 1`, [ids.branch_frontera]);
    const cust = await as(c, E.cAgu);
    const r = await placeOrder(cust, ids.branch_frontera, [{ variantId: ids.gaseosa_variant, quantity: 1 }], { addressId: ids.address_aguaytia, paymentMethod: 'cash' });
    expect((await m1.post(`/merchant/orders/${r.res.body.id}/accept`)).status).toBe(404);
    expect((await m1.get(`/merchant/orders/${r.res.body.id}/ticket`)).status).toBe(404);
    void anyFrontera;
    // El operador de la sucursal sí puede (cuenta propia, no contraseña compartida).
    const op = await as(c, E.op);
    expect((await op.post(`/merchant/orders/${r.res.body.id}/accept`)).status).toBe(200);
    // Un cliente no accede a rutas de comercio.
    expect((await cust.get(`/merchant/branches/${ids.branch_frontera}/orders`)).status).toBe(403);
  });

  it('05 un repartidor no ve el domicilio de pedidos ajenos ni puede cerrarlos', async () => {
    const cust = await as(c, E.cAgu);
    const v = await variantOf(ids.branch_sazon, 'Limonada');
    const r = await placeOrder(cust, ids.branch_sazon, [{ variantId: v, quantity: 1 }], { addressId: ids.address_aguaytia });
    const orderId = r.res.body.id;
    await payCard(cust, orderId);
    const merchant = await as(c, E.m1);
    const r1 = await as(c, E.rAgu1);
    const r2 = await as(c, E.rAgu2);
    await courierOnline(r1, -9.037, -75.508);
    await r2.put('/courier/availability', { available: false });
    // Antes de aceptar, la oferta no expone datos del cliente.
    await merchant.post(`/merchant/orders/${orderId}/accept`);
    await jobs(['autoDispatch']);
    const offers = (await r1.get('/courier/offers')).body;
    const offer = offers.find((o: any) => o.orderId === orderId);
    expect(JSON.stringify(offer)).not.toMatch(/Calle Demo|Carla|\+51/);
    expectOk(await r1.post(`/courier/offers/${offer.id}/accept`));
    // r2 no puede operar ni ver la entrega de r1.
    expect((await r2.post(`/courier/deliveries/${orderId}/arrive`)).status).toBe(404);
    expect((await r2.post(`/courier/deliveries/${orderId}/deliver`, { deliveryCode: '0000' })).status).toBe(404);
    expect(JSON.stringify((await r2.get('/courier/deliveries/current')).body)).not.toContain(orderId);
    expect((await r2.get(`/orders/${orderId}`)).status).toBe(404);
    // Liberar para no bloquear al repartidor en otras pruebas.
    expectOk(await r1.post(`/courier/deliveries/${orderId}/release`, { reason: 'prueba de permisos' }));
    const admin = await as(c, E.admin, true);
    expectOk(await admin.post(`/admin/orders/${orderId}/cancel`, { reason: 'limpieza de prueba' }));
  });
});

describe('06 precios calculados en servidor', () => {
  it('ignora precios y totales enviados por el cliente', async () => {
    const cust = await as(c, E.cAgu);
    const v = await variantOf(ids.branch_sazon, 'Patarashca de pescado');
    const cart = await cust.put('/cart', { branchId: ids.branch_sazon, items: [{ variantId: v, quantity: 1, priceCents: 1, unitPriceCents: 1 }], replaceOtherBranch: true });
    expect(cart.body.subtotalCents).toBe(2400);
    const q = await cust.post('/checkout/quotes', { addressId: ids.address_aguaytia, paymentMethod: 'card', tipCents: 0, totalCents: 1 });
    expect(q.body.totalCents).toBe(2400 + 400 + 100);
    // Cambio de precio después de cotizar: se exige nueva aceptación (QUOTE_CHANGED), sin crear pedido.
    await db.q(`UPDATE product_variants SET price_cents = 2600 WHERE id = $1`, [v]);
    const o = await cust.post('/orders', { quoteId: q.body.id, quoteVersion: 1 }, { 'idempotency-key': key() });
    expect(o.status).toBe(409);
    expect(o.body.error.code).toBe('QUOTE_CHANGED');
    expect(o.body.error.details.newQuote.totalCents).toBe(2600 + 500);
    expect(o.body.error.details.newQuote.version).toBe(2);
    await db.q(`UPDATE product_variants SET price_cents = 2400 WHERE id = $1`, [v]);
  });
});

describe('07/08/09 inventario', () => {
  it('07 dos compradores por la última unidad: sin sobreventa', async () => {
    await db.q(`UPDATE inventory SET on_hand = reserved + 1 WHERE sku_id = $1`, [ids.leche_sku]);
    const leche = await variantOf(ids.branch_frontera, 'Leche evaporada 400 g');
    const a1 = await as(c, E.cAgu);
    const a2 = await as(c, E.cRev);
    const prep = async (cl: Client, addr: string) => {
      await cl.put('/cart', { branchId: ids.branch_frontera, items: [{ variantId: leche, quantity: 1 }], replaceOtherBranch: true });
      return (await cl.post('/checkout/quotes', { addressId: addr, paymentMethod: 'card', tipCents: 0 })).body;
    };
    const revAddr = (await db.one(`SELECT id FROM addresses WHERE user_id = $1 LIMIT 1`, [ids.customer_revocado])).id;
    const [q1, q2] = await Promise.all([prep(a1, ids.address_aguaytia), prep(a2, revAddr)]);
    const [o1, o2] = await Promise.all([
      a1.post('/orders', { quoteId: q1.id, quoteVersion: 1 }, { 'idempotency-key': key() }),
      a2.post('/orders', { quoteId: q2.id, quoteVersion: 1 }, { 'idempotency-key': key() }),
    ]);
    expect([o1.status, o2.status].filter((s) => s === 201).length).toBe(1);
    const loser = o1.status === 201 ? o2 : o1;
    // Según el instante, el perdedor falla en la revalidación (CART_PROBLEMS) o en la reserva atómica (OUT_OF_STOCK).
    expect(['OUT_OF_STOCK', 'CART_PROBLEMS']).toContain(loser.body.error.code);
    const inv = await db.one(`SELECT on_hand, reserved FROM inventory WHERE sku_id = $1`, [ids.leche_sku]);
    expect(inv.reserved).toBeLessThanOrEqual(inv.on_hand);
  });

  it('08 SKU individual + dentro de combo descuenta la demanda agregada', async () => {
    await db.q(`UPDATE inventory SET on_hand = reserved + 5 WHERE sku_id = $1`, [ids.gaseosa_sku]);
    const before = await db.one(`SELECT reserved FROM inventory WHERE sku_id = $1`, [ids.gaseosa_sku]);
    const cust = await as(c, E.cNo);
    const addr = (await db.one(`SELECT id FROM addresses WHERE user_id = $1`, [ids.customer_noverificado])).id;
    const comp = await db.q(`SELECT id, label FROM combo_components WHERE combo_product_id = $1 ORDER BY sort`, [ids.combo_refresco_product]);
    const sel = { [comp[0].id]: ids.gaseosa_variant, [comp[1].id]: ids.papas_variant };
    // 2 combos (2 gaseosas c/u = 4) + 1 individual = 5 => exactamente el stock.
    const r = await placeOrder(cust, ids.branch_frontera, [{ variantId: ids.combo_refresco_variant, quantity: 2, comboSelections: sel }, { variantId: ids.gaseosa_variant, quantity: 1 }], { addressId: addr, paymentMethod: 'cash' });
    expect(r.res.status).toBe(201);
    const after = await db.one(`SELECT reserved FROM inventory WHERE sku_id = $1`, [ids.gaseosa_sku]);
    expect(after.reserved - before.reserved).toBe(5);
    // Una unidad más ya no cabe.
    const r2 = await placeOrder(cust, ids.branch_frontera, [{ variantId: ids.gaseosa_variant, quantity: 1 }], { addressId: addr, paymentMethod: 'cash' });
    expect(r2.res.status).toBe(422);
    expect(JSON.stringify(r2.res.body)).toMatch(/Stock insuficiente/);
    // Los componentes del combo quedan fotografiados en el pedido.
    const snap = await db.q(`SELECT c.name, c.quantity FROM order_line_components c JOIN order_lines l ON l.id = c.order_line_id WHERE l.order_id = $1`, [r.res.body.id]);
    expect(snap).toEqual(expect.arrayContaining([expect.objectContaining({ quantity: 4 })]));
    const admin = await as(c, E.admin, true);
    expectOk(await admin.post(`/admin/orders/${r.res.body.id}/cancel`, { reason: 'liberar stock de prueba' }));
    const released = await db.one(`SELECT reserved FROM inventory WHERE sku_id = $1`, [ids.gaseosa_sku]);
    expect(released.reserved).toBe(before.reserved);
  });

  it('09 componente agotado impide comprar el combo aunque la pantalla diga disponible', async () => {
    const cust = await as(c, E.cAgu);
    const comp = await db.q(`SELECT id FROM combo_components WHERE combo_product_id = $1 ORDER BY sort`, [ids.combo_piqueo_product]);
    const sel = { [comp[1].id]: ids.chifles_variant };
    await cust.put('/cart', { branchId: ids.branch_frontera, items: [{ variantId: ids.combo_piqueo_variant, quantity: 1, comboSelections: sel }], replaceOtherBranch: true });
    const q = await cust.post('/checkout/quotes', { addressId: ids.address_aguaytia, paymentMethod: 'card', tipCents: 0 });
    expect(q.status).toBe(201);
    const saved = await db.one(`SELECT on_hand, reserved FROM inventory WHERE sku_id = $1`, [ids.chifles_sku]);
    await db.q(`UPDATE inventory SET on_hand = reserved WHERE sku_id = $1`, [ids.chifles_sku]); // agotado tras cotizar
    const o = await cust.post('/orders', { quoteId: q.body.id, quoteVersion: 1, alcoholTermsAccepted: true }, { 'idempotency-key': key() });
    expect(o.status).toBe(422);
    expect(o.body.error.code).toBe('CART_PROBLEMS');
    await db.q(`UPDATE inventory SET on_hand = $2 WHERE sku_id = $1`, [ids.chifles_sku, saved.on_hand]);
  });
});

describe('10 asignación concurrente', () => {
  it('aceptación del repartidor y asignación manual simultáneas: una sola asignación vigente', async () => {
    const cust = await as(c, E.cAgu);
    const v = await variantOf(ids.branch_sazon, 'Chicha morada');
    const r = await placeOrder(cust, ids.branch_sazon, [{ variantId: v, quantity: 1 }], { addressId: ids.address_aguaytia });
    const orderId = r.res.body.id;
    await payCard(cust, orderId);
    const r1 = await as(c, E.rAgu1);
    const r2 = await as(c, E.rAgu2);
    await courierOnline(r1, -9.037, -75.508);
    await r2.put('/courier/availability', { available: false });
    await jobs(['autoDispatch']);
    const offer = (await r1.get('/courier/offers')).body.find((o: any) => o.orderId === orderId);
    const disp = await as(c, E.dispAgu);
    const [acc, man] = await Promise.all([
      r1.post(`/courier/offers/${offer.id}/accept`),
      disp.post(`/admin/orders/${orderId}/assign`, { courierId: ids.courierAguaytia2, reason: 'prueba de concurrencia' }),
    ]);
    expect([acc.status, man.status].filter((s) => s === 200).length).toBe(1);
    const active = await db.one(`SELECT count(*)::int AS n FROM deliveries WHERE order_id = $1 AND status = 'active'`, [orderId]);
    expect(active.n).toBe(1);
    // Repetir la aceptación no crea otra asignación.
    expect((await r1.post(`/courier/offers/${offer.id}/accept`)).status).toBe(409);
    const admin = await as(c, E.admin, true);
    await admin.post(`/admin/orders/${orderId}/unassign`, { reason: 'limpieza' });
    expectOk(await admin.post(`/admin/orders/${orderId}/cancel`, { reason: 'limpieza' }));
  });
});

describe('11/12/13/14 pagos', () => {
  it('11 doble clic y reintento: un pedido y un intento de pago', async () => {
    const cust = await as(c, E.cAgu);
    const v = await variantOf(ids.branch_sazon, 'Inchicapi');
    await cust.put('/cart', { branchId: ids.branch_sazon, items: [{ variantId: v, quantity: 1 }], replaceOtherBranch: true });
    const q = (await cust.post('/checkout/quotes', { addressId: ids.address_aguaytia, paymentMethod: 'card', tipCents: 0 })).body;
    const k = key();
    const results = await Promise.all([1, 2, 3].map(() => cust.post('/orders', { quoteId: q.id, quoteVersion: 1 }, { 'idempotency-key': k })));
    const ids2 = new Set(results.map((r) => r.body.id));
    expect(ids2.size).toBe(1);
    expect(results.filter((r) => r.status === 201).length).toBe(1);
    const orderId = results[0].body.id;
    // Otro clic con OTRA clave pero la misma cotización: rechazado (cotización ya usada).
    const other = await cust.post('/orders', { quoteId: q.id, quoteVersion: 1 }, { 'idempotency-key': key() });
    expect(other.body.error.code).toBe('QUOTE_USED');
    const pk = key();
    const pays = await Promise.all([1, 2, 3].map(() => cust.post('/payments', { orderId }, { 'idempotency-key': pk })));
    expect(new Set(pays.map((p) => p.body.id)).size).toBe(1);
    const pays2 = await cust.post('/payments', { orderId }, { 'idempotency-key': key() });
    expect(pays2.body.id).toBe(pays[0].body.id); // pago vivo existente, no un segundo cargo
    const n = await db.one(`SELECT count(*)::int AS n FROM payments WHERE order_id = $1`, [orderId]);
    expect(n.n).toBe(1);
  });

  it('12 webhook repetido, manipulado o fuera de orden', async () => {
    const cust = await as(c, E.cAgu);
    const v = await variantOf(ids.branch_sazon, 'Ensalada de chonta');
    const r = await placeOrder(cust, ids.branch_sazon, [{ variantId: v, quantity: 1 }], { addressId: ids.address_aguaytia });
    const orderId = r.res.body.id;
    const p = (await cust.post('/payments', { orderId }, { 'idempotency-key': key() })).body;
    const pay = await db.one(`SELECT provider_reference FROM payments WHERE id = $1`, [p.id]);
    const anon = new Client(c);
    // Manipulado: firma inválida
    const { body } = await SandboxProvider.settle(pay.provider_reference, 'paid');
    expect((await anon.post('/webhooks/payments/sandbox', JSON.parse(body), { 'x-sandbox-signature': 'deadbeef' })).status).toBe(401);
    // Importe alterado con firma recalculada por un atacante sin el secreto: imposible; probamos importe distinto firmado correctamente (proveedor reporta otro monto).
    const tampered = JSON.parse(body);
    tampered.id = 'evt_tampered';
    tampered.data.amount = 1;
    const tBody = JSON.stringify(tampered);
    const res1 = await anon.post('/webhooks/payments/sandbox', tampered, { 'x-sandbox-signature': SandboxProvider.sign(tBody), 'content-type': 'application/json' });
    expect(res1.body.outcome).toBe('mismatch_needs_review');
    // Evento válido, enviado dos veces
    const ok1 = await anon.post('/webhooks/payments/sandbox', JSON.parse(body), { 'x-sandbox-signature': SandboxProvider.sign(body) });
    const ok2 = await anon.post('/webhooks/payments/sandbox', JSON.parse(body), { 'x-sandbox-signature': SandboxProvider.sign(body) });
    expect(ok1.body.outcome).toBe('paid_confirmed');
    expect(ok2.body.duplicate).toBe(true);
    // "failed" llegado después (fuera de orden) no revierte el pago
    const failed = JSON.stringify({ id: 'evt_late_fail', type: 'charge.failed', created_at: new Date(Date.now() - 60000).toISOString(), data: { reference: pay.provider_reference, amount: r.res.body.totalCents, currency: 'PEN', status: 'failed' } });
    const f = await anon.post('/webhooks/payments/sandbox', JSON.parse(failed), { 'x-sandbox-signature': SandboxProvider.sign(failed) });
    expect(f.body.outcome).toBe('already_applied');
    const o = (await cust.get(`/orders/${orderId}`)).body;
    expect([o.commercialStatus, o.paymentStatus]).toEqual(['confirmado', 'pagado']);
    const ledger = await db.one(`SELECT count(*)::int AS n FROM ledger_entries WHERE order_id = $1 AND entry_type = 'customer_payment'`, [orderId]);
    expect(ledger.n).toBe(1);
  });

  it('13 respuesta incierta: se concilia antes de cualquier nuevo cargo', async () => {
    const cust = await as(c, E.cAgu);
    const v = await variantOf(ids.branch_sazon, 'Pollo a la brasa 1/4');
    const r = await placeOrder(cust, ids.branch_sazon, [{ variantId: v, quantity: 1 }], { addressId: ids.address_aguaytia });
    const orderId = r.res.body.id;
    SandboxProvider.failNextCreateWithTimeout = true;
    const p = (await cust.post('/payments', { orderId }, { 'idempotency-key': key() })).body;
    expect(p.status).toBe('en_conciliacion');
    // Reintento del cliente: NO crea otro cargo.
    const again = (await cust.post('/payments', { orderId }, { 'idempotency-key': key() })).body;
    expect(again.id).toBe(p.id);
    expect((await db.one(`SELECT count(*)::int AS n FROM sandbox_provider_charges WHERE payment_id = $1`, [p.id])).n).toBe(1);
    // El proveedor sí cobró: la conciliación lo descubre.
    const ref = (await db.one(`SELECT reference FROM sandbox_provider_charges WHERE payment_id = $1`, [p.id])).reference;
    await db.q(`UPDATE sandbox_provider_charges SET status = 'paid' WHERE reference = $1`, [ref]);
    const fin = await as(c, E.finance, true);
    const rec = (await fin.post('/admin/payments/reconcile')).body;
    expect(rec.find((x: any) => x.paymentId === p.id)?.result).toBe('paid_confirmed');
    expect((await cust.get(`/orders/${orderId}`)).body.paymentStatus).toBe('pagado');
  });

  it('14 pago recibido después del vencimiento: devolución automática', async () => {
    const cust = await as(c, E.cAgu);
    const v = await variantOf(ids.branch_sazon, 'Arroz chaufa amazónico');
    const r = await placeOrder(cust, ids.branch_sazon, [{ variantId: v, quantity: 1 }], { addressId: ids.address_aguaytia });
    const orderId = r.res.body.id;
    const p = (await cust.post('/payments', { orderId }, { 'idempotency-key': key() })).body;
    await db.q(`UPDATE orders SET payment_deadline = now() - interval '1 minute' WHERE id = $1`, [orderId]);
    await jobs(['expireUnpaid']);
    const expired = (await cust.get(`/orders/${orderId}`)).body;
    expect([expired.commercialStatus, expired.paymentStatus]).toEqual(['cancelado', 'vencido']);
    expect((await db.one(`SELECT count(*)::int AS n FROM inventory_reservations WHERE order_id = $1 AND status = 'active'`, [orderId])).n).toBe(0);
    // Llega el pago tardío
    const sim = (await cust.post(`/dev/payments/${p.id}/simulate`, { outcome: 'paid' })).body;
    expect(sim.webhook.outcome).toBe('late_payment_refund');
    await jobs(['refunds']);
    const o = (await cust.get(`/orders/${orderId}`)).body;
    expect(o.commercialStatus).toBe('cancelado');
    expect(o.paymentStatus).toBe('reembolsado');
    expect(o.refundedCents).toBe(o.totalCents);
  });
});

describe('15–20 alcohol', () => {
  const alcoholItems = () => [{ variantId: ids.cerveza_variant, quantity: 2 }];
  void 0;
  it('15 menor, no verificado y revocado no pueden comprar ni por API directa', async () => {
    for (const email of [E.cMenor, E.cNo, E.cRev]) {
      const cl = await as(c, email);
      const r = await cl.put('/cart', { branchId: ids.branch_frontera, items: alcoholItems(), replaceOtherBranch: true });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('ITEM_NOT_FOUND');
    }
    // Sin sesión tampoco
    const anon = new Client(c);
    expect((await anon.put('/cart', { branchId: ids.branch_frontera, items: alcoholItems() })).status).toBe(401);
    // El cliente no puede auto-aprobarse
    const no = await as(c, E.cNo);
    const self = await no.post(`/admin/age-verifications/${ids.customer_noverificado}/decide`, { decision: 'verified', reason: 'yo mismo', method: 'manual_video' });
    expect(self.status).toBe(403);
    const pending = await no.post('/age-verifications', { documentType: 'dni', documentLast4: '1234', fullNameOnDocument: 'Nora', birthDate: '1999-01-01', consent: true });
    expect(pending.body.status).toBe('pending');
    expect((await no.put('/cart', { branchId: ids.branch_frontera, items: alcoholItems(), replaceOtherBranch: true })).status).toBe(422);
  });

  it('16 la mayoría de edad se calcula por fecha completa en hora de Lima', async () => {
    const admin = await as(c, E.admin, true);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
    const [y, m, d] = today.split('-').map(Number);
    const tomorrow18 = new Date(Date.UTC(y - 18, m - 1, d + 1)).toISOString().slice(0, 10);
    const today18 = `${y - 18}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const u1 = await db.one(`INSERT INTO users(email, full_name) VALUES ('cumple.manana@test.local','Cumple Mañana') RETURNING id`);
    const v1 = await db.one(`INSERT INTO age_verifications(user_id, status, document_type, document_last4, full_name_on_document, birth_date, policy_version) VALUES ($1,'pending','dni','1111','Cumple Mañana',$2,'p') RETURNING id`, [u1.id, tomorrow18]);
    const res1 = await admin.post(`/admin/age-verifications/${v1.id}/decide`, { decision: 'verified', reason: 'revisión', method: 'manual_video' });
    expect(res1.body.error.code).toBe('UNDERAGE');
    const u2 = await db.one(`INSERT INTO users(email, full_name) VALUES ('cumple.hoy@test.local','Cumple Hoy') RETURNING id`);
    const v2 = await db.one(`INSERT INTO age_verifications(user_id, status, document_type, document_last4, full_name_on_document, birth_date, policy_version) VALUES ($1,'pending','dni','2222','Cumple Hoy',$2,'p') RETURNING id`, [u2.id, today18]);
    expect((await admin.post(`/admin/age-verifications/${v2.id}/decide`, { decision: 'verified', reason: 'revisión', method: 'manual_video' })).status).toBe(200);
  });

  it('17 un combo hereda la restricción aunque su categoría sea "ofertas"', async () => {
    const r = await db.one(`SELECT r.contains_alcohol, c.kind FROM v_product_restriction r JOIN products p ON p.id = r.product_id JOIN categories c ON c.id = p.category_id WHERE p.id = $1`, [ids.combo_piqueo_product]);
    expect(r).toEqual({ contains_alcohol: true, kind: 'offers' });
    const no = await as(c, E.cNo);
    const store = (await no.get(`/stores/${ids.branch_frontera}`)).body;
    expect(store.products.some((p: any) => p.id === ids.combo_piqueo_product)).toBe(false);
    expect(store.products.some((p: any) => p.id === ids.combo_refresco_product)).toBe(true);
    const adult = await as(c, E.cAgu);
    const s2 = (await adult.get(`/stores/${ids.branch_frontera}`)).body;
    expect(s2.products.find((p: any) => p.id === ids.combo_piqueo_product)?.containsAlcohol).toBe(true);
  });

  it('18 enlaces directos, búsqueda y notificaciones no filtran contenido restringido', async () => {
    const no = await as(c, E.cNo);
    const cerveza = (await db.one(`SELECT product_id FROM product_variants WHERE id = $1`, [ids.cerveza_variant])).product_id;
    expect((await no.get(`/products/${cerveza}`)).status).toBe(404);
    expect((await new Client(c).get(`/products/${cerveza}`)).status).toBe(404);
    const s = (await no.get(`/search?cityId=${ids.aguaytia}&q=cerveza`)).body;
    expect(s.products.length).toBe(0);
    const adult = await as(c, E.cAgu);
    expect((await adult.get(`/search?cityId=${ids.aguaytia}&q=cerveza`)).body.products.length).toBeGreaterThan(0);
    const notifs = await db.q(`SELECT lockscreen_body FROM notifications`);
    expect(notifs.every((n) => n.lockscreen_body === 'Tienes una novedad en Aquisito')).toBe(true);
  });

  async function alcoholOrderAtDoor() {
    const cust = await as(c, E.cAgu);
    const r = await placeOrder(cust, ids.branch_frontera, alcoholItems(), { addressId: ids.address_aguaytia, alcohol: true });
    if (r.res.status !== 201) throw new Error(JSON.stringify(r.res.body));
    const orderId = r.res.body.id;
    await payCard(cust, orderId);
    const merchant = await as(c, E.m2);
    const courier = await as(c, E.rAgu1);
    const { code } = await fullDelivery(cust, merchant, courier, orderId, [-9.039, -75.506]);
    return { cust, courier, merchant, orderId, code };
  }

  it('19 no se marca entregado sin verificación presencial aprobada', async () => {
    const cust = await as(c, E.cAgu);
    const noTerms = await placeOrder(cust, ids.branch_frontera, alcoholItems(), { addressId: ids.address_aguaytia, alcohol: false });
    expect(noTerms.res.body.error.code).toBe('ALCOHOL_TERMS_REQUIRED');
    const q = noTerms.quote;
    expect(q.alcoholNotice).toMatch(/Prohibida la venta de bebidas alcohólicas a menores de 18 años/);
    const { courier, orderId, code } = await alcoholOrderAtDoor();
    const st = (await cust.get(`/orders/${orderId}`)).body.deliveryStatus;
    expect(st).toBe('verificacion_requerida');
    const d1 = await courier.post(`/courier/deliveries/${orderId}/deliver`, { deliveryCode: code });
    expect(d1.body.error.code).toBe('AGE_CHECK_REQUIRED');
    // Aprobación incompleta (sin documento) no vale
    const bad = await courier.post(`/courier/deliveries/${orderId}/age-check`, { result: 'approved', identityMatchesBuyer: false });
    expect(bad.status).toBe(422);
    expectOk(await courier.post(`/courier/deliveries/${orderId}/age-check`, { result: 'approved', documentType: 'dni', identityMatchesBuyer: true }));
    expectOk(await courier.post(`/courier/deliveries/${orderId}/deliver`, { deliveryCode: code }));
    // El soporte tampoco puede saltarse el control: no existe transición permitida para él.
    const { canTransition, DELIVERY_TRANSITIONS } = await import('@aquisito/contracts');
    expect(canTransition(DELIVERY_TRANSITIONS, 'verificacion_requerida', 'entregado', 'support')).toBe(false);
  });

  it('20 documento ausente: rechazo, incidencia, retorno y resolución económica trazable', async () => {
    const { cust, courier, merchant, orderId } = await alcoholOrderAtDoor();
    expectOk(await courier.post(`/courier/deliveries/${orderId}/age-check`, { result: 'rejected', rejectionReason: 'no_document', identityMatchesBuyer: false }));
    const o = (await cust.get(`/orders/${orderId}`)).body;
    expect(o.deliveryStatus).toBe('retorno_pendiente');
    const inc = await db.one(`SELECT id, kind FROM incidents WHERE order_id = $1`, [orderId]);
    expect(inc.kind).toBe('age_check_failed');
    const check = await db.one(`SELECT result, rejection_reason, courier_id FROM door_age_checks WHERE order_id = $1`, [orderId]);
    expect(check).toEqual({ result: 'rejected', rejection_reason: 'no_document', courier_id: ids.courierAguaytia1 });
    const before = await db.one(`SELECT on_hand FROM inventory WHERE sku_id = $1`, [ids.cerveza_sku]);
    expectOk(await merchant.post(`/merchant/orders/${orderId}/return-inspection`, { restockSellable: true, notes: 'Latas intactas' }));
    const after = await db.one(`SELECT on_hand FROM inventory WHERE sku_id = $1`, [ids.cerveza_sku]);
    expect(after.on_hand - before.on_hand).toBe(2);
    // Repetir la inspección no duplica stock.
    expect((await merchant.post(`/merchant/orders/${orderId}/return-inspection`, { restockSellable: true, notes: 'otra vez' })).status).toBe(409);
    const sup = await as(c, E.support);
    const refundProducts = o.subtotalCents;
    expectOk(await sup.post(`/admin/incidents/${inc.id}/resolve`, { resolution: 'Reembolso de productos según política', refundCents: refundProducts, refundConcept: 'products' }));
    await jobs(['refunds']);
    const fin = (await cust.get(`/orders/${orderId}`)).body;
    expect(fin.refundedCents).toBe(refundProducts);
    expect(fin.paymentStatus).toBe('parcialmente_reembolsado');
    const led = await db.q(`SELECT entry_type, amount_cents FROM ledger_entries WHERE order_id = $1 ORDER BY id`, [orderId]);
    expect(led.map((l) => l.entry_type)).toEqual(['customer_payment', 'customer_refund']);
  });

  it('alcohol: horario, prohibición temporal y jurisdicción sin reglas', async () => {
    const cust = await as(c, E.cAgu);
    await db.q(`INSERT INTO alcohol_blackouts(jurisdiction_id, starts_at, ends_at, reason, source) VALUES ($1, now() - interval '1 minute', now() + interval '1 hour', 'Jornada electoral (prueba)', 'prueba')`, [ids.jAguaytia]);
    const r = await placeOrder(cust, ids.branch_frontera, alcoholItems(), { addressId: ids.address_aguaytia, alcohol: true });
    expect(r.res.body.error.code).toBe('ALCOHOL_BLACKOUT');
    // El interruptor del administrador no anula la prohibición.
    const admin = await as(c, E.admin, true);
    await admin.patch(`/admin/cities/${ids.aguaytia}`, { alcoholEnabled: true, reason: 'intento de anular' });
    const r2 = await placeOrder(cust, ids.branch_frontera, alcoholItems(), { addressId: ids.address_aguaytia, alcohol: true });
    expect(r2.res.body.error.code).toBe('ALCOHOL_BLACKOUT');
    await db.q(`DELETE FROM alcohol_blackouts`);
  });
});

describe('21 horarios locales', () => {
  it('franja que cruza medianoche y cierre especial', async () => {
    const { branchOpenState } = await import('../src/modules/catalog/catalog.service');
    const b = ids.branch_juguera;
    await db.q(`DELETE FROM branch_hours WHERE branch_id = $1`, [b]);
    await db.q(`INSERT INTO branch_hours(branch_id, weekday, opens, closes) VALUES ($1, 5, '18:00', '02:00')`, [b]); // viernes 18:00 → sábado 02:00
    // Sábado 2026-11-07 01:30 Lima = 06:30 UTC
    expect((await branchOpenState(b, new Date('2026-11-07T06:30:00Z'))).isOpen).toBe(true);
    // Sábado 02:30 Lima
    expect((await branchOpenState(b, new Date('2026-11-07T07:30:00Z'))).isOpen).toBe(false);
    // Viernes 17:59 Lima
    expect((await branchOpenState(b, new Date('2026-11-06T22:59:00Z'))).isOpen).toBe(false);
    await db.q(`INSERT INTO branch_closures(branch_id, starts_at, ends_at, reason) VALUES ($1,'2026-11-07T05:00:00Z','2026-11-07T06:00:00Z','Feriado local de prueba')`, [b]);
    const closed = await branchOpenState(b, new Date('2026-11-07T05:30:00Z'));
    expect(closed.reason).toMatch(/Cierre especial/);
    await db.q(`DELETE FROM branch_hours WHERE branch_id = $1`, [b]);
    for (let d = 0; d < 7; d++) await db.q(`INSERT INTO branch_hours(branch_id, weekday, opens, closes) VALUES ($1,$2,'00:00','12:00'),($1,$2,'12:00','00:00')`, [b, d]);
  });

  it('pedido programado con alcohol no puede caer fuera de la ventana', async () => {
    await db.q(`DELETE FROM alcohol_rules WHERE jurisdiction_id = $1`, [ids.jAguaytia]);
    const now = new Date();
    const lima = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Lima', weekday: 'short' }).format(now);
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(lima);
    void wd;
    const cust = await as(c, E.cAgu);
    const slots = (await cust.get(`/stores/${ids.branch_frontera}/slots`)).body;
    expect(slots.length).toBeGreaterThan(0);
    const r = await placeOrder(cust, ids.branch_frontera, [{ variantId: ids.cerveza_variant, quantity: 1 }], { addressId: ids.address_aguaytia, alcohol: true, scheduledSlotStart: slots[0].start });
    expect(r.res.body.error.code).toBe('ALCOHOL_NO_RULES');
    const { allDayAlcoholRules } = await import('./helpers');
    await allDayAlcoholRules();
    const ok = await placeOrder(cust, ids.branch_frontera, [{ variantId: ids.cerveza_variant, quantity: 1 }], { addressId: ids.address_aguaytia, alcohol: true, scheduledSlotStart: slots[0].start, paymentMethod: 'card' });
    expect(ok.res.status).toBe(201);
    expect(ok.res.body.scheduledFor).toBe(slots[0].start);
    const admin = await as(c, E.admin, true);
    await admin.post(`/admin/orders/${ok.res.body.id}/cancel`, { reason: 'limpieza' });
  });
});

describe('22 conectividad', () => {
  it('reconexión: el servidor es la fuente de verdad, sin confirmaciones locales', async () => {
    // El canal realtime solo emite eventos mínimos; el cliente vuelve a consultar.
    const ev = await db.maybe(`SELECT payload FROM outbox_events WHERE topic = 'order.status_changed' LIMIT 1`);
    expect(Object.keys(ev!.payload).sort()).toEqual(['cycle', 'from', 'orderId', 'to', 'version']);
    // Un "entregado" sin código válido (p.ej. reintentado desde caché local) es rechazado.
    const courier = await as(c, E.rAgu1);
    const r = await courier.post(`/courier/deliveries/00000000-0000-4000-8000-000000000000/deliver`, { deliveryCode: '1234' });
    expect(r.status).toBe(404);
  });
});

describe('23/24 cancelaciones, reembolsos y cupones', () => {
  it('23 cancelación del cliente libera reservas y reembolsa una sola vez', async () => {
    await db.q(`UPDATE inventory SET on_hand = reserved + 10 WHERE sku_id = $1`, [ids.gaseosa_sku]);
    const before = await db.one(`SELECT on_hand, reserved FROM inventory WHERE sku_id = $1`, [ids.gaseosa_sku]);
    const cust = await as(c, E.cAgu);
    const r = await placeOrder(cust, ids.branch_frontera, [{ variantId: ids.gaseosa_variant, quantity: 3 }], { addressId: ids.address_aguaytia });
    await payCard(cust, r.res.body.id);
    const [c1, c2] = await Promise.all([cust.post(`/orders/${r.res.body.id}/cancel`, { reason: 'cambié de opinión' }), cust.post(`/orders/${r.res.body.id}/cancel`, { reason: 'doble clic' })]);
    expect([c1.status, c2.status].sort()).toEqual([200, 409]);
    await jobs(['refunds']);
    await jobs(['refunds']);
    const after = await db.one(`SELECT on_hand, reserved FROM inventory WHERE sku_id = $1`, [ids.gaseosa_sku]);
    expect(after).toEqual(before);
    const refunds = await db.q(`SELECT status, amount_cents FROM refunds WHERE order_id = $1`, [r.res.body.id]);
    expect(refunds).toEqual([{ status: 'succeeded', amount_cents: r.res.body.totalCents }]);
    expect((await cust.get(`/orders/${r.res.body.id}`)).body.paymentStatus).toBe('reembolsado');
    // Cancelación después de aceptada: no permitida al cliente.
    const r2 = await placeOrder(cust, ids.branch_frontera, [{ variantId: ids.gaseosa_variant, quantity: 1 }], { addressId: ids.address_aguaytia, paymentMethod: 'cash' });
    const op = await as(c, E.op);
    await op.post(`/merchant/orders/${r2.res.body.id}/accept`);
    expect((await cust.post(`/orders/${r2.res.body.id}/cancel`, { reason: 'tarde' })).body.error.code).toBe('CANCEL_NOT_ALLOWED');
    await op.post(`/merchant/orders/${r2.res.body.id}/reject`, { reason: 'x' }).catch(() => undefined);
  });

  it('24 cupones simultáneos respetan cupo y presupuesto; nunca total negativo', async () => {
    const admin = await as(c, E.admin, true);
    const now = Date.now();
    expectOk(await admin.post('/admin/coupons', { code: 'UNICO', startsAt: new Date(now - 60000).toISOString(), endsAt: new Date(now + 3600000).toISOString(), discountType: 'fixed', value: 100000, budgetCents: 100000, maxUses: 1, perUserLimit: 1, fundedBy: 'platform' }));
    const users = [E.cAgu, E.cNo, E.cRev];
    const clients = await Promise.all(users.map((e) => as(c, e)));
    const addrs = await Promise.all([ids.customer_aguaytia, ids.customer_noverificado, ids.customer_revocado].map(async (u) => (await db.one(`SELECT id FROM addresses WHERE user_id = $1 AND label = 'Casa'`, [u])).id));
    const v = await variantOf(ids.branch_sazon, 'Juane de gallina');
    const quotes = [];
    for (const [i, cl] of clients.entries()) {
      await cl.put('/cart', { branchId: ids.branch_sazon, items: [{ variantId: v, quantity: 1 }], replaceOtherBranch: true });
      const q = await cl.post('/checkout/quotes', { addressId: addrs[i], paymentMethod: 'card', tipCents: 0, couponCode: 'UNICO' });
      expect(q.status).toBe(201);
      // Descuento fijo de S/1000 se limita al subtotal: total = envío + servicio, nunca negativo.
      expect(q.body.discountCents).toBe(q.body.subtotalCents);
      expect(q.body.totalCents).toBeGreaterThanOrEqual(0);
      quotes.push(q.body);
    }
    const res = await Promise.all(clients.map((cl, i) => cl.post('/orders', { quoteId: quotes[i].id, quoteVersion: 1 }, { 'idempotency-key': key() })));
    expect(res.filter((r) => r.status === 201).length).toBe(1);
    const cp = await db.one(`SELECT uses_count, budget_used_cents, budget_cents FROM coupons WHERE code = 'UNICO'`);
    expect(cp.uses_count).toBe(1);
    expect(cp.budget_used_cents).toBeLessThanOrEqual(cp.budget_cents);
  });
});

describe('25 liquidaciones', () => {
  it('se puede recalcular y no incluye dos veces un pedido', async () => {
    const fin = await as(c, E.finance, true);
    const periodStart = new Date(Date.now() - 86400000).toISOString();
    const periodEnd = new Date(Date.now() + 86400000).toISOString();
    const s1 = expectOk(await fin.post('/admin/settlements', { partyType: 'merchant', partyId: ids.merchant_sazon, periodStart, periodEnd })).body;
    expect(s1.consistent).toBe(true);
    expect(s1.items.length).toBeGreaterThan(0);
    const again = (await fin.post('/admin/settlements', { partyType: 'merchant', partyId: ids.merchant_sazon, periodStart, periodEnd })).body;
    expect(again.id).toBe(s1.id);
    // Período solapado: los movimientos ya liquidados no se vuelven a incluir.
    const s2 = (await fin.post('/admin/settlements', { partyType: 'merchant', partyId: ids.merchant_sazon, periodStart: new Date(Date.now() - 2 * 86400000).toISOString(), periodEnd })).body;
    const overlap = s2.items.filter((i: any) => s1.items.some((j: any) => j.id === i.id));
    expect(overlap.length).toBe(0);
    // El libro es inmutable.
    await expect(db.q(`UPDATE ledger_entries SET amount_cents = 0 WHERE id = $1`, [s1.items[0].id])).rejects.toThrow(/inmutable/);
    // Las finanzas exigen MFA: sin elevar la sesión, rechazado.
    const noMfa = await as(c, E.finance, false);
    expect((await noMfa.get('/admin/settlements')).body.error.code).toBe('MFA_REQUIRED');
  });
});

describe('26 datos sensibles fuera de logs y canales', () => {
  it('logs redactan tokens, ubicación y documentos', async () => {
    logSink.capture = true;
    logSink.lines = [];
    const { logger } = await import('../src/common/logger');
    logger.info('prueba', { token: 'secreto', lat: -9.1, lng: -75.5, documentLast4: '1234', phone: '+51999999999', orderId: 'x' });
    const cust = await as(c, E.cAgu);
    await cust.get('/me');
    logSink.capture = false;
    const all = logSink.lines.join('\n');
    expect(all).not.toMatch(/secreto|-9\.1|\+51999999999|1234/);
    expect(all).toContain('[REDACTADO]');
    expect(all).not.toContain(cust.token);
  });
  it('archivos privados solo con enlace firmado y temporal', async () => {
    const cust = await as(c, E.cAgu);
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const up = expectOk(await cust.post('/files', { ownerType: 'incident', contentBase64: png.toString('base64'), purpose: 'evidencia' })).body;
    const other = await as(c, E.cNo);
    expect((await other.get(`/files/${up.id}/url`)).status).toBe(404);
    const url = (await cust.get(`/files/${up.id}/url`)).body.url as string;
    expect((await new Client(c).get(url)).status).toBe(200);
    expect((await new Client(c).get(url.replace(/sig=[0-9a-f]+/, 'sig=00'))).status).toBe(404);
    const exe = await cust.post('/files', { ownerType: 'incident', contentBase64: Buffer.from('MZ\x90\x00').toString('base64') });
    expect(exe.status).toBe(415);
  });
});

describe('27 reclamaciones y derechos ARCO', () => {
  it('reclamación con número correlativo, constancia y fecha de respuesta', async () => {
    const anon = new Client(c);
    const body = { consumerName: 'Ana Pérez', consumerDocType: 'dni', consumerDocNumber: '12345678', consumerEmail: 'ana@test.local', kind: 'reclamo', goodType: 'servicio', detail: 'El pedido llegó incompleto y frío', request: 'Devolución del importe' };
    const r1 = expectOk(await anon.post('/complaints', body)).body;
    const r2 = expectOk(await anon.post('/complaints', body)).body;
    expect(Number(r2.number.split('-')[1])).toBe(Number(r1.number.split('-')[1]) + 1);
    expect(r1.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r1.text).toContain(r1.number);
    expect((await anon.get(`/complaints/${r1.number}?email=otro@test.local`)).status).toBe(404);
    expect((await anon.get(`/complaints/${r1.number}?email=ana@test.local`)).body.status).toBe('pending');
  });
  it('eliminación de cuenta anonimiza y conserva pedidos y movimientos', async () => {
    const u = await db.one(`INSERT INTO users(email, password_hash, full_name) VALUES ('borrar@test.local', (SELECT password_hash FROM users WHERE email = $1), 'Persona Borrable') RETURNING id`, [E.cAgu]);
    const cl = await as(c, 'borrar@test.local');
    const dr = expectOk(await cl.post('/me/data-requests', { kind: 'account_deletion' })).body;
    const admin = await as(c, E.admin, true);
    expectOk(await admin.post(`/admin/data-requests/${dr.id}/process`, { reason: 'Solicitud verificada' }));
    const after = await db.one(`SELECT email, full_name, status FROM users WHERE id = $1`, [u.id]);
    expect(after).toEqual({ email: null, full_name: 'Usuario eliminado', status: 'deleted' });
    expect((await cl.get('/me')).status).toBe(401);
  });
});

describe('30 configuración de producción', () => {
  it('rechaza simuladores, sembrado demo y claves faltantes', () => {
    const prod = loadConfig({ APP_ENV: 'production' } as any);
    const problems = productionConfigProblems(prod);
    expect(problems.join(' | ')).toMatch(/sandbox/);
    expect(problems.join(' | ')).toMatch(/SMS_PROVIDER/);
    expect(problems.join(' | ')).toMatch(/ALLOW_DEMO_SEED/);
    expect(problems.join(' | ')).toMatch(/DATA_ENCRYPTION_KEY/);
    const ok = loadConfig({
      APP_ENV: 'production', PAYMENT_PROVIDERS: 'culqi', CARD_PROVIDER: 'culqi', WALLET_PROVIDER: 'culqi', CULQI_SECRET_KEY: 'sk_x', SMS_PROVIDER: 'twilio', EMAIL_PROVIDER: 'none',
      ALLOW_DEMO_SEED: 'false', DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), COOKIE_SECURE: 'true', STORAGE_DRIVER: 's3',
    } as any);
    expect(productionConfigProblems(ok)).toEqual([]);
  });
  it('en producción solo cuentan reglas de alcohol validadas', async () => {
    const { setConfigForTests, config } = await import('../src/config');
    const { alcoholSaleCheck } = await import('../src/modules/alcohol/alcohol.service');
    const prev = { ...config() };
    setConfigForTests({ isDevLike: false });
    const r = await alcoholSaleCheck({ branchId: ids.branch_frontera, destinationJurisdictionId: ids.jAguaytia, instants: [new Date()] });
    setConfigForTests(prev);
    expect(r.code).toBe('ALCOHOL_NO_RULES');
  });
});

describe('extras: sustituciones, OTP, sesiones, CSRF', () => {
  it('faltante: el comercio propone, el cliente acepta y se reembolsa la diferencia', async () => {
    const cust = await as(c, E.cAgu);
    const v1 = await variantOf(ids.branch_sazon, 'Juane de gallina');
    const v2 = await variantOf(ids.branch_sazon, 'Limonada');
    const r = await placeOrder(cust, ids.branch_sazon, [{ variantId: v1, quantity: 1 }, { variantId: v2, quantity: 1 }], { addressId: ids.address_aguaytia });
    await payCard(cust, r.res.body.id);
    const m = await as(c, E.m1);
    await m.post(`/merchant/orders/${r.res.body.id}/accept`);
    const line = r.res.body.lines.find((l: any) => l.name === 'Limonada');
    const s = expectOk(await m.post(`/merchant/orders/${r.res.body.id}/substitutions`, { orderLineId: line.id, kind: 'remove', note: 'Sin limones' })).body;
    // Sustituir por alcohol no se permite como atajo.
    const alc = await m.post(`/merchant/orders/${r.res.body.id}/substitutions`, { orderLineId: line.id, kind: 'substitute', substituteVariantId: ids.cerveza_variant });
    expect([404, 409, 422]).toContain(alc.status);
    expect((await m.post(`/merchant/orders/${r.res.body.id}/start`)).body.error.code).toBe('SUBSTITUTION_PENDING');
    expectOk(await cust.post(`/orders/${r.res.body.id}/substitutions/${s.substitutionId}/respond`, { accept: true }));
    await jobs(['refunds']);
    const o = (await cust.get(`/orders/${r.res.body.id}`)).body;
    expect(o.refundedCents).toBe(500);
    expect(o.totalCents).toBe(r.res.body.totalCents - 500);
  });

  it('OTP: caducidad, intentos y límite de solicitudes', async () => {
    const { devSms } = await import('../src/providers/messaging');
    const anon = new Client(c);
    const phone = '+51987654321';
    expectOk(await anon.post('/auth/otp/request', { phone }));
    const code = devSms.last!.text.match(/(\d{6})/)![1];
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await anon.post('/auth/otp/verify', { phone, code: wrong, fullName: 'Persona OTP' });
    expect((await anon.post('/auth/otp/verify', { phone, code, fullName: 'Persona OTP' })).body.error.code).toBe('OTP_LOCKED');
    expectOk(await anon.post('/auth/otp/request', { phone }));
    const code2 = devSms.last!.text.match(/(\d{6})/)![1];
    const ok = await anon.post('/auth/otp/verify', { phone, code: code2, fullName: 'Persona OTP' });
    expect(ok.status).toBe(200);
    expectOk(await anon.post('/auth/otp/request', { phone }));
    expect((await anon.post('/auth/otp/request', { phone })).body.error.code).toBe('RATE_LIMITED');
  });

  it('revocar un dispositivo invalida su token; cookie exige CSRF', async () => {
    const a = await as(c, E.cTgm);
    const b = await as(c, E.cTgm);
    const sessions = (await a.get('/auth/sessions')).body;
    const other = sessions.find((s: any) => !s.current);
    expectOk(await a.del(`/auth/sessions/${other.id}`));
    expect([200, 401]).toContain((await b.get('/me')).status);
    const st = (await b.get('/me')).status;
    expect(st).toBe(401);
    const request = (await import('supertest')).default;
    const login = await request(c.http).post('/auth/login').set('x-client', 'web').send({ email: E.cTgm, password: 'Test-Password-123' });
    const cookies = (login.headers['set-cookie'] as unknown as string[]).map((x) => x.split(';')[0]).join('; ');
    expect(cookies).toContain('aq_session=');
    const noCsrf = await request(c.http).put('/cart').set('cookie', cookies).send({ branchId: ids.branch_huallaga, items: [] });
    expect(noCsrf.body.error.code).toBe('CSRF');
    const csrf = cookies.match(/aq_csrf=([^;]+)/)![1];
    const withCsrf = await request(c.http).put('/cart').set('cookie', cookies).set('x-csrf-token', decodeURIComponent(csrf)).send({ branchId: ids.branch_huallaga, items: [], replaceOtherBranch: true });
    expect(withCsrf.status).toBe(200);
  });

  it('cambiar la fecha de nacimiento revoca la verificación', async () => {
    const t = await as(c, E.cTgm);
    expect((await t.get('/me')).body.ageStatus).toBe('verified');
    await t.patch('/me', { birthDate: '1987-01-01' });
    expect((await t.get('/me')).body.ageStatus).toBe('revoked');
  });

  it('transición inválida rechazada aunque se manipule la interfaz', async () => {
    const cust = await as(c, E.cAgu);
    const v = await variantOf(ids.branch_sazon, 'Inchicapi');
    const r = await placeOrder(cust, ids.branch_sazon, [{ variantId: v, quantity: 1 }], { addressId: ids.address_aguaytia, paymentMethod: 'cash' });
    const m = await as(c, E.m1);
    const ready = await m.post(`/merchant/orders/${r.res.body.id}/ready`);
    expect(ready.body.error.code).toBe('INVALID_TRANSITION');
    void createHash;
  });
});
