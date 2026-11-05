import { defineConfig } from '@playwright/test';

const E2E_DB = process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/aquisito_e2e';
const apiEnv = `APP_ENV=development DATABASE_URL=${E2E_DB} PORT=4100 JOBS_INTERVAL_MS=1000 CORS_ORIGINS=http://localhost:3100 PUBLIC_WEB_URL=http://localhost:3100 STORAGE_LOCAL_DIR=./storage-e2e LOG_LEVEL=warn`;

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:3100', locale: 'es-PE', timezoneId: 'America/Lima', trace: 'retain-on-failure' },
  webServer: [
    {
      // Base de datos E2E reiniciada y sembrada en cada corrida (datos ficticios, contraseña local).
      command: `cd ../api && ${apiEnv} node dist/db/reset-cli.js && ${apiEnv} DEMO_PASSWORD=E2E-Demo-Pass-1 node dist/db/seed-cli.js && ${apiEnv} node dist/main.js`,
      url: 'http://localhost:4100/health',
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: 'API_URL=http://localhost:4100 npx next start -p 3100',
      url: 'http://localhost:3100',
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
