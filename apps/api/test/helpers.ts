import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { config } from '../src/config';
import { createApp } from '../src/app';
import { closePool, db, tx } from '../src/db/db';
import { resetDatabase } from '../src/db/migrate';
import { demoMfaSecret, seedDemo, SeedResult } from '../src/db/seed';
import { totp } from '../src/common/crypto';
import { runJobsOnce } from '../src/jobs';

export const PASSWORD = 'Test-Password-123';

export interface Ctx {
  app: INestApplication;
  http: any;
  ids: Record<string, string>;
  seed: SeedResult;
}

export async function setup(): Promise<Ctx> {
  if (config().APP_ENV !== 'test') throw new Error('APP_ENV=test requerido');
  await closePool();
  await resetDatabase(config().DATABASE_URL);
  const seed = await tx((t) => seedDemo(t, { password: PASSWORD }));
  const app = await createApp();
  // Ventanas de alcohol de prueba de día completo (para que las pruebas no dependan de la hora).
  await allDayAlcoholRules();
  // Compra mínima 0 en pruebas (se prueba aparte); evita acoplar cada caso al mínimo de demo.
  await db.q(`UPDATE delivery_fee_rules SET min_order_cents = 0`);
  return { app, http: app.getHttpServer(), ids: seed.ids, seed };
}

export async function teardown(c: Ctx) {
  await c.app.close();
  await closePool();
}

export async function allDayAlcoholRules() {
  await db.q(`DELETE FROM alcohol_rules`);
  for (const j of await db.q(`SELECT id FROM jurisdictions WHERE name NOT LIKE '%Castillo%'`)) {
    for (let d = 0; d < 7; d++) {
      await db.q(
        `INSERT INTO alcohol_rules(jurisdiction_id, weekday, start_time, end_time, source, source_reviewed_at, responsible, validated, is_demo) VALUES ($1,$2,'00:00','12:00','prueba',current_date,'test',false,true),($1,$2,'12:00','00:00','prueba',current_date,'test',false,true)`,
        [j.id, d],
      );
    }
  }
}

