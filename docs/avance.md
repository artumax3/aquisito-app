# Avance

Última actualización: 2026-11-05.

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
- 55 pruebas automatizadas (10 unitarias, 42 API, 3 E2E) pasando; ensayo de restauración; prueba de carga.
- Documentación: decisiones, trazabilidad, estados (generado), finanzas, indicadores, política de edad, integraciones, costos, manuales, borradores legales, despliegue, diseño.

## Bloqueos (requieren acción del titular)
1. **Push a GitHub**: el acceso de esta sesión al repositorio `artumax3/aquisito-app` devuelve 403 (la app de GitHub de Claude no está instalada/vinculada para ese repositorio). Los commits existen localmente en la rama `claude/delivery-platform-peru-pv8mev`.
2. Contrato y llaves de pasarela (Culqi u otra) y validación del modelo marketplace.
3. Proveedor de SMS con remitente para Perú; proveedor de correo.
4. Proyecto EAS / Android SDK y dispositivos para compilación nativa y prueba de segundo plano; cuentas de Google Play y Apple.
5. Reglas horarias de alcohol verificadas (fuente, fecha, responsable) y habilitaciones de comercios.
6. Polígonos reales y tarifas/comisiones del negocio.
7. Proveedor de facturación electrónica; datos del titular (RUC, razón social) para Libro de Reclamaciones y comprobantes.
8. Elección de proveedor de despliegue y base gestionada con PostGIS.

## Siguiente paso recomendado
1. Resolver el acceso de GitHub y publicar la rama.
2. Compilar `courier-mobile` con `expo run:android` en un dispositivo Android de gama media y verificar ubicación en segundo plano (registrar modelo, versión de Android y resultados).
3. Desplegar un entorno de ensayo (staging) con Culqi en modo prueba y repetir la prueba de carga allí.
4. Optimizar `listStores` (consulta única para horarios y tarifas) y `priceItems` (carga por lotes).
5. Añadir mapa nativo (react-native-maps o MapLibre) y SSE/WebSocket en móvil.
