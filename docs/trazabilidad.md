# Matriz de trazabilidad

Estados: **Probado** (implementado y cubierto por prueba automatizada que pasa), **Implementado**
(código funcional verificado manualmente o indirectamente, sin prueba dedicada), **Bloqueado**
(código listo; falta credencial/contrato/dispositivo externo), **Pendiente** (no implementado).

Pruebas: `A-xx` = `apps/api/test/acceptance.test.ts` (criterio xx), `R` = `routes.test.ts`,
`U` = `packages/contracts/src/rules.test.ts`, `E2E-n` = `apps/web/e2e/circuito.spec.ts`.

| Requisito (§) | Pantalla | Endpoint(s) | Entidades | Prueba | Estado |
|---|---|---|---|---|---|
| Circuito completo Aguaytía (§23-01) | web `/`, `/tienda`, `/carrito`, `/pedidos/[id]`, `/comercio`, `/repartidor`, `/admin` | cart, quote, orders, payments, merchant/*, courier/*, admin/orders | orders, order_lines, payments, deliveries, ledger_entries | A-01, E2E-1 | Probado |
| Circuito Tingo María con efectivo (§23-02) | idem | idem + deliver (cashCollectedCents) | cash_collections | A-02 | Probado |
| Cobertura por polígono, ciudad, jurisdicción, suspensión (§6, §23-03) | `/`, `/cuenta#direcciones` | coverage/check, cities/:id/zones, admin/zones/:id/suspensions | zones, zone_versions, jurisdictions, zone_suspensions | A-03, E2E-3 | Probado |
| Zonas versionadas (§6) | `/admin` › Ciudades | admin/zones/:id/versions | zone_versions | — | Implementado |
| Pausa por ciudad/sucursal (§11) | `/admin`, `/comercio` | admin/cities/:id, merchant/branches/:id/pause | cities, branches | indirecta | Implementado |
| Tarifa: base + km + recargo + mínimo + distancia máx. (§6) | `/carrito` | checkout/quotes | delivery_fee_rules, quotes | U, A-06 | Probado |
| Cotización con versión y vencimiento; cambio exige nueva aceptación (§6) | `/carrito` | checkout/quotes, orders | quotes | A-06 | Probado |
| Roles y ámbitos en backend (§7) | todas | guard + branchAccess/assertCityScope | memberships | A-04, A-05, A-03 | Probado |
| OTP con caducidad, intentos y límite (§7) | `/cuenta` | auth/otp/* | otp_challenges | A-extras | Probado (SMS real: Bloqueado) |
| Recuperación de contraseña, revocación de dispositivos (§7) | `/cuenta` | auth/password/*, auth/sessions | password_resets, sessions | A-extras (sesiones) | Probado / correo real Bloqueado |
| TOTP para admin y finanzas (§7) | `/cuenta`, `/admin` | auth/mfa/* | mfa_totp | A-25 | Probado |
| Catálogo, variantes, adicionales, notas (§8) | `/tienda/[id]` | stores/:id, products/:id, cart | products, product_variants, modifier_* | A-06, E2E-1 | Probado |
| Búsqueda, filtros, favoritos, recompra (§8) | `/buscar`, `/`, `/cuenta`, `/pedidos/[id]` | search, stores, me/favorites, orders/:id/reorder | favorites | A-18 (búsqueda) | Implementado |
| Pedidos programados por franja con capacidad (§8) | `/carrito` | stores/:id/slots, quotes | scheduled_slot_bookings | A-21 | Probado |
| Cancelación según estado, reembolso (§8, §16) | `/pedidos/[id]` | orders/:id/cancel | refunds | A-23 | Probado |
| Incidencias con evidencia de acceso limitado (§8) | `/pedidos/[id]`, `/admin` | orders/:id/incidents, files | incidents, documents | A-20, A-26 | Probado |
| Mensajes dentro de la plataforma (§8) | `/pedidos/[id]` | orders/:id/messages | order_messages | — | Implementado |
| Valoración solo de completados (§8) | `/pedidos/[id]` | orders/:id/rating | ratings | — | Implementado |
| Alta de comercio y aprobación (§9) | `/comercio/alta`, `/admin` | merchant/applications, admin/merchants/:id/review | merchants, branches | — | Implementado |
| Bandeja en tiempo real, aceptar/rechazar con motivo, vencimiento de aceptación (§9) | `/comercio` | merchant/orders/*, realtime | orders | A-01, A-04, job expireAcceptance | Probado (vencimiento: Implementado) |
| Faltantes con aceptación del cliente; sin alcohol como sustituto (§9) | `/comercio`, `/pedidos/[id]` | merchant/orders/:id/substitutions, orders/:id/substitutions/:sid/respond | substitutions | A-extras | Probado |
| Productos, stock por SKU, combos con componentes (§9, §13) | `/comercio` | merchant/* | skus, inventory, combo_components | A-08, A-09, A-17 | Probado |
| Comanda imprimible, exportación CSV con zona horaria (§9, §11) | `/comercio`, `/admin` | merchant/orders/:id/ticket, export.csv | — | A-04 (aislamiento) | Implementado |
| Operadores con cuenta propia (§9) | `/comercio` | merchant/branches/:id/operators | memberships | A-04 | Probado |
| Registro de repartidor, 18+, revisión manual, términos (§10) | `/repartidor/postular`, `/admin` | courier/applications, admin/couriers/:id/review | couriers | — | Implementado |
| Ofertas sin datos personales, vencimiento, aceptación atómica (§10, §11) | `/repartidor`, app repartidor | courier/offers/* | delivery_offers, deliveries | A-05, A-10 | Probado |
| Recojo con código y paquetes; entrega con código de un solo uso (§10) | `/repartidor`, app | courier/deliveries/:id/* | orders, delivery_code_attempts | A-01, A-02 | Probado |
| Cliente ausente, dirección incorrecta, accidente, avería, devolución (§10) | `/repartidor`, app | courier/deliveries/:id/fail, merchant return-inspection | incidents | A-20 (retorno) | Implementado |
| Ubicación con consentimiento, precisión, timestamp; desactualizada (§10, §19) | `/repartidor`, `/pedidos/[id]`, apps | courier/location, orders/:id/tracking | courier_locations | A-01 (tracking), E2E-1 | Probado (web). **Segundo plano nativo: Bloqueado (dispositivo)** |
| Ganancias, propinas, efectivo por rendir (§10) | `/repartidor`, app | courier/earnings | ledger_entries | A-01, A-02 | Probado |
| Asignación manual y reasignación con historial (§11) | `/admin` | admin/orders/:id/assign, unassign | deliveries, audit_log | A-10 | Probado |
| Indicadores documentados (§11) | `/admin` › Indicadores | admin/dashboard | orders, ledger_entries | E2E-1 | Implementado |
| Auditoría de cambios críticos con motivo (§11) | `/admin` › Auditoría | admin/audit | audit_log (inmutable) | indirecta | Implementado |
| Alcohol: acceso solo verificado; estados de edad separados (§12A) | `/tienda`, `/cuenta` | age-verifications, admin/age-verifications | age_verifications | A-15, A-16, A-17, A-18, E2E-2 | Probado |
| Cambio de identidad revoca (§12A) | `/cuenta` | PATCH /me | age_verifications | A-extras | Probado |
| Verificación por revisión humana documentada (§12B) | `/admin` › Verificación | admin/age-verifications/:id/decide | age_verifications | A-16 | Probado (proveedor de identidad: Bloqueado) |
| Entrega presencial obligatoria; bloqueo de "entregado" (§12C) | `/repartidor`, app | courier/.../age-check, deliver | door_age_checks | A-19 | Probado |
| Rechazo → incidencia, retorno, resolución trazable (§12C/E) | `/repartidor`, `/comercio`, `/admin` | age-check, return-inspection, incidents/:id/resolve | incidents, refunds, ledger | A-20 | Probado |
| Horarios por jurisdicción, prohibiciones, fuente y responsable; solo reglas validadas en prod (§12D) | `/admin` › Ciudades | admin/alcohol-rules, alcohol-blackouts | alcohol_rules, alcohol_blackouts | A-alcohol, A-21, A-30 | Probado |
| Mensajes legales visibles (§12E) | `/tienda`, `/carrito`, apps | — | — | A-19 (texto en cotización) | Probado |
| Capacitación de repartidores registrada (§12E) | `/admin` › Repartidores | admin/couriers/:id/training | courier_trainings | — | Implementado |
| Cupones con presupuesto, cupos, concurrencia; total ≥ 0 (§13) | `/carrito`, `/admin` › Cupones | quotes, orders, admin/coupons | coupons, coupon_redemptions | A-24 | Probado |
| Idempotencia de pedido y pago (§14) | `/carrito` | orders, payments | orders (UNIQUE), payments (UNIQUE parcial) | A-11 | Probado |
| Webhooks: autenticidad, deduplicación, importe, fuera de orden (§14) | — | webhooks/payments/:provider | payment_events | A-12 | Probado (sandbox). Culqi: Bloqueado |
| Respuesta incierta → conciliación (§14) | `/admin` › Finanzas | admin/payments/reconcile | payments | A-13 | Probado |
| Pago tardío → devolución (§14) | — | jobs expireUnpaid + webhook | refunds | A-14 | Probado |
| Efectivo: monto, cambio, cobro, responsable, saldo (§14) | `/carrito`, `/repartidor` | deliver | cash_collections, ledger | A-02 | Probado |
| Transferencia manual pendiente de conciliación (§14) | `/admin` | admin/payments/:id/confirm-manual | payments | — | Implementado (deshabilitado por defecto) |
| Comisiones con vigencia, libro inmutable, liquidaciones reproducibles (§15) | `/admin` › Finanzas, `/comercio` › Ventas | admin/commissions, settlements, ledger | commission_rules, ledger_entries, settlements, settlement_items | A-01, A-25 | Probado |
| Comprobantes electrónicos SUNAT (§15) | `/carrito` (captura de datos) | — | orders.invoice_* | — | **Bloqueado** (proveedor OSE/PSE) |
| Tres ciclos de estado con tabla de transiciones (§16) | — | — | order_status_history | U, A-extras | Probado |
| Notificaciones internas persistentes + outbox con reintentos (§19) | `/cuenta` | notifications | notifications, outbox_events | A-01, A-18 | Probado. Push: Bloqueado |
| Conectividad: aviso de desconexión; sin confirmación local (§19, §23-22) | web (banner), apps | — | — | A-22, E2E-4 | Probado |
| Logs sin datos sensibles (§20, §23-26) | — | — | — | A-26 | Probado |
| Archivos privados con enlace temporal y titularidad verificada (§20) | — | files, files/:id/url | documents | A-26 | Probado |
| Documentos de comercio, sucursal y repartidor con revisión y vencimiento (§9, §10, §12D) | `/comercio` › Documentos, `/repartidor`, `/admin` › Documentos | files, merchant/branches/:id/documents, courier/documents, admin/documents | documents | A-docs | Probado |
| Habilitación de alcohol exige documento vigente; suspensión automática al vencer (§12D) | `/admin` › Comercios | admin/branches/:id/alcohol-permit, job expireDocuments | branches, documents | A-docs | Probado |
| Banners con condiciones visibles; alcohol solo a adultos verificados (§5, §11, §12A) | `/` (inicio web y app), `/admin` › Banners | banners, admin/banners | banners | A-banners | Probado |
| Aviso de proximidad del repartidor (§19) | notificaciones | courier/location → outbox | order_nearby_notices | A-proximidad | Probado |
| Rechazo automático si el comercio no responde (§9) | `/comercio` | job expireAcceptance | orders | A-vencimiento | Probado |
| Alertas de reclamaciones al personal (§20) | `/cuenta` (staff) | job complaintAlerts → outbox | notifications | A-reclamaciones | Probado |
| Selección explícita de variantes/adicionales/combos en app cliente; verificación de edad y push en apps (§8) | apps móviles | putCart, age-verifications, me/push-tokens | — | tsc + bundle | Implementado (push real: Bloqueado) |
| Libro de Reclamaciones con correlativo y plazo (§20, §23-27) | `/reclamaciones`, `/admin` | complaints | complaints, complaint_counters | A-27 | Probado |
| ARCO y eliminación con retención (§20, §23-27) | `/cuenta`, `/admin` | me/data-requests, admin/data-requests | data_requests | A-27 | Probado |
| Rendimiento p95 < 800 ms (§21) | — | — | — | `infra/scripts/load-test.mjs` | Medido (local; ver informe) |
| Respaldo y restauración (§21, §23-29) | — | — | — | `infra/scripts/restore-drill.sh` | Probado |
| Apps móviles compilan (§23-28) | apps | — | — | `tsc` + `expo export` | Probado (bundle JS). APK/IPA nativos: **Bloqueado** |
| Producción rechaza simuladores y demo (§23-30) | — | — | — | A-30 + `main.ts` | Probado |
| Registro endpoints = rutas (§18) | — | todas | — | R | Probado |
