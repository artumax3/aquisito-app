import { Client } from 'pg';
import { config } from './config';
import { db, tx } from './db/db';
import { logger } from './common/logger';
import { emit } from './common/audit';
import { processOutbox } from './modules/notifications/notifications.service';
import { autoDispatch, expireOffers } from './modules/dispatch/dispatch.service';
import { applyProviderResult, executePendingRefunds, reconcilePending } from './modules/payments/payments.service';
import { cancelOrderTx } from './modules/orders/lifecycle';
import { lockOrder } from './modules/orders/state';
import { paymentProvider } from './providers/payments';
import { expireDocuments } from './modules/documents/documents.service';

/**
 * Vencimiento de pagos: ANTES de cancelar se consulta al proveedor (recuperación segura). Si el
 * pago se confirmó, se aplica con las reservas aún vigentes; si no, se cancela y se libera stock.
 * Un pago que llegue después dispara devolución automática (applyProviderResult).
 */
export async function expireUnpaidOrders(): Promise<number> {
  const rows = await db.q(
    `SELECT id FROM orders WHERE commercial_status = 'pendiente_confirmacion' AND payment_deadline IS NOT NULL AND payment_deadline < now() LIMIT 50`,
  );
  for (const { id } of rows) {
    const live = await db.maybe(`SELECT * FROM payments WHERE order_id = $1 AND status IN ('pendiente','en_conciliacion') AND provider_reference IS NOT NULL`, [id]);
    if (live && live.provider !== 'transfer') {
      try {
        const st = await paymentProvider(live.provider).getStatus(live.provider_reference);
        if (st.status === 'paid') {
          await applyProviderResult(live.id, 'paid', { amountCents: st.amountCents ?? -1, currency: st.currency ?? '', providerReference: live.provider_reference, source: 'consulta al vencer' });
          continue;
        }
      } catch (e) {
        logger.warn('consulta previa al vencimiento falló; se cancela y cualquier pago tardío se devolverá', { orderId: id, err: (e as Error).message });
      }
    }
    await tx(async (t) => {
      const o = await lockOrder(t, id);
      if (o.commercial_status !== 'pendiente_confirmacion') return;
      // Un pago con resultado incierto sigue "en_conciliacion": la conciliación posterior lo resolverá
      // (si resultara cobrado, se devuelve automáticamente porque el pedido ya está cancelado).
      await t.q(`UPDATE payments SET status = 'vencido', updated_at = now() WHERE order_id = $1 AND status = 'pendiente'`, [o.id]);
      await cancelOrderTx(t, o, { to: 'cancelado', actor: 'system', userId: null, reason: 'Plazo de pago vencido' });
    });
  }
  return rows.length;
}

/** Comercio que no responde: rechazo automático por el sistema con reembolso. */
export async function expireAcceptance(): Promise<number> {
  const rows = await db.q(`SELECT id FROM orders WHERE commercial_status = 'confirmado' AND accept_deadline < now() LIMIT 50`);
  for (const { id } of rows) {
    await tx(async (t) => {
      const o = await lockOrder(t, id);
      if (o.commercial_status !== 'confirmado' || o.accept_deadline > new Date()) return;
      await cancelOrderTx(t, o, { to: 'rechazado_comercio', actor: 'system', userId: null, reason: 'El comercio no respondió dentro del plazo' });
    });
  }
  return rows.length;
}

export async function complaintAlerts(): Promise<number> {
  const rows = await db.q(
    `SELECT id FROM complaints WHERE response IS NULL AND due_date <= (now() AT TIME ZONE 'America/Lima')::date + 3
       AND NOT EXISTS (SELECT 1 FROM outbox_events e WHERE e.topic = 'complaint.due_soon' AND e.payload->>'complaintId' = complaints.id::text)`,
  );
  for (const r of rows) await tx((t) => emit(t, 'complaint.due_soon', null, { complaintId: r.id }));
  return rows.length;
}

