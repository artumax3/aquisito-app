import { LABELS } from '@aquisito/contracts';
import { Client } from 'pg';
import type { Response } from 'express';
import { config } from '../../config';
import { db, tx } from '../../db/db';
import { AuthCtx, opsCityScope } from '../../common/auth';
import { logger } from '../../common/logger';
import { sendPush } from '../../providers/messaging';

// ======================= Realtime (SSE + LISTEN/NOTIFY) =======================
// Los eventos en canal son mínimos ({type, orderId, version}): nunca llevan datos personales,
// ubicación ni detalles del pedido. El cliente vuelve a consultar la API (fuente de verdad).

const subscribers = new Map<string, Set<Response>>();
let listener: Client | null = null;

export async function startRealtime() {
  if (listener) return;
  listener = new Client({ connectionString: config().DATABASE_URL });
  await listener.connect();
  await listener.query('LISTEN aq_events');
  listener.on('notification', (msg) => {
    try {
      const ev = JSON.parse(msg.payload ?? '{}');
      const sent = new Set<Response>();
      for (const ch of ev.channels ?? []) {
        for (const res of [...(subscribers.get(ch) ?? []), ...(ch.startsWith('city:') ? subscribers.get('city:*') ?? [] : [])]) {
          if (sent.has(res)) continue;
          sent.add(res);
          res.write(`event: ${ev.type}\ndata: ${JSON.stringify({ type: ev.type, orderId: ev.orderId ?? null, version: ev.version ?? null, at: ev.at })}\n\n`);
        }
      }
    } catch (e) {
      logger.warn('evento realtime inválido', { err: (e as Error).message });
    }
  });
}

export async function stopRealtime() {
  if (listener) await listener.end().catch(() => undefined);
  listener = null;
  for (const set of subscribers.values()) for (const r of set) r.end();
  subscribers.clear();
}

export async function channelsFor(a: AuthCtx): Promise<string[]> {
  const ch = [`user:${a.userId}`];
  const merchants = a.memberships.filter((m) => m.role === 'merchant_owner').map((m) => m.merchant_id);
  if (merchants.length) {
    const bs = await db.q(`SELECT id FROM branches WHERE merchant_id = ANY($1)`, [merchants]);
    ch.push(...bs.map((b) => `branch:${b.id}`));
  }
  ch.push(...a.memberships.filter((m) => m.role === 'branch_operator').map((m) => `branch:${m.branch_id}`));
  if (a.memberships.some((m) => ['admin', 'city_dispatcher', 'support_agent', 'finance'].includes(m.role))) {
    const scope = opsCityScope(a);
    if (scope === null) ch.push('city:*');
    else ch.push(...scope.map((c) => `city:${c}`));
  }
  return [...new Set(ch)];
}

export async function subscribe(a: AuthCtx, res: Response) {
  const channels = await channelsFor(a);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform, private');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`event: ready\ndata: ${JSON.stringify({ channels: channels.length, note: 'Al reconectar, vuelva a consultar la API' })}\n\n`);
  for (const c of channels) {
    if (!subscribers.has(c)) subscribers.set(c, new Set());
    subscribers.get(c)!.add(res);
  }
  const hb = setInterval(() => res.write(`: ping\n\n`), 25000);
  res.on('close', () => {
    clearInterval(hb);
    for (const c of channels) subscribers.get(c)?.delete(res);
  });
}

// ======================= Outbox → notificaciones =======================

