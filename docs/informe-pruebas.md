# Informe de pruebas

**Fecha:** 2026-11-05 · **Entorno:** contenedor Linux de desarrollo (4 vCPU, 15 GB RAM), Node 22.23,
PostgreSQL 16.15 + PostGIS 3.4 locales, Chromium headless (Playwright 1.63). **No** es un entorno
de ensayo desplegado. Proveedores externos: ninguno real (simuladores de desarrollo).

## Comandos ejecutados y resultados

| Comando | Resultado |
|---|---|
| `pnpm -r typecheck` | 7/7 paquetes sin errores (contracts, api-client, config, api, web, customer-mobile, courier-mobile) |
| `pnpm --filter @aquisito/contracts test` | **10/10** (edad por fecha completa y 29-feb, hora de Lima vs UTC, franjas que cruzan medianoche, reparto de descuentos, tarifa, stock de combo, máquinas de estado) |
| `pnpm --filter @aquisito/api test` | **42/42** en 2 archivos (~10 s): 41 de aceptación contra PostgreSQL real + 1 de correspondencia registro↔rutas |
| `pnpm --filter @aquisito/web build` | OK, 15 rutas |
| `pnpm --filter @aquisito/web test:e2e` | **3/3** (circuito completo en 4 módulos; ocultamiento de alcohol; comercio cerrado y fuera de cobertura) |
| `npx expo export --platform android` (cliente y repartidor) | OK: bundles Hermes de 2.37 MB y 2.36 MB |
| `bash infra/scripts/restore-drill.sh` | OK: `pedidos|movimientos|suma|mov_inventario|stock|items = 19|38|10800|19|669|2` idéntico en origen y restaurada; 0 pedidos con total inconsistente; 0 filas de stock inválidas |
| `APP_ENV=production node dist/main.js` | Aborta listando 7 problemas (simuladores, demo, clave de cifrado, cookies, almacenamiento) |
| `APP_ENV=staging` con configuración válida | Aborta: "Hay 22 usuarios de demostración activos" |
| `node infra/scripts/load-test.mjs` (60 s) | Ver tabla de rendimiento |

## Cobertura de criterios de aceptación (§23)

