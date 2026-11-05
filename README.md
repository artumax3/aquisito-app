# Aquisito (nombre provisional)

Plataforma de delivery multicomercio para **Aguaytía** y **Tingo María** (Perú): web de clientes,
panel de comercio, administración/despacho, app móvil de cliente y app móvil de repartidor, todas
conectadas a un mismo backend con PostgreSQL + PostGIS.

> Estado: **ejecutable local y validado en pruebas** (ver `docs/informe-pruebas.md`). No está
> desplegado en ensayo ni habilitado para operación real. Pagos, SMS, push, mapas productivos,
> verificación de identidad y facturación electrónica requieren credenciales/contratos externos
> (ver `docs/integraciones.md`). Todos los datos de demostración son ficticios.

## Estructura

```
apps/api              NestJS (monolito modular) + SQL parametrizado + migraciones + jobs
apps/web              Next.js: cliente, /comercio, /admin, /repartidor (vista web de apoyo)
apps/customer-mobile  Expo / React Native: app del cliente
apps/courier-mobile   Expo / React Native: app del repartidor (ubicación en 1.º y 2.º plano)
packages/contracts    Esquemas zod, registro de endpoints, máquinas de estado, reglas puras
packages/api-client   Cliente HTTP tipado usado por web y móviles
packages/config       Tokens de diseño compartidos
infra                 Dockerfiles, respaldo/restauración, ensayo de restauración, prueba de carga
docs                  Decisiones, avance, trazabilidad, estados, OpenAPI, manuales, borradores legales
```

## Requisitos

- Node 22, pnpm 10.28 (`corepack enable`)
- PostgreSQL 16 con PostGIS 3.4 (o `docker compose up db`)

## Instalación y arranque (desarrollo)

```bash
pnpm install
```

```bash
cp .env.example .env
```

```bash
pnpm build:packages && pnpm --filter @aquisito/api build
```

Crear las bases (si no usa Docker):

```bash
psql -U postgres -c "CREATE DATABASE aquisito" -c "CREATE DATABASE aquisito_test" -c "CREATE DATABASE aquisito_e2e"
```

Migrar y sembrar datos de demostración (las credenciales se generan localmente y se escriben en
`apps/api/storage/demo-credentials.txt`, excluido de git; también puede fijar `DEMO_PASSWORD`):

```bash
pnpm db:migrate && pnpm db:seed
```

Levantar API (puerto 4000; también ejecuta los jobs) y web (puerto 3000):

```bash
pnpm dev:api
```

```bash
pnpm dev:web
```

Abrir http://localhost:3000. Cuentas demo: `cliente.aguaytia@demo.aquisito.local`,
`comercio1@demo.aquisito.local`, `repartidor.aguaytia1@demo.aquisito.local`,
`admin@demo.aquisito.local` (requiere TOTP: el secreto está en el archivo de credenciales).

Reiniciar la base de desarrollo:

```bash
pnpm --filter @aquisito/api db:reset && pnpm db:migrate && pnpm db:seed
```

Con Docker (PostGIS + MinIO + API + web):

```bash
docker compose up --build
```

## Pruebas

```bash
pnpm test
```

Ejecuta las pruebas unitarias de `contracts` y las de integración/aceptación del API contra
PostgreSQL real (`aquisito_test`, se reinicia en cada corrida).

```bash
pnpm --filter @aquisito/web build && pnpm test:e2e
```

Playwright levanta API (4100) y web (3100) sobre `aquisito_e2e` y recorre el circuito completo.

Ensayo de restauración (criterio 29) y prueba de carga:

```bash
bash infra/scripts/restore-drill.sh
```

```bash
RATE_LIMIT_PER_MINUTE=1000000 pnpm dev:api
```

```bash
PASS=<contraseña demo> node infra/scripts/load-test.mjs
```

## Apps móviles

```bash
cd apps/customer-mobile && npx expo start
```

`EXPO_PUBLIC_API_URL` apunta al API (por defecto `http://10.0.2.2:4000`, el host desde el
emulador Android). Verificación de compilación del bundle:

```bash
cd apps/courier-mobile && npx expo export --platform android --output-dir dist-export
```

Compilación nativa (requiere Android SDK o EAS; **no realizada en esta sesión**):

```bash
cd apps/courier-mobile && npx expo run:android
```

La ubicación en segundo plano del repartidor usa `expo-task-manager` + servicio en primer plano de
Android y **solo puede verificarse en una compilación nativa sobre dispositivo real**.

## Documentación generada

```bash
pnpm --filter @aquisito/api openapi && pnpm --filter @aquisito/api docs
```

Produce `docs/openapi.json` (desde el registro único de endpoints) y `docs/estados.md` (desde las
máquinas de estado que aplica el servidor).

## Solución de problemas

- **`extension "postgis" is not available`**: instale `postgresql-16-postgis-3` o use la imagen `postgis/postgis:16-3.4`.
- **El API no arranca en ensayo/producción**: es intencional si hay simuladores, sembrado demo o claves faltantes; el mensaje lista cada problema (`productionConfigProblems`).
- **`MFA_REQUIRED`**: las cuentas admin/finanzas deben verificar TOTP en *Cuenta*.
- **429 en pruebas de carga desde una sola IP**: ajuste `RATE_LIMIT_PER_MINUTE`.
- **Web sin datos**: el proxy `/api/*` usa `API_URL` en tiempo de ejecución (por defecto `http://localhost:4000`).
- **Metro no resuelve `@aquisito/*`**: ejecute `pnpm build:packages`; `metro.config.js` observa la raíz del monorepo.

Más detalle: `docs/despliegue.md`, `docs/avance.md`, `docs/trazabilidad.md`.
