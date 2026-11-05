# Estados y transiciones del pedido

> Generado por `pnpm --filter @aquisito/api docs` desde `packages/contracts/src/state-machines.ts`. El servidor rechaza (409 `INVALID_TRANSITION`) cualquier par o actor no listado, aunque la interfaz sea manipulada. Cada transición incrementa `orders.version`, se registra en `order_status_history` y emite un evento durable (outbox) en la misma transacción.

Los tres ciclos son independientes: entregado ≠ pagado; cancelado ≠ reembolsado.

## Ciclo comercial

| De | A | Actor autorizado | Precondiciones | Inventario | Efecto económico | Notifica |
|---|---|---|---|---|---|---|
| pendiente_confirmacion | confirmado | system, payment_provider | Pago confirmado por proveedor (o efectivo aceptado) y reservas de stock vigentes | Reservas se mantienen | Ninguno (el cobro se registra en el ciclo de pago) | Cliente y comercio |
| pendiente_confirmacion | cancelado | customer, system, support | Pago no confirmado o vencido | Libera reservas | Si hubo cobro tardío: reembolso | Cliente |
| confirmado | aceptado_comercio | merchant | Dentro del plazo de aceptación; revalida horario de alcohol | Reservas se mantienen | Ninguno | Cliente |
| confirmado | rechazado_comercio | merchant, system | Motivo obligatorio; system cuando vence el plazo de aceptación | Libera reservas | Reembolso total del pago digital | Cliente |
| confirmado | cancelado | customer, support | Antes de la aceptación del comercio | Libera reservas | Reembolso total | Cliente y comercio |
| aceptado_comercio | en_preparacion | merchant | Revalida restricciones de alcohol | Convierte reservas en salida definitiva | Ninguno | Cliente |
| aceptado_comercio | cancelado | support | Motivo obligatorio | Libera reservas | Reembolso total | Cliente y comercio |
| en_preparacion | listo_para_recojo | merchant | — | — | — | Repartidor asignado |
| en_preparacion | cancelado | support | Motivo obligatorio; mercadería ya descontada | Retorno requiere inspección del comercio | Reembolso según política (soporte decide importes por concepto) | Cliente y comercio |
| listo_para_recojo | completado | system | Entrega en estado entregado | — | Asientos de venta, comisión, reparto y propina | Cliente |
| listo_para_recojo | cancelado | support, system | Entrega rechazada/devuelta o cancelación supervisada | Retorno requiere inspección | Resolución económica trazable | Cliente y comercio |

## Ciclo de reparto

| De | A | Actor autorizado | Precondiciones | Inventario | Efecto económico | Notifica |
|---|---|---|---|---|---|---|
| sin_asignar | oferta_enviada | system, dispatcher | Pedido confirmado; repartidor aprobado, disponible y de la ciudad | — | — | Repartidor |
| oferta_enviada | asignado | courier | Oferta vigente, aceptación atómica, sin otra entrega activa | — | — | Cliente y comercio |
| oferta_enviada | sin_asignar | system, courier | Oferta rechazada o vencida | — | — | Despacho |
| sin_asignar | asignado | dispatcher | Asignación manual supervisada con motivo | — | — | Repartidor, cliente |
| asignado | en_camino_al_comercio | courier | — | — | — | Comercio |
| asignado | sin_asignar | dispatcher, courier | Reasignación con motivo (antes del recojo) | — | — | Despacho |
| en_camino_al_comercio | sin_asignar | dispatcher | Reasignación con motivo (antes del recojo) | — | — | Despacho |
| en_camino_al_comercio | recogido | courier | Pedido listo; código de recojo correcto; paquetes confirmados | — | — | Cliente |
| asignado | recogido | courier | Pedido listo; código de recojo correcto; paquetes confirmados | — | — | Cliente |
| recogido | en_camino_al_cliente | courier | — | — | — | Cliente |
| en_camino_al_cliente | en_destino | courier | — | — | — | Cliente |
| en_destino | verificacion_requerida | courier, system | Pedido con alcohol | — | — | — |
| en_destino | entregado | courier | Pedido SIN alcohol; código de entrega de un solo uso válido; efectivo registrado si aplica | — | Asientos de liquidación | Cliente |
| verificacion_requerida | entregado | courier | Comprobación presencial de edad APROBADA para esta entrega + código válido | — | Asientos de liquidación | Cliente |
| verificacion_requerida | entrega_rechazada | courier | Comprobación presencial rechazada (motivo obligatorio) | — | Abre resolución económica | Cliente, soporte, comercio |
| en_destino | entrega_fallida | courier | Cliente ausente / dirección incorrecta tras espera | — | Abre resolución | Cliente, soporte |
| en_camino_al_cliente | entrega_fallida | courier | Accidente o avería | — | Abre resolución | Soporte |
| entrega_rechazada | retorno_pendiente | system | — | — | — | Comercio |
| entrega_fallida | retorno_pendiente | system, support | — | — | — | Comercio |
| retorno_pendiente | devuelto | merchant | Comercio confirma recepción | Inspección decide si vuelve a stock vendible | Resolución por concepto | Soporte, cliente |

## Ciclo de pago

| De | A | Actor autorizado | Precondiciones | Inventario | Efecto económico | Notifica |
|---|---|---|---|---|---|---|
| pendiente | autorizado | payment_provider | Evento verificado | — | — | — |
| pendiente | pagado | payment_provider, courier, finance | Evento verificado con importe, moneda y referencia; efectivo cobrado; transferencia conciliada | Confirma reservas o activa recuperación si vencieron | Asiento de cobro | Cliente |
| pendiente | fallido | payment_provider | Evento verificado | Libera reservas | — | Cliente |
| pendiente | vencido | system | Plazo de pago vencido | Libera reservas | — | Cliente |
| pendiente | en_conciliacion | system | Respuesta incierta del proveedor | Mantiene reservas hasta vencer | — | — |
| en_conciliacion | pagado | system, finance | Consulta al proveedor confirma cobro | Igual que pendiente→pagado | Asiento de cobro | Cliente |
| en_conciliacion | fallido | system, finance | Consulta confirma que no hubo cobro | Libera reservas | — | Cliente |
| autorizado | pagado | payment_provider | Captura confirmada | — | Asiento de cobro | — |
| fallido | pagado | payment_provider | Evento de pago confirmado llegado fuera de orden tras un fallo: devolución automática | — | Cobro y reembolso | Cliente |
| vencido | pagado | payment_provider | Pago tardío: se intenta re-reservar stock; si no es posible se inicia reembolso | Re-reserva atómica | Cobro o reembolso | Cliente |
| pagado | reembolso_pendiente | system, support, finance | Cancelación/rechazo/resolución | — | Solicitud de reembolso idempotente | Cliente |
| reembolso_pendiente | reembolsado | payment_provider, finance | Confirmación del proveedor o del proceso manual autorizado | — | Asiento de reembolso | Cliente |
| reembolso_pendiente | parcialmente_reembolsado | payment_provider, finance | Confirmación de reembolso parcial | — | Asiento de reembolso | Cliente |
| parcialmente_reembolsado | reembolso_pendiente | system, support, finance | Nuevo reembolso sobre el saldo | — | — | — |