const CUSTOMER_STATES: Record<string, string> = {
  'commercial:confirmado': 'Recibimos tu pedido',
  'commercial:aceptado_comercio': 'El comercio aceptó tu pedido',
  'commercial:en_preparacion': 'Tu pedido se está preparando',
  'commercial:rechazado_comercio': 'El comercio no pudo aceptar tu pedido',
  'commercial:cancelado': 'Tu pedido fue cancelado',
  'delivery:asignado': 'Asignamos un repartidor',
  'delivery:recogido': 'Tu pedido fue recogido',
  'delivery:en_destino': 'El repartidor llegó a tu dirección',
  'delivery:entregado': 'Pedido entregado',
  'delivery:entrega_rechazada': 'La entrega no se completó',
  'delivery:entrega_fallida': 'No pudimos completar la entrega',
  'delivery:devuelto': 'Tu pedido volvió al comercio',
  'payment:pagado': 'Pago confirmado',
  'payment:fallido': 'Tu pago no se completó',
  'payment:reembolsado': 'Reembolso realizado',
  'payment:parcialmente_reembolsado': 'Reembolso parcial realizado',
};

async function notify(userId: string, kind: string, title: string, body: string, data: Record<string, unknown>, dedupeKey: string) {
  const n = await db.maybe(
    `INSERT INTO notifications(user_id, kind, title, body, lockscreen_body, data, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [userId, kind, title, body, 'Tienes una novedad en Aquisito', JSON.stringify(data), dedupeKey],
  );
  if (!n) return;
  const tokens = (await db.q(`SELECT token FROM push_tokens WHERE user_id = $1 AND revoked_at IS NULL`, [userId])).map((t) => t.token);
  // En pantalla bloqueada: texto genérico, sin productos, montos ni alcohol.
  const status = await sendPush(tokens, 'Aquisito', 'Tienes una novedad en Aquisito', { notificationId: n.id, ...data });
  await db.q(`UPDATE notifications SET push_status = $2 WHERE id = $1`, [n.id, status]);
}

async function handleEvent(ev: { id: number; topic: string; aggregate_id: string | null; payload: any }) {
  const p = ev.payload;
  const channels: string[] = [];
  if (p.orderId) {
    const o = await db.maybe(`SELECT id, number, user_id, branch_id, city_id FROM orders WHERE id = $1`, [p.orderId]);
    if (o) {
      channels.push(`user:${o.user_id}`, `branch:${o.branch_id}`, `city:${o.city_id}`);
      const couriers = await db.q(
        `SELECT courier_id FROM deliveries WHERE order_id = $1 AND (status = 'active' OR ended_at > now() - interval '1 minute') UNION SELECT courier_id FROM delivery_offers WHERE order_id = $1 AND created_at > now() - interval '10 minutes'`,
        [o.id],
      );
      channels.push(...couriers.map((c) => `user:${c.courier_id}`));
      if (ev.topic === 'order.status_changed') {
        const title = CUSTOMER_STATES[`${p.cycle}:${p.to}`];
        if (title) {
          const label = (LABELS as any)[p.cycle]?.[p.to] ?? p.to;
          await notify(o.user_id, 'order_status', title, `Pedido #${o.number}: ${label}`, { orderId: o.id }, `ev:${ev.id}:customer`);
        }
      }
      if (ev.topic === 'offer.created' && p.courierId) await notify(p.courierId, 'offer', 'Nueva oferta de reparto', 'Revisa la oferta antes de que venza', { orderId: o.id }, `ev:${ev.id}:courier`);
      if (ev.topic === 'substitution.proposed') await notify(o.user_id, 'substitution', 'El comercio propone un ajuste', `Pedido #${o.number}: revisa y confirma el ajuste por faltante`, { orderId: o.id }, `ev:${ev.id}:customer`);
      if (ev.topic === 'order.created' || (ev.topic === 'order.status_changed' && p.to === 'confirmado')) {
        const staff = await db.q(
          `SELECT DISTINCT m.user_id FROM memberships m JOIN branches b ON (m.role = 'merchant_owner' AND m.merchant_id = b.merchant_id) OR (m.role = 'branch_operator' AND m.branch_id = b.id) WHERE b.id = $1 AND m.revoked_at IS NULL`,
          [o.branch_id],
        );
        if (p.to === 'confirmado') for (const s of staff) await notify(s.user_id, 'merchant_order', 'Nuevo pedido', `Pedido #${o.number} por aceptar`, { orderId: o.id }, `ev:${ev.id}:staff:${s.user_id}`);
      }
    }
  }
  if (ev.topic === 'age_verification.decided' && p.userId) {
    channels.push(`user:${p.userId}`);
    const msg = p.status === 'verified' ? 'Tu verificación de mayoría de edad fue aprobada' : p.status === 'revoked' ? 'Tu verificación de edad fue revocada' : 'Tu verificación de edad no fue aprobada';
    await notify(p.userId, 'age_verification', 'Verificación de edad', msg, {}, `ev:${ev.id}:user`);
  }
  if (ev.topic === 'courier.reviewed' && p.userId) {
    channels.push(`user:${p.userId}`);
    await notify(p.userId, 'courier_review', 'Postulación de repartidor', p.approved ? 'Tu cuenta fue aprobada' : 'Tu postulación no fue aprobada', {}, `ev:${ev.id}:user`);
  }
  if (ev.topic.startsWith('complaint.') || ev.topic === 'incident.created') channels.push('city:*');
  if (channels.length) {
    const payload = JSON.stringify({ channels: [...new Set(channels)], type: ev.topic, orderId: p.orderId ?? null, version: p.version ?? null, at: new Date().toISOString() });
    await db.q(`SELECT pg_notify('aq_events', $1)`, [payload]);
  }
}

