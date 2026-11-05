import { config, productionConfigProblems } from './config';
import { createApp } from './app';
import { db } from './db/db';
import { migrate } from './db/migrate';
import { startJobs } from './jobs';
import { startRealtime } from './modules/notifications/notifications.service';
import { logger } from './common/logger';

async function main() {
  const cfg = config();
  const problems = productionConfigProblems(cfg);
  if (problems.length) {
    console.error(`Configuración inválida para ${cfg.APP_ENV}:\n - ${problems.join('\n - ')}`);
    process.exit(1);
  }
  await migrate(cfg.DATABASE_URL, (m) => logger.info(m));
  if (!cfg.isDevLike) {
    const demo = await db.one(`SELECT count(*)::int AS n FROM users WHERE is_demo AND status = 'active'`);
    if (demo.n > 0) {
      console.error(`Hay ${demo.n} usuarios de demostración activos. Desactívelos antes de operar en ${cfg.APP_ENV}.`);
      process.exit(1);
    }
  }
  const app = await createApp();
  await startRealtime();
  await startJobs();
  await app.listen(cfg.PORT, '0.0.0.0');
  logger.info('api escuchando', { port: cfg.PORT, env: cfg.APP_ENV });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
