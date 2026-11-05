# Avance

Última actualización: 2026-11-05 (segunda sesión de trabajo).

## Estado por etapa

| Etapa | Estado | Notas |
|---|---|---|
| 1. Estructura, BD, autenticación, permisos, arranque | ✅ | Monorepo, migración PostGIS, sesiones revocables, OTP, TOTP, roles con ámbito, guardia de producción |
| 2. Circuito ordinario en cuatro módulos y dos ciudades | ✅ | Probado por API (A-01/02) y navegador (E2E-1) |
| 3. Pagos, cotizaciones, conciliación, cancelaciones, reembolsos, cupones, libro, liquidaciones | ✅ con simulador | Culqi escrito, **sin probar** (sin credenciales) |
| 4. Alcohol, verificación de edad, reglas, documentación de comercios, combos, rechazo de entrega | ✅ | Proveedor de identidad: no contratado (revisión humana) |
| 5. Apps móviles, mapas, ubicación, notificaciones, programados, soporte, Libro de Reclamaciones | 🟡 | Apps compilan (bundle); falta compilación nativa, prueba en dispositivo, push real, mapa nativo embebido |
| 6. Validación, seguridad, rendimiento, restauración, despliegue de ensayo | 🟡 | Pruebas, carga local y restauración hechas; **despliegue de ensayo no realizado** |

## Completado
- API NestJS con 135 rutas documentadas (OpenAPI generado) y registro verificado contra rutas reales.
- Web: cliente (inicio, tienda, carrito/checkout, pedidos con seguimiento, búsqueda, cuenta, reclamaciones, borradores legales), panel de comercio, administración/despacho, vista de repartidor.
- Apps Expo de cliente y repartidor.
- 61 pruebas automatizadas (10 unitarias, 47 API, 4 E2E) pasando; ensayo de restauración; prueba de carga.
- Segunda iteración: documentos con revisión y vencimiento (y suspensión automática del permiso de alcohol), corrección de seguridad en la subida de archivos (titularidad), banners con filtro de alcohol, aviso de proximidad, alertas de reclamaciones al personal, selección explícita de producto en la app cliente, verificación de edad y registro push en las apps, prueba E2E de pérdida de conexión, optimización del listado de comercios.
- Documentación: decisiones, trazabilidad, estados (generado), finanzas, indicadores, política de edad, integraciones, costos, manuales, borradores legales, despliegue, diseño.

## Bloqueos (requieren acción del titular)
1. Contrato y llaves de pasarela (Culqi u otra) y validación del modelo marketplace.
2. Proveedor de SMS con remitente para Perú; proveedor de correo.
3. Proyecto EAS / Android SDK y dispositivos para compilación nativa y prueba de segundo plano; cuentas de Google Play y Apple.
4. Reglas horarias de alcohol verificadas (fuente, fecha, responsable) y habilitaciones de comercios.
5. Polígonos reales y tarifas/comisiones del negocio.
6. Proveedor de facturación electrónica; datos del titular (RUC, razón social) para Libro de Reclamaciones y comprobantes.
7. Elección de proveedor de despliegue y base gestionada con PostGIS.

## Siguiente paso recomendado
1. Compilar `courier-mobile` con `expo run:android` en un dispositivo Android de gama media y verificar ubicación en segundo plano (registrar modelo, versión de Android y resultados).
2. Desplegar un entorno de ensayo (staging) con Culqi en modo prueba y repetir la prueba de carga allí.
3. Optimizar `priceItems` (carga por lotes) para reducir los valores atípicos de `PUT /cart`.
4. Añadir mapa nativo (react-native-maps o MapLibre) y SSE/WebSocket en móvil.
