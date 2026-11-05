import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { config } from '../config';
import { closePool, tx } from './db';
import { migrate } from './migrate';
import { seedDemo } from './seed';

/**
 * Siembra datos de demostración. Las contraseñas se generan localmente (o se toman de
 * DEMO_PASSWORD) y se escriben en storage/demo-credentials.txt (excluido de git). Nunca se
 * despliegan accesos públicos conocidos; producción rechaza el sembrado y los usuarios demo.
 */
async function main() {
  const cfg = config();
  await migrate(cfg.DATABASE_URL, () => undefined);
  const r = await tx((t) => seedDemo(t, { password: process.env.DEMO_PASSWORD }));
  mkdirSync(cfg.STORAGE_LOCAL_DIR, { recursive: true });
  const file = join(cfg.STORAGE_LOCAL_DIR, 'demo-credentials.txt');
  const lines = ['# Credenciales de DEMOSTRACIÓN generadas localmente. No compartir ni desplegar.', ...r.credentials.map((c) => `${c.role.padEnd(16)} ${c.email.padEnd(48)} ${c.password}${c.mfaSecret ? `  TOTP:${c.mfaSecret}` : ''}`)];
  writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  console.log(`Datos de demostración sembrados. Credenciales en ${file}`);
  await closePool();
}
main().catch(async (e) => {
  console.error(e.message);
  await closePool();
  process.exit(1);
});
