import {
  Actor,
  COMMERCIAL_TRANSITIONS,
  DELIVERY_TRANSITIONS,
  PAYMENT_TRANSITIONS,
  Transition,
} from '@aquisito/contracts';
import type { Tx } from '../../db/db';
import { BizError } from '../../common/errors';
import { emit } from '../../common/audit';

export type Cycle = 'commercial' | 'delivery' | 'payment';
const TABLES: Record<Cycle, Transition<string>[]> = {
  commercial: COMMERCIAL_TRANSITIONS as Transition<string>[],
  delivery: DELIVERY_TRANSITIONS as Transition<string>[],
  payment: PAYMENT_TRANSITIONS as Transition<string>[],
};
const COLUMN: Record<Cycle, string> = { commercial: 'commercial_status', delivery: 'delivery_status', payment: 'payment_status' };

export async function lockOrder(t: Tx, orderId: string) {
  const o = await t.maybe(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
  if (!o) throw new BizError('NOT_FOUND', 'Pedido no encontrado', 404);
  return o;
}

/**
 * Única puerta para cambiar estados. Valida (from,to,actor) contra la tabla canónica, incrementa la
 * versión del pedido, registra historial y emite el evento durable en la misma transacción.
 * El pedido DEBE estar bloqueado (lockOrder) por el llamador.
 */
export async function transition(
  t: Tx,
  order: any,
  cycle: Cycle,
  to: string,
  actor: Actor,
  opts: { userId?: string | null; reason?: string | null; extraSet?: Record<string, unknown> } = {},
) {
  const from = order[COLUMN[cycle]];
  const tr = TABLES[cycle].find((x) => x.from === from && x.to === to);
  if (!tr || !tr.actors.includes(actor)) {
    throw new BizError('INVALID_TRANSITION', `Transición no permitida (${cycle}: ${from} → ${to})`, 409, { cycle, from, to, actor });
  }
  const sets = [`${COLUMN[cycle]} = $2`, 'version = version + 1'];
  const params: unknown[] = [order.id, to];
  for (const [k, v] of Object.entries(opts.extraSet ?? {})) {
    if (!/^[a-z_]+$/.test(k)) throw new Error('columna inválida');
    params.push(v);
    sets.push(`${k} = $${params.length}`);
  }
  const updated = await t.one(`UPDATE orders SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  await t.q(
    `INSERT INTO order_status_history(order_id, cycle, from_status, to_status, actor_user_id, actor_role, reason, order_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [order.id, cycle, from, to, opts.userId ?? null, actor, opts.reason ?? null, updated.version],
  );
  await emit(t, 'order.status_changed', order.id, { orderId: order.id, cycle, from, to, version: updated.version });
  Object.assign(order, updated);
  return updated;
}