export class Client {
  token = '';
  constructor(private c: Ctx) {}
  async login(email: string, mfa = false) {
    const r = await request(this.c.http).post('/auth/login').send({ email, password: PASSWORD });
    if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.body)}`);
    this.token = r.body.token;
    if (mfa) {
      const code = totp(demoMfaSecret(email));
      const m = await this.post('/auth/mfa/verify', { code });
      if (m.status !== 200) throw new Error(`mfa ${email}: ${JSON.stringify(m.body)}`);
    }
    return this;
  }
  private req(method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, body?: unknown, headers: Record<string, string> = {}) {
    let r = (request(this.c.http) as any)[method](path);
    if (this.token) r = r.set('authorization', `Bearer ${this.token}`);
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return body !== undefined ? r.send(body) : r;
  }
  get(path: string) { return this.req('get', path); }
  post(path: string, body: unknown = {}, headers?: Record<string, string>) { return this.req('post', path, body, headers); }
  put(path: string, body: unknown) { return this.req('put', path, body); }
  patch(path: string, body: unknown) { return this.req('patch', path, body); }
  del(path: string) { return this.req('delete', path); }
}

const mfaCache = new Map<string, Client>();
/** Las sesiones elevadas con TOTP se reutilizan: el mismo código no puede usarse dos veces (anti-replay). */
export const as = async (c: Ctx, email: string, mfa = false) => {
  if (mfa && mfaCache.has(email)) return mfaCache.get(email)!;
  const cl = await new Client(c).login(email, mfa);
  if (mfa) mfaCache.set(email, cl);
  return cl;
};
export const key = () => randomUUID().replace(/-/g, '');

/** Carga carrito, cotiza y confirma. Devuelve el pedido. */
export async function placeOrder(
  cl: Client,
  branchId: string,
  items: { variantId: string; quantity: number; comboSelections?: Record<string, string>; modifierOptionIds?: string[] }[],
  opts: { addressId: string; paymentMethod?: 'card' | 'cash' | 'wallet'; tipCents?: number; couponCode?: string; alcohol?: boolean; idem?: string; scheduledSlotStart?: string },
) {
  const cart = await cl.put('/cart', { branchId, items, replaceOtherBranch: true });
  if (cart.status !== 200) return { stage: 'cart', res: cart };
  const q = await cl.post('/checkout/quotes', { addressId: opts.addressId, paymentMethod: opts.paymentMethod ?? 'card', tipCents: opts.tipCents ?? 0, couponCode: opts.couponCode, scheduledSlotStart: opts.scheduledSlotStart });
  if (q.status !== 201) return { stage: 'quote', res: q };
  const o = await cl.post('/orders', { quoteId: q.body.id, quoteVersion: q.body.version, alcoholTermsAccepted: !!opts.alcohol }, { 'idempotency-key': opts.idem ?? key() });
  return { stage: 'order', res: o, quote: q.body };
}

export async function payCard(cl: Client, orderId: string, outcome: 'paid' | 'failed' = 'paid') {
  const p = await cl.post('/payments', { orderId }, { 'idempotency-key': key() });
  if (p.status !== 201) throw new Error(`payment ${p.status} ${JSON.stringify(p.body)}`);
  const s = await cl.post(`/dev/payments/${p.body.id}/simulate`, { outcome });
  return { payment: p.body, sim: s.body };
}

export async function courierOnline(cl: Client, lat: number, lng: number) {
  await cl.put('/courier/availability', { available: true });
  await cl.post('/courier/location', { lat, lng, accuracyM: 10, recordedAt: new Date().toISOString() });
}

export async function jobs(only?: string[]) {
  return runJobsOnce(only);
}

/** Lleva un pedido pagado hasta "listo" y asignado al repartidor indicado. */
export async function toReadyAndAssigned(c: Ctx, merchant: Client, courier: Client, orderId: string) {
  expectOk(await merchant.post(`/merchant/orders/${orderId}/accept`));
  expectOk(await merchant.post(`/merchant/orders/${orderId}/start`));
  const ready = await merchant.post(`/merchant/orders/${orderId}/ready`);
  expectOk(ready);
  await jobs(['autoDispatch']);
  const offers = await courier.get('/courier/offers');
  const offer = offers.body.find((o: any) => o.orderId === orderId);
  if (!offer) throw new Error('sin oferta para el repartidor: ' + JSON.stringify(offers.body));
  expectOk(await courier.post(`/courier/offers/${offer.id}/accept`));
  return { pickupCode: ready.body.pickupCode as string };
}

export function expectOk(r: any) {
  if (r.status >= 300) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r;
}

export const E = {
  admin: 'admin@demo.aquisito.local',
  finance: 'finanzas@demo.aquisito.local',
  support: 'soporte@demo.aquisito.local',
  dispAgu: 'despacho.aguaytia@demo.aquisito.local',
  dispTgm: 'despacho.tingo@demo.aquisito.local',
  m1: 'comercio1@demo.aquisito.local',
  m2: 'comercio2@demo.aquisito.local',
  m4: 'comercio4@demo.aquisito.local',
  m5: 'comercio5@demo.aquisito.local',
  op: 'operador.minimarket@demo.aquisito.local',
  rAgu1: 'repartidor.aguaytia1@demo.aquisito.local',
  rAgu2: 'repartidor.aguaytia2@demo.aquisito.local',
  rTgm1: 'repartidor.tingo1@demo.aquisito.local',
  cAgu: 'cliente.aguaytia@demo.aquisito.local',
  cTgm: 'cliente.tingo@demo.aquisito.local',
  cNo: 'cliente.noverificado@demo.aquisito.local',
  cMenor: 'cliente.menor@demo.aquisito.local',
  cRev: 'cliente.revocado@demo.aquisito.local',
};

export async function variantOf(branchId: string, productName: string) {
  return (await db.one(`SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.branch_id = $1 AND p.name = $2 ORDER BY v.sort LIMIT 1`, [branchId, productName])).id as string;
}

/** Higiene entre casos: cancela pedidos en curso (vía API de soporte) y libera repartidores. */
export async function cleanup(c: Ctx) {
  const admin = await as(c, E.admin, true);
  const rows = await db.q(`SELECT id FROM orders WHERE commercial_status IN ('pendiente_confirmacion','confirmado','aceptado_comercio','en_preparacion','listo_para_recojo') AND delivery_status NOT IN ('retorno_pendiente')`);
  for (const r of rows) await admin.post(`/admin/orders/${r.id}/cancel`, { reason: 'limpieza de prueba' });
  await db.q(`UPDATE deliveries SET status = 'ended', ended_at = now(), end_reason = 'limpieza de prueba' WHERE status = 'active'`);
  await db.q(`UPDATE delivery_offers SET status = 'cancelled' WHERE status = 'offered'`);
}
