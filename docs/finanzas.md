# Reglas financieras, inventario y liquidaciones

## Dinero
- Céntimos enteros de PEN (`bigint`). Nunca `float` para totales.
- `orders.total_cents = subtotal - descuento + envío + servicio + recargo + propina` (CHECK en BD).
- Descuentos de producto se distribuyen por línea con el método del mayor resto (`distributeDiscount`); la suma es exacta y ninguna línea queda negativa. El descuento nunca supera subtotal + envío.
- Precios mostrados son finales al consumidor. Tratamiento de IGV y redondeos: **pendiente de validación contable**; no se suma IGV sobre precios que ya lo incluyen.

## Tarifa de reparto
`envío = base + ceil(décimas_de_km_extra × precio_km / 10)` sobre la distancia que supera lo incluido. Distancia por ruta (OSRM) o **aproximación** `haversine × 1.3` etiquetada en la interfaz.
`pago_repartidor = base_repartidor + ceil(km × por_km_repartidor)` (fijado en la cotización).

## Asientos al completar (ledger inmutable, `dedupe_key` única)
| Parte | Asiento | Fórmula |
|---|---|---|
| gateway | customer_payment | + importe confirmado por el proveedor (al pagar) |
| comercio | merchant_sale | + (subtotal − descuento financiado por el comercio) |
| comercio | merchant_commission | − round(base × comisión_bp / 10000) |
| plataforma | platform_commission | + comisión |
| plataforma | platform_service_fee | + servicio + recargo |
| plataforma | platform_delivery_margin | + envío − pago_repartidor |
| plataforma | platform_promo_cost | − descuento financiado por la plataforma |
| repartidor | courier_delivery_pay | + pago_repartidor |
| repartidor | courier_tip | + propina (100 %) |
| repartidor | courier_cash_held | − efectivo cobrado (saldo por rendir) |
| gateway | customer_refund | − reembolso confirmado |
| comercio | merchant_refund_adjustment | − reembolso de productos si el pedido ya estaba completado |

Correcciones: siempre con nuevos asientos (un trigger impide UPDATE/DELETE).

## Liquidaciones
Una liquidación toma los asientos de una parte en un período que **no** estén en otra liquidación vigente (`settlement_items.ledger_entry_id UNIQUE`). Repetir la solicitud del mismo período devuelve la misma liquidación. `GET /admin/settlements/:id` recalcula el total desde los asientos y lo compara (`consistent`). La ejecución del pago al tercero es externa y autorizada: **no hay custodia de fondos, billetera ni pagos divididos asumidos**.

## Inventario
- `inventory(on_hand, reserved)` con `CHECK reserved <= on_hand` y `>= 0`.
- Reserva al confirmar el pedido con `UPDATE ... WHERE on_hand - reserved >= q`, demanda **agregada** por SKU (unidades sueltas + componentes de combos + adicionales con SKU), en orden de `sku_id`.
- Pago digital: la reserva vence con el plazo de pago (`payment_deadline`); al vencer se consulta al proveedor antes de cancelar.
- Salida definitiva (`commit`) al iniciar preparación.
- Cancelación antes de preparar: libera. Después: el retorno **no** vuelve a stock vendible salvo inspección del comercio (`return_restock` / `return_discard`), una sola vez.
- `stock_combo = min(floor(disponible_componente / requerido))`, evaluado por la opción con más stock de cada componente.

## Cupones
UPDATE condicional `uses_count < max_uses AND budget_used + d <= budget` en la misma transacción del pedido; límite por usuario comprobado con la fila del cupón bloqueada. Al cancelar se revierte (redención `reversed`). Un cupón no habilita alcohol ni destinos fuera de cobertura.
