# Estimación de costos (supuestos declarados)

**No es una cotización.** Todas las cifras son órdenes de magnitud para el piloto (supuesto de
ingeniería: 100 sesiones activas, ~20 pedidos/minuto en pico, dos ciudades). Las tarifas de
terceros cambian: verificar en las páginas oficiales y contratos. Los créditos de IA usados para
desarrollar **no cubren** ningún servicio externo.

| Rubro | Supuesto | Rango mensual estimado (USD) | Cómo verificar |
|---|---|---|---|
| Desarrollo con IA | Sesiones de agente para continuar etapas 5–6 | Según plan contratado del titular | Panel de facturación del proveedor de IA |
| Revisión humana | Asesoría legal (consumo, datos, alcohol), contable/tributaria, diseño UX con usuarios locales | Presupuesto puntual, no mensual | Cotizar con profesionales |
| Infraestructura (API + web) | 2 contenedores pequeños (1 vCPU / 1–2 GB) + balanceador con TLS | 20–80 | Proveedor elegido (Render, Fly.io, Railway, AWS, GCP…) |
| Base de datos | PostgreSQL gestionado con PostGIS, respaldos diarios y PITR | 25–100 | Verificar que el proveedor ofrezca PostGIS |
| Almacenamiento S3 | < 10 GB, tráfico bajo | 1–5 | — |
| Mapas y rutas | Teselas con cuota + OSRM propio o API de rutas | 0–50 (+ servidor OSRM 10–30) | Planes de MapTiler/Stadia/Mapbox; condiciones de uso |
| SMS (OTP) | 1–2 SMS por inicio de sesión; p. ej. 3 000 SMS/mes | ~400–700 (a ~US$0.13–0.23 por SMS) | Página oficial de Twilio/Plivo para Perú. Alternativa: priorizar correo + contraseña o WhatsApp con proveedor autorizado |
| Pagos | Comisión por transacción, no mensual | Blogs: ~3.4–4 % + IGV por tarjeta (cifras contradictorias) | Contrato con Culqi u otra pasarela |
| Verificación de identidad | Revisión humana (tiempo del equipo) o proveedor por verificación | Variable | Cotizar proveedor si se contrata |
| Facturación electrónica | OSE/PSE por comprobante o plan | Variable | Proveedor autorizado SUNAT |
| Push | Expo Push | 0 (verificar límites) | Documentación de Expo |
| Publicación móvil | Google Play (único) y Apple (anual) | Google ~US$25 una vez; Apple ~US$99/año (fuentes de terceros 2026) | Páginas oficiales de inscripción |
| Monitoreo/logs | Plan básico de logs/alertas | 0–30 | Proveedor elegido |

Supuestos: tipo de cambio no aplicado (montos en USD); IGV no incluido salvo indicación; el costo
operativo mayor del piloto probablemente sea SMS y personal (soporte, revisión de edad, despacho).