/** Procesa eventos durables con reintentos exponenciales y cola de fallos (dead_at). */
export async function processOutbox(batch = 50): Promise<number> {
  const events = await tx(async (t) => {
    const rows = await t.q(
      `SELECT * FROM outbox_events WHERE processed_at IS NULL AND dead_at IS NULL AND next_attempt_at <= now() ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [batch],
    );
    if (rows.length) await t.q(`UPDATE outbox_events SET next_attempt_at = now() + interval '30 seconds' WHERE id = ANY($1)`, [rows.map((r) => r.id)]);
    return rows;
  });
  for (const ev of events) {
    try {
      await handleEvent(ev);
      await db.q(`UPDATE outbox_events SET processed_at = now(), attempts = attempts + 1 WHERE id = $1`, [ev.id]);
    } catch (e) {
      const attempts = ev.attempts + 1;
      await db.q(
        `UPDATE outbox_events SET attempts = $2, last_error = $3, next_attempt_at = now() + make_interval(secs => $4), dead_at = CASE WHEN $2 >= 8 THEN now() END WHERE id = $1`,
        [ev.id, attempts, (e as Error).message.slice(0, 500), Math.min(3600, 2 ** attempts * 5)],
      );
    }
  }
  return events.length;
}

export async function listNotifications(a: AuthCtx) {
  return db.q(`SELECT id, kind, category, title, body, data, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [a.userId]);
}

export async function markRead(a: AuthCtx, id: string) {
  await db.q(`UPDATE notifications SET read_at = coalesce(read_at, now()) WHERE id = $1 AND user_id = $2`, [id, a.userId]);
  return { read: true };
}

export async function registerPushToken(a: AuthCtx, token: string, platform: string) {
  await db.q(
    `INSERT INTO push_tokens(token, user_id, platform) VALUES ($1,$2,$3) ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, revoked_at = NULL`,
    [token, a.userId, platform],
  );
  return { registered: true, pushConfigured: config().PUSH_PROVIDER === 'expo' };
}

/** Marketing de alcohol solo a adultos verificados con consentimiento específico. */
export async function canReceiveAlcoholMarketing(userId: string): Promise<boolean> {
  const r = await db.maybe(
    `SELECT (SELECT status FROM age_verifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1) = 'verified'
        AND coalesce((SELECT granted FROM consents WHERE user_id = $1 AND purpose = 'marketing_alcohol' ORDER BY created_at DESC LIMIT 1), false) AS ok`,
    [userId],
  );
  return !!r?.ok;
}
