# Despliegue, respaldo, restauración y reversión

Estado: **no desplegado**. Este procedimiento está preparado para un entorno de ensayo (`APP_ENV=staging`).

## Entornos
| Entorno | Datos | Pagos | SMS | Sembrado demo |
|---|---|---|---|---|
| development | locales ficticios | sandbox (simulador) | console | permitido |
| test | `aquisito_test`, reiniciada en cada corrida | sandbox | console | automático |
| staging | ficticios, base separada | proveedor en modo prueba (p. ej. Culqi test) | proveedor real a números de prueba | **bloqueado** |
| production | reales | proveedor productivo contratado | proveedor real | **bloqueado** |

En staging/production `main.ts` aborta si: hay simuladores, `ALLOW_DEMO_SEED=true`, falta `DATA_ENCRYPTION_KEY`, `COOKIE_SECURE=false`, almacenamiento local en producción, o existen usuarios demo activos.

## Pasos de despliegue (contenedores)
1. Construir imágenes: `docker build -f infra/Dockerfile.api -t aquisito-api:<sha> .` y `docker build -f infra/Dockerfile.web -t aquisito-web:<sha> .`
2. Base gestionada PostgreSQL 16 + PostGIS, TLS, respaldos automáticos y PITR.
3. Configurar variables (ver `.env.example`) en el gestor de secretos del proveedor; nunca en el repositorio.
4. Desplegar el API: al arrancar aplica migraciones pendientes bajo *advisory lock* (una instancia a la vez). Los jobs se coordinan entre instancias con otro *advisory lock*.
5. Desplegar la web con `API_URL` apuntando al API interno.
6. Verificar `GET /health` y `GET /metrics` (admin), y un pedido de prueba con el proveedor en modo test.
7. Registrar la URL de webhook del proveedor: `https://<api>/webhooks/payments/culqi`.

## Copias de seguridad
- Automáticas del proveedor (diarias + PITR) y lógicas con `infra/scripts/backup.sh` (formato custom + SHA-256), guardadas cifradas fuera de la región.
- Retención propuesta: diarias 14 días, semanales 8 semanas, mensuales 12 meses (validar con el negocio).
- Responsables: *por designar* (titular técnico y suplente).

## Restauración
1. Crear una base **nueva** (nunca restaurar encima de producción en caliente).
2. `TARGET_URL=... bash infra/scripts/restore.sh respaldo.dump` (verifica el checksum).
3. Validar con las consultas de `restore-drill.sh` (pedidos, movimientos, sumas, invariantes de stock y totales).
4. Cambiar `DATABASE_URL` del API a la base restaurada; los pagos pendientes se resuelven con `POST /admin/payments/reconcile`.

**Ensayo realizado** el 2026-11-05 sobre la base de pruebas: ver `docs/informe-pruebas.md` (resultado OK).

## Reversión (rollback)
- Aplicación: volver a la imagen anterior (`<sha>` previo). Las migraciones son **solo hacia adelante y aditivas**; cualquier migración destructiva debe dividirse en dos despliegues (expandir → migrar datos → contraer) para que la versión anterior siga funcionando.
- Datos: si una migración corrompe datos, restaurar en base nueva desde el respaldo previo al despliegue (tomar siempre un respaldo inmediatamente antes de desplegar).
- Pagos: nunca revertir estados de pago manualmente; conciliar contra el proveedor.

## Monitoreo y alertas (mínimos)
`/metrics` expone: p50/p95/p99 HTTP, errores 4xx/5xx, outbox pendiente y fallido, pagos en conciliación, fallas de pago en 1 h, reservas vencidas sin liberar, pedidos atascados (> 2 h). Configurar alertas sobre: outbox fallido > 0, pagos en conciliación > 0 por más de 15 min, pedidos atascados > 0, p95 > 800 ms, `GET /health` fallido.
