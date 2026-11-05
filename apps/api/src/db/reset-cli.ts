import { Client } from 'pg';
import { config } from '../config';

/** SOLO DESARROLLO: borra el esquema. Rechazado fuera de development/test. */
async function main() {
  const cfg = config();
  if (!cfg.isDevLike) throw new Error('db:reset solo en desarrollo');
  const c = new Client({ connectionString: cfg.DATABASE_URL });
  await c.connect();
  await c.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await c.end();
  console.log('Esquema reiniciado');
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
