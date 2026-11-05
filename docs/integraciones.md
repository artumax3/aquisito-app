# Registro de integraciones externas

Nada de esta tabla está habilitado para operación real. "Código" indica el estado del código en el
repositorio; "Evidencia" lo que efectivamente se probó en esta sesión.

| Proveedor | Función | Código | Evidencia de prueba | Credencial / contrato pendiente | Costo (a verificar) |
|---|---|---|---|---|---|
| **Sandbox (propio)** | Simulador de pasarela: cargos, consulta, webhooks HMAC, reembolsos | `apps/api/src/providers/payments.ts` `SandboxProvider` | Pruebas A-01, A-11..A-14, A-20, A-23, E2E-1 | Ninguna. **Prohibido fuera de development/test** (el API no arranca) | — |
| **Culqi** | Tarjetas (token de Culqi Checkout/Culqi.js), billeteras Yape/Plin vía órdenes de pago, consulta de estado, reembolsos | `CulqiProvider` (cargos `/charges`, órdenes `/orders`, `/refunds`; verificación de webhook consultando la operación) + checkout web `apps/web/components/culqi.tsx` (JS v4) + `GET /payments/config` | 7 pruebas contra **servidor simulado local** (éxito, rechazo, 5xx incierto, idempotencia, consulta, webhook falsificado, reembolso). **Ninguna contra la API real** ni del checkout JS. En móvil, pago digital deshabilitado salvo simulador hasta integrar SDK | Contrato de afiliación, llaves `sk_`/`pk_`, habilitación de billeteras, URL de webhook, validar si admite modelo marketplace/split | Blogs consultados (no oficiales, cifras contradictorias): ~3.44 %–3.99 % + IGV por tarjeta nacional, con o sin fijo; Yape distinto. **Confirmar en contrato** |
| **Twilio** (SMS) | OTP por SMS | `TwilioSms` en `providers/messaging.ts` (`TWILIO_API_URL` configurable) | Prueba contra servidor simulado local (autenticación básica, campos). Ninguna real. OTP probado con simulador `console` (A-extras) | Cuenta, remitente habilitado para Perú, `TWILIO_*` | Referencias de terceros: ~US$0.13–0.23 por SMS a Perú según operador. Ver página oficial |
| **Correo** (por elegir) | Recuperación de contraseña, copia de reclamaciones | Interfaz `EmailProvider`; simulador `console` en dev | Simulador | Elegir proveedor (SES, Postmark, etc.) e implementar adaptador | — |
| **Expo Push** | Push a apps móviles | `sendPush` (HTTP a exp.host), registro de tokens `POST /me/push-tokens`, `src/push.ts` en ambas apps (permiso explícito, canal Android privado) | Ninguna (no hay compilación nativa ni `extra.eas.projectId`) | Proyecto EAS, FCM (Android) y APNs (iOS), `EXPO_ACCESS_TOKEN` | Gratis según Expo (verificar límites) |
| **OSRM** | Distancia por ruta | `providers/geo.ts` | Ninguna (sin servidor) | Servidor OSRM propio con extracto OSM de Perú | Costo de servidor |
| **Teselas de mapa** | Mapas web y móviles | Leaflet (web) y Leaflet en WebView (apps, `extra.mapTileUrl`) | OSM público **solo en desarrollo**; en este entorno el proxy bloquea `tile.openstreetmap.org`, por eso las capturas no muestran teselas | Proveedor de teselas con cuota (MapTiler, Stadia, propio) | Según plan |
| **S3 compatible** | Documentos y evidencias privados | `S3Storage` (presigned URLs) | Ninguna contra bucket real; probado adaptador local | Bucket privado con cifrado, credenciales | Según proveedor |
| **Verificación de identidad** | Mayoría de edad | No hay proveedor; **revisión humana documentada** | A-15, A-16 | Si se contrata: proveedor autorizado. **No hay conexión con RENIEC** | — |
| **Facturación electrónica (OSE/PSE)** | Boletas/facturas SUNAT | Solo captura de datos del comprobante en el pedido | — | Elegir proveedor autorizado; RUC del titular | Según proveedor |
| **Google Play / App Store** | Publicación de apps | `app.json` listos | Bundle JS exportado | Cuentas de desarrollador del titular, fichas, políticas de privacidad, permisos de ubicación en segundo plano (revisión de Google) | Referencias de terceros 2026: Google US$25 único; Apple US$99/año |

Fuentes consultadas el 2026-11-05 (no oficiales salvo indicación; verificar antes de decidir):
kom.pe (pasarelas de pago en Perú 2026), guiadesoftware.com (pasarelas en Perú),
twilio.com/sms/pricing/pe (página oficial, sin cifra visible en el resultado), plivo.com/sms/pricing/pe,
magora-systems.com (tarifas de Google Play y Apple), splitmetrics.com.
