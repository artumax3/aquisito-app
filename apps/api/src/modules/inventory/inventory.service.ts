import type { Tx } from '../../db/db';
import { BizError } from '../../common/errors';

/**
 * Reserva atómica de la demanda AGREGADA por SKU. Cada UPDATE es condicional
 * (on_hand - reserved >= q) y bloquea la fila; se procesan en orden de sku_id para evitar
 * interbloqueos. Si alguna falla se lanza error y la transacción completa se revierte: dos
 * compradores no pueden reservar la última unidad (criterio 07).
 */
export async function reserve(t: Tx, orderId: string, demand: Map<string, number>, expiresAt: Date | null, actor: string | null) {
  const skus = [...demand.keys()].sort();
  for (const sku of skus) {
    const q = demand.get(sku)!;
    const r = await t.maybe(
      `UPDATE inventory SET reserved = reserved + $2, updated_at = now() WHERE sku_id = $1 AND on_hand - reserved >= $2 RETURNING on_hand, reserved`,
      [sku, q],
    );
    if (!r) {
      const s = await t.maybe(`SELECT s.name, i.on_hand - i.reserved AS available FROM skus s LEFT JOIN inventory i ON i.sku_id = s.id WHERE s.id = $1`, [sku]);
      throw new BizError('OUT_OF_STOCK', `Sin stock suficiente de ${s?.name ?? 'un producto'}`, 409, { skuId: sku, available: Math.max(0, s?.available ?? 0), requested: q });
    }
    await t.q(
      `INSERT INTO inventory_reservations(order_id, sku_id, quantity, expires_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (order_id, sku_id) DO UPDATE SET quantity = EXCLUDED.quantity, status = 'active', expires_at = EXCLUDED.expires_at, updated_at = now()`,
      [orderId, sku, q, expiresAt],
    );
    await t.q(
      `INSERT INTO inventory_movements(sku_id, order_id, kind, quantity, on_hand_after, reserved_after, actor_user_id) VALUES ($1,$2,'reserve',$3,$4,$5,$6)`,
      [sku, orderId, q, r.on_hand, r.reserved, actor],
    );
  }
}

/** Libera reservas activas (cancelación, vencimiento, rechazo). Idempotente. */
export async function release(t: Tx, orderId: string, reason: string, actor: string | null) {
  const rs = await t.q(`SELECT * FROM inventory_reservations WHERE order_id = $1 AND status = 'active' ORDER BY sku_id FOR UPDATE`, [orderId]);
  for (const r of rs) {
    const inv = await t.one(`UPDATE inventory SET reserved = reserved - $2, updated_at = now() WHERE sku_id = $1 RETURNING on_hand, reserved`, [r.sku_id, r.quantity]);
    await t.q(`UPDATE inventory_reservations SET status = 'released', updated_at = now() WHERE id = $1`, [r.id]);
    await t.q(
      `INSERT INTO inventory_movements(sku_id, order_id, kind, quantity, on_hand_after, reserved_after, reason, actor_user_id) VALUES ($1,$2,'release',$3,$4,$5,$6,$7)`,
      [r.sku_id, orderId, r.quantity, inv.on_hand, inv.reserved, reason, actor],
    );
  }
  return rs.length;
}

/** Convierte la reserva en salida definitiva (al iniciar preparación). Idempotente. */
export async function commit(t: Tx, orderId: string, actor: string | null) {
  const rs = await t.q(`SELECT * FROM inventory_reservations WHERE order_id = $1 AND status = 'active' ORDER BY sku_id FOR UPDATE`, [orderId]);
  for (const r of rs) {
    const inv = await t.one(
      `UPDATE inventory SET reserved = reserved - $2, on_hand = on_hand - $2, updated_at = now() WHERE sku_id = $1 RETURNING on_hand, reserved`,
      [r.sku_id, r.quantity],
    );
    await t.q(`UPDATE inventory_reservations SET status = 'committed', expires_at = NULL, updated_at = now() WHERE id = $1`, [r.id]);
    await t.q(
      `INSERT INTO inventory_movements(sku_id, order_id, kind, quantity, on_hand_after, reserved_after, actor_user_id) VALUES ($1,$2,'commit',$3,$4,$5,$6)`,
      [r.sku_id, orderId, r.quantity, inv.on_hand, inv.reserved, actor],
    );
  }
}

/**
 * Retorno físico: NO vuelve automáticamente a stock vendible. El comercio inspecciona y decide;
 * solo con restockSellable=true se suma a on_hand. Una segunda llamada no duplica (se comprueba
 * existencia de movimientos de retorno para el pedido).
 */
export async function inspectReturn(t: Tx, orderId: string, restockSellable: boolean, notes: string, actor: string) {
  const already = await t.maybe(`SELECT 1 FROM inventory_movements WHERE order_id = $1 AND kind IN ('return_restock','return_discard') LIMIT 1`, [orderId]);
  if (already) throw new BizError('ALREADY_INSPECTED', 'La devolución ya fue inspeccionada', 409);
  const committed = await t.q(`SELECT * FROM inventory_reservations WHERE order_id = $1 AND status = 'committed' ORDER BY sku_id`, [orderId]);
  for (const r of committed) {
    const inv = restockSellable
      ? await t.one(`UPDATE inventory SET on_hand = on_hand + $2, updated_at = now() WHERE sku_id = $1 RETURNING on_hand, reserved`, [r.sku_id, r.quantity])
      : await t.one(`SELECT on_hand, reserved FROM inventory WHERE sku_id = $1`, [r.sku_id]);
    await t.q(
      `INSERT INTO inventory_movements(sku_id, order_id, kind, quantity, on_hand_after, reserved_after, reason, actor_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [r.sku_id, orderId, restockSellable ? 'return_restock' : 'return_discard', r.quantity, inv.on_hand, inv.reserved, notes, actor],
    );
  }
  // Reservas aún activas (cancelación antes de preparar) se liberan.
  await release(t, orderId, 'retorno', actor);
}

export async function adjustStock(t: Tx, skuId: string, delta: number, reason: string, actor: string) {
  const inv = await t.maybe(
    `UPDATE inventory SET on_hand = on_hand + $2, updated_at = now() WHERE sku_id = $1 AND on_hand + $2 >= reserved RETURNING on_hand, reserved`,
    [skuId, delta],
  );
  if (!inv) throw new BizError('STOCK_ADJUST_INVALID', 'El ajuste dejaría stock por debajo de lo reservado', 409);
  await t.q(
    `INSERT INTO inventory_movements(sku_id, kind, quantity, on_hand_after, reserved_after, reason, actor_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [skuId, delta >= 0 ? 'restock' : 'adjust', delta, inv.on_hand, inv.reserved, reason, actor],
  );
  return { onHand: inv.on_hand, reserved: inv.reserved, available: inv.on_hand - inv.reserved };
}
