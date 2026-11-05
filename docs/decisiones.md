# Registro de decisiones

Fecha de inicio: 2026-11-05 (America/Lima). Cada decisión puede revisarse; se indica el motivo.

## Producto y negocio (supuestos de trabajo)

| # | Decisión / supuesto | Motivo | Validar con |
|---|---|---|---|
| N1 | Nombre provisional **Aquisito**, sin afirmar disponibilidad de marca ni dominio. | Indicado en el encargo. | Titular (INDECOPI marcas, registro de dominio). |
| N2 | Modelo **plataforma intermediaria**: el comercio vende los productos; la plataforma cobra comisión, tarifa de servicio y gestiona el reparto. | Hipótesis del encargo. Afecta comprobantes, contratos y flujo de fondos. | Asesoría contable/legal y contrato con la pasarela. |
| N3 | Un pedido = una sucursal. Cambiar de comercio exige confirmar reemplazo del carrito (`CART_OTHER_BRANCH`). | Evita mezclar inventarios y cobros. | — |
| N4 | Sin pedidos interurbanos: dirección y sucursal deben pertenecer a la misma ciudad y a una zona vigente de esa ciudad. | Encargo §2 y §6. | — |
| N5 | Precios, comisiones (12 %), tarifas (S/ 4 base, 1.5 km incluidos, S/ 1.50/km), mínimos, polígonos y horarios son **ficticios** y editables. | Encargo §2. | Negocio antes de lanzar. |
| N6 | Primera versión: **sin regalos a terceros** con alcohol; destinatario = comprador verificado. | Encargo §12C. | — |
| N7 | Política inicial ante entrega de alcohol rechazada: **no se entrega el pedido completo** (aunque sea mixto), retorna al comercio y soporte resuelve por concepto. Sugerencia registrada en la incidencia: reembolsar productos, servicio y propina; retener tarifa de reparto si fue informada. | Encargo §12E. No hay pérdida automática del dinero. | Asesoría de consumo; texto mostrado antes del pago. |
| N8 | Sustituciones por faltante: solo **retirar** o **sustituir por igual o menor precio**; nunca por un producto con alcohol (se exige nueva compra). | Evita cambiar importes en silencio y atajos de alcohol. | Comercios piloto. |
| N9 | Pedidos programados: **stock reservado y pago cobrado al confirmar**; capacidad por franja (`scheduled_slot_bookings`); restricciones de alcohol revalidadas al aceptar y al preparar. | Simple, coherente con reservas atómicas. | Negocio (¿cobro diferido?). |
| N10 | Propina opcional, **sin preselección**, 100 % al repartidor. | Encargo §5. | — |
| N11 | Plazo del Libro de Reclamaciones: **15 días hábiles** (excluye fines de semana y feriados de `peru_holidays`). Plazos ARCO orientativos: acceso 20 días hábiles, otros 10. | Información de Indecopi citada; Ley 29733 (a verificar). | Asesoría. |
| N12 | La referencia "Kiwi" se toma como **Kiwi Pedidos (provisional)**; no se le atribuyen funciones ni presencia en Perú. | Encargo §3. | Solicitante. |

## Técnicas