/**
 * Retención (propuesta a validar, docs/legal-borradores.md §6): borra ubicaciones de repartidores
 * desconectados sin entrega activa, OTP/intentos de acceso de más de 30 días, restablecimientos
 * vencidos y documentos con fecha de eliminación cumplida (también del almacenamiento).
 */
export async function retention() {
  const loc = await db.q(
    `DELETE FROM courier_locations l WHERE l.received_at < now() - interval '1 day'
       AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.courier_id = l.courier_id AND d.status = 'active') RETURNING courier_id`,
  );
  const otp = await db.q(`DELETE FROM otp_challenges WHERE created_at < now() - interval '30 days' RETURNING id`);
  const att = await db.q(`DELETE FROM login_attempts WHERE created_at < now() - interval '30 days' RETURNING id`);
  const pr = await db.q(`DELETE FROM password_resets WHERE expires_at < now() - interval '30 days' RETURNING id`);
  const docs = await db.q(`SELECT id, storage_key FROM documents WHERE delete_after IS NOT NULL AND delete_after < (now() AT TIME ZONE 'America/Lima')::date`);
  const { storage } = await import('./providers/storage');
  for (const d of docs) {
    await storage().remove(d.storage_key).catch(() => undefined);
    await db.q(`DELETE FROM documents WHERE id = $1`, [d.id]);
  }
  return { locations: loc.length, otp: otp.length, loginAttempts: att.length, passwordResets: pr.length, documents: docs.length };
}

export const JOBS: Record<string, () => Promise<unknown>> = {
  outbox: () => processOutbox(),
  expireUnpaid: expireUnpaidOrders,
  expireAcceptance,
  expireOffers,
  autoDispatch,
  reconcile: () => reconcilePending(60),
  refunds: executePendingRefunds,
  complaintAlerts,
  expireDocuments,
  retention,
};

/** Jobs de baja frecuencia (ms entre ejecuciones dentro del bucle). */
const SLOW: Record<string, number> = { retention: 3600_000, expireDocuments: 3600_000, complaintAlerts: 600_000 };
const lastSlowRun = new Map<string, number>();

/** Ejecuta los jobs una vez (usado por pruebas y por el bucle). Con `only`, sin restricción de frecuencia. */
export async function runJobsOnce(only?: string[]) {
  const out: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(JOBS)) {
    if (only && !only.includes(name)) continue;
    if (!only && SLOW[name] && Date.now() - (lastSlowRun.get(name) ?? 0) < SLOW[name]) continue;
    if (SLOW[name]) lastSlowRun.set(name, Date.now());
    out[name] = await fn();
  }
  return out;
}

let timer: NodeJS.Timeout | null = null;
let lockClient: Client | null = null;
export const jobStats = { lastRunAt: null as Date | null, lastError: null as string | null, runs: 0 };

/** Bucle de trabajos con exclusión entre instancias mediante advisory lock de sesión. */
export async function startJobs() {
  if (!config().JOBS_ENABLED || timer) return;
  lockClient = new Client({ connectionString: config().DATABASE_URL });
  await lockClient.connect();
  let running = false;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const got = await lockClient!.query('SELECT pg_try_advisory_lock(727002) AS ok');
      if (!got.rows[0].ok) return;
      try {
        await runJobsOnce();
        jobStats.lastRunAt = new Date();
        jobStats.runs++;
      } finally {
        await lockClient!.query('SELECT pg_advisory_unlock(727002)');
      }
    } catch (e) {
      jobStats.lastError = (e as Error).message;
      logger.error('job falló', { err: (e as Error).message });
    } finally {
      running = false;
    }
  }, config().JOBS_INTERVAL_MS);
}

export async function stopJobs() {
  if (timer) clearInterval(timer);
  timer = null;
  if (lockClient) await lockClient.end().catch(() => undefined);
  lockClient = null;
}
