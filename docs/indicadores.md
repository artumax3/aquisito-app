# Definiciones de indicadores (`GET /admin/dashboard`)

Período por defecto: últimos 30 días; instantes en UTC, presentación en America/Lima. Filtrado por el ámbito de ciudad del usuario.

| Indicador | Definición |
|---|---|
| Pedidos | Pedidos creados en el período (incluye los que luego se cancelaron o vencieron). |
| Completados | `commercial_status = completado`. |
| Tasa de cancelación | (cancelados + rechazados por comercio) / pedidos. |
| **Valor bruto vendido (GMV)** | Suma de `subtotal_cents` (productos) de pedidos completados. **No es ingreso de la plataforma.** |
| **Comisión de plataforma** | Suma de asientos `platform_commission` del período (ingreso propio). |
| Ticket promedio | Total cobrado de pedidos completados / pedidos completados. |
| Reembolsado | Suma de `refunded_cents` de pedidos del período. |
| Mediana de aceptación | Mediana de `accepted_at − confirmed_at` (minutos). |
| Mediana de preparación | Mediana de `ready_at − accepted_at`. |
| Mediana de entrega | Mediana de `delivered_at − picked_up_at`. |
| Recompra | Clientes con 2+ pedidos completados / clientes con 1+ completado, en el período. |
| Salud operativa | Eventos outbox pendientes y fallidos, pagos en conciliación, reembolsos pendientes, pedidos activos con más de 2 h, incidencias abiertas, reclamaciones que vencen en ≤ 3 días. |

Todos los valores provienen de los registros reales del entorno; no hay cifras simuladas en el tablero.
