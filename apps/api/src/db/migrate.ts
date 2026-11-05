import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

export function migrationsDir(): string {
  // dist/db -> ../../migrations ; src/db -> ../../migrations
  return join(__dirname, '..', '..', 'migrations');
}

/** Aplica migraciones SQL numeradas, cada una en su transacción, registrándolas en schema_migrations. */
export async function migrate(databaseUrl: string, log = console.log): Promise<string[]> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = readdirSync(migrationsDir())
      .filter((f) => /^\d+_.+\.sql$/.test(f))
      .sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = readFileSync(join(migrationsDir(), f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        applied.push(f);
        log(`migración aplicada: ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Falló la migración ${f}: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
    await client.end();
  }
  return applied;
}

/** Solo pruebas: borra y recrea el esquema public. */
export async function resetDatabase(databaseUrl: string): Promise<void> {
  if (!/_test\b|aquisito_test/.test(databaseUrl)) throw new Error('resetDatabase solo sobre bases *_test');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await client.end();
  await migrate(databaseUrl, () => undefined);
}
