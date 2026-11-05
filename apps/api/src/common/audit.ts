import type { Tx } from '../db/db';
import type { AuthCtx } from './auth';

export async function audit(
  t: Tx,
  a: AuthCtx | null,
  action: string,
  entity: string,
  entityId: string | null,
  reason: string | null,
  data: Record<string, unknown> = {},
) {
  await t.q(
    `INSERT INTO audit_log(actor_user_id, actor_roles, action, entity, entity_id, reason, data, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [a?.userId ?? null, a ? [...a.roles] : ['system'], action, entity, entityId, reason, JSON.stringify(data), a?.correlationId ?? null],
  );
}

/** Evento durable (patrón outbox): se inserta en la MISMA transacción que el cambio de estado. */
export async function emit(t: Tx, topic: string, aggregateId: string | null, payload: Record<string, unknown>) {
  await t.q(`INSERT INTO outbox_events(topic, aggregate_id, payload) VALUES ($1,$2,$3)`, [topic, aggregateId, JSON.stringify(payload)]);
}