| # | Decisión | Alternativas | Motivo |
|---|---|---|---|
| T1 | Monorepo pnpm 10, TypeScript 5.9, `node-linker=hoisted`. | Turborepo/Nx | Suficiente; hoisted evita problemas de Metro/Expo con pnpm. |
| T2 | **Versiones estables conocidas, no las mayores recién publicadas**: Next 15.5.28, React 19.1, NestJS 11.1, Expo SDK 54 / RN 0.81.5, Zod 4.1, Vitest 3.2, Playwright 1.63 (coincide con el Chromium instalado). TypeScript 7, Next 16, Nest 12 y Expo 58 existían pero son mayores con cambios no verificados. | Últimas | Riesgo de incompatibilidades no documentadas. Ruta de actualización: subir una mayor por vez con la suite completa. Next 15.5.4 se reemplazó por 15.5.28 (la primera figuraba como *deprecated* por aviso de seguridad). |
| T3 | **SQL-first**: migraciones SQL numeradas con runner propio (`schema_migrations`, advisory lock) y consultas parametrizadas con `pg`. **No se usa un ORM**. | Prisma, Drizzle | Las garantías críticas (UPDATE condicionales de stock/cupones, índices únicos parciales, CHECK, vistas, PostGIS, `FOR UPDATE`, `SKIP LOCKED`) se expresan mejor en SQL explícito; Prisma requiere binarios externos. Desvío consciente del "ORM" sugerido; la reproducibilidad de migraciones se mantiene. |
| T4 | Monolito modular NestJS con módulos: identidad, geo/cobertura, catálogo, pedidos, inventario, despacho, pagos, alcohol, soporte, finanzas (libro/liquidaciones), notificaciones, admin. | Microservicios | Encargo §4. |
| T5 | **Sin Redis** en el piloto: cola y jobs con PostgreSQL (outbox + `FOR UPDATE SKIP LOCKED` + advisory lock entre instancias), tiempo real con `LISTEN/NOTIFY`. | Redis + BullMQ | No justificado para 100 sesiones / 20 pedidos/min; menos infraestructura. Revisar si la carga crece. |
| T6 | Tiempo real por **SSE** con eventos mínimos (`{type, orderId, version}`) y recuperación consultando la API. Apps móviles: sondeo cada 8–10 s. | WebSockets | SSE basta para servidor→cliente; nunca transporta datos personales. |
| T7 | Validación con **zod** compartida; registro único de endpoints → OpenAPI 3.1 generado y cliente tipado. Un test exige que registro y rutas Nest coincidan. | @nestjs/swagger | Una sola fuente de verdad para API, web y móvil. |
| T8 | Sesiones **opacas** (hash SHA-256 en BD, revocables por dispositivo). Web: cookie httpOnly SameSite=Lax + CSRF de doble envío vía proxy de mismo origen. Móvil: Bearer en SecureStore. Contraseñas con **scrypt**. TOTP (RFC 6238) propio con anti-reutilización por paso. | JWT | Revocación inmediata; sin dependencias nativas. |
| T9 | Roles sensibles (admin, finanzas) **exigen TOTP** cuando son la única vía de acceso a la ruta. | — | Encargo §7. |
| T10 | Dinero en **céntimos enteros** (`bigint`); `CHECK` del total del pedido; reparto de descuentos por mayor resto. | numeric | Exactitud y simplicidad. |
| T11 | Inventario por **SKU** (`on_hand`, `reserved`, `CHECK reserved <= on_hand`); reserva con `UPDATE ... WHERE on_hand - reserved >= q`, en orden de `sku_id`. Combos consumen SKU de sus componentes; restricción de alcohol **derivada** por la vista `v_product_restriction`. | Stock por combo | Encargo §13. |
| T12 | Asignación: una oferta abierta por pedido y por repartidor; **una entrega activa por pedido y por repartidor** (índices únicos parciales). Capacidad 1 en v1. | Ofertas en difusión | Simple y demostrablemente atómico. |
| T13 | Pagos: interfaz de proveedor (crear, consultar, verificar webhook, reembolsar). **Sandbox** = simulador con estado propio y webhooks HMAC (solo dev/test). **Culqi**: código escrito; la autenticidad del webhook se establece **consultando la operación a la API** (no se inventa una firma). Reembolsos se registran en la transacción y se ejecutan fuera de ella por un job. | — | Encargo §14. |
| T14 | Libro de movimientos **inmutable** (trigger que impide UPDATE/DELETE) y `settlement_items.ledger_entry_id UNIQUE` para no liquidar dos veces. | — | Encargo §15. |
| T15 | Rutas: adaptador `haversine × 1.3` etiquetado "aproximado" por defecto; adaptador OSRM para servidor propio. Mapas web: Leaflet con teselas configurables (OSM público solo en desarrollo). | Google Maps, Mapbox | Sin contrato aún; no se usa infraestructura pública gratuita como si fuera ilimitada. |
| T16 | Apps móviles sin librería de navegación (estado propio) y sin mapa nativo embebido (enlace a mapa externo). | expo-router, react-native-maps | Menos configuración nativa en el primer corte; ampliar en la siguiente etapa. |
| T17 | Archivos: almacenamiento privado (disco local en dev, S3 en prod) con **enlaces firmados de 5 min**; tipo validado por firma de bytes; 5 MB. Sin fotos de DNI por defecto. | — | Encargo §12B, §20. |
| T18 | Web de repartidor (`/repartidor`) como **vista de apoyo** (y para pruebas E2E). La app principal es `courier-mobile`. | — | El encargo pide app móvil; la web no demuestra segundo plano. |

## Preguntas comerciales pendientes (no bloquean el desarrollo)

1. Titular del negocio, razón social y RUC que aparecerán en el Libro de Reclamaciones y comprobantes.
2. ¿La plataforma cobra centralizadamente y liquida a comercios (marketplace) o cada comercio cobra? Requiere validar con Culqi u otra pasarela si admiten el modelo.
3. Tarifas reales, comisiones por comercio, quién financia promociones, topes de efectivo.
4. Polígonos de cobertura reales y jurisdicciones aplicables (Padre Abad; Rupa-Rupa, Castillo Grande y otros distritos de Leoncio Prado).
5. Horarios de venta de alcohol vigentes por ordenanza, con fuente y fecha; comercios con licencia.
6. Proveedor de verificación de identidad (o procedimiento humano definitivo) y política de retención.
7. Proveedor de facturación electrónica (OSE/PSE) y tratamiento tributario de comisiones y reparto.
8. Contratos con repartidores (independientes o no), seguros y capacitación.
9. Proveedor de SMS, correo y mapas/rutas; presupuesto mensual.
10. ¿Se habilita transferencia manual? ¿Cobro diferido en pedidos programados?