| # | Resultado | Evidencia |
|---|---|---|
| 01 | ✅ | A-01 (API) y E2E-1 (navegador: cliente → pago simulado → comercio → repartidor con geolocalización emulada → entrega con código → admin ve asientos) |
| 02 | ✅ | A-02, Tingo María con efectivo (cobro insuficiente rechazado; efectivo por rendir) |
| 03 | ✅ | A-03: fuera de polígono, entre ciudades, punto de otra ciudad, zona suspendida, despachador fuera de ámbito |
| 04 | ✅ | A-04: 404 en pedidos, catálogo, reporte, CSV, ticket y aceptación de otro comercio |
| 05 | ✅ | A-05: oferta sin datos del cliente; otro repartidor recibe 404 al operar/ver |
| 06 | ✅ | A-06: precios enviados ignorados; cambio de precio → `QUOTE_CHANGED` con versión 2 |
| 07 | ✅ | A-07: dos compras simultáneas de la última unidad → exactamente una |
| 08 | ✅ | A-08: 2 combos (4 gaseosas) + 1 suelta = 5 reservadas; la 6.ª rechazada; liberación al cancelar |
| 09 | ✅ | A-09: componente agotado tras cotizar → confirmación rechazada |
| 10 | ✅ | A-10: aceptación del repartidor y asignación manual en paralelo → 1 entrega activa |
| 11 | ✅ | A-11: 3 confirmaciones simultáneas con la misma clave → 1 pedido (201 + 200 repetidos); 3 pagos simultáneos → 1 intento |
| 12 | ✅ | A-12: firma inválida 401; importe distinto → revisión; duplicado ignorado; "failed" tardío no revierte |
| 13 | ✅ | A-13: timeout → `en_conciliacion`; reintento no crea cargo; conciliación confirma |
| 14 | ✅ | A-14: pago tras vencimiento → devolución automática confirmada |
| 15 | ✅ | A-15: menor, no verificado, revocado y anónimo no pueden; autoaprobación 403 |
| 16 | ✅ | U + A-16: cumple 18 mañana → rechazado; cumple hoy → aprobado |
| 17 | ✅ | A-17: combo en categoría "ofertas" hereda restricción |
| 18 | ✅ | A-18: enlace directo 404, búsqueda vacía, notificaciones sin detalles en pantalla bloqueada; E2E-2 |
| 19 | ✅ | A-19: `AGE_CHECK_REQUIRED` sin verificación aprobada; aprobación incompleta 422 |
| 20 | ✅ | A-20: rechazo → incidencia, retorno, inspección (re-stock 1 vez), reembolso de productos trazable en el libro |
| 21 | ✅ | A-21: viernes 18:00–02:00 cubre sábado 01:30; cierre especial; pedido programado con alcohol sin reglas → rechazado |
| 22 | ⚠️ parcial | A-22 verifica eventos mínimos y que no se confirma nada sin servidor; la UI muestra desconexión. No hay prueba E2E de corte de red real |
| 23 | ✅ | A-23: doble cancelación simultánea → una; stock restaurado exacto; un solo reembolso |
| 24 | ✅ | A-24: 3 usos simultáneos de un cupón de 1 uso → 1; descuento limitado al subtotal |
| 25 | ✅ | A-25: liquidación idempotente, sin solapamiento, libro inmutable, MFA exigido |
| 26 | ✅ | A-26: logs redactados; archivos solo con enlace firmado; tipo validado por bytes |
| 27 | ✅ | A-27: correlativo, constancia y fecha; eliminación anonimiza y revoca sesión |
| 28 | ⚠️ parcial | Ambas apps compilan (TypeScript + bundle Android Hermes). **No** se compiló APK/IPA nativo ni se probó en dispositivo; **no** se probó ubicación en segundo plano. Plataformas probadas: ninguna en dispositivo |
| 29 | ✅ | `restore-drill.sh` |
| 30 | ✅ | A-30 + arranque real en production/staging |

## Rendimiento (§21)

Escenario (supuesto de ingeniería, no demanda real): 100 sesiones navegando + ~19 confirmaciones de
pedido por minuto, 60 s, API local con datos demo, jobs activos, sin proveedores externos (sandbox
interno). Generador en la misma máquina (comparte CPU con el API), una sola IP
(`RATE_LIMIT_PER_MINUTE` elevado solo para la medición).

| Operación | n | p50 ms | p95 ms | errores |
|---|---:|---:|---:|---:|
| GET /stores (con cálculo de envío) | 4083 | 39 | 124 | 0 |
| GET /stores/:id | 4083 | 62 | 196 | 0 |
| GET /cart | 4083 | 11 | 32 | 0 |
| GET /orders | 4083 | 15 | 79 | 0 |
| GET /search | 4083 | 35 | 90 | 0 |
| PUT /cart | 19 | 33 | 798 | 0 |
| POST /checkout/quotes | 19 | 40 | 246 | 0 |
| POST /orders | 19 | 78 | 663 | 0 |

Todas las p95 < 800 ms en este entorno local; `PUT /cart` quedó al límite (798 ms, muestra pequeña).
**No** extrapolable a un entorno de ensayo: falta repetirlo allí con base gestionada y red real.
Mejoras identificadas: `listStores` evalúa horarios y tarifa por sucursal en serie (N+1);
`priceItems` hace consultas por línea.

## Fallos pendientes y limitaciones conocidas
- Sin pruebas con Culqi, Twilio, Expo Push, S3 real ni OSRM (sin credenciales).
- Sin compilación nativa ni pruebas en dispositivos Android/iOS.
- Sin prueba automatizada de corte de red en el navegador.
- Sin auditoría de accesibilidad con lector de pantalla.
- El limitador de solicitudes es por proceso (en multiinstancia, complementar en el proxy).
