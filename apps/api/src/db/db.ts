import { Pool, PoolClient, QueryResultRow } from 'pg';
import { config } from '../config';

export type Queryable = Pick<PoolClient, 'query'>;

export interface Tx {
  q<T extends QueryResultRow = any>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T extends QueryResultRow = any>(sql: string, params?: unknown[]): Promise<T>;
  maybe<T extends QueryResultRow = any>(sql: string, params?: unknown[]): Promise<T | null>;
  client: Queryable;
}

function wrap(client: Queryable): Tx {
  return {
    client,
    async q(sql, params = []) {
      const r = await client.query(sql, params as any[]);
      return r.rows;
    },
    async one(sql, params = []) {
      const r = await client.query(sql, params as any[]);
      if (r.rows.length !== 1) throw new Error(`Se esperaba 1 fila, hubo ${r.rows.length}`);
      return r.rows[0];
    },
    async maybe(sql, params = []) {
      const r = await client.query(sql, params as any[]);
      return r.rows[0] ?? null;
    },
  };
}

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: config().DATABASE_URL, max: 20 });
    // BIGINT como number: los importes en céntimos caben holgadamente en 2^53.
    require('pg').types.setTypeParser(20, (v: string) => Number(v));
    require('pg').types.setTypeParser(1700, (v: string) => Number(v));
    // DATE como 'YYYY-MM-DD' (sin conversión a zona horaria del proceso)
    require('pg').types.setTypeParser(1082, (v: string) => v);
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) await pool.end();
  pool = null;
}

/** Consultas fuera de transacción (lecturas). SQL siempre parametrizado. */
export const db: Tx = {
  client: { query: (...args: any[]) => (getPool().query as any)(...args) } as Queryable,
  q: (sql, params) => wrap(getPool()).q(sql, params),
  one: (sql, params) => wrap(getPool()).one(sql, params),
  maybe: (sql, params) => wrap(getPool()).maybe(sql, params),
};

/**
 * Transacción READ COMMITTED con reintento ante deadlock/serialización. La integridad de stock,
 * cupones y asignaciones se garantiza con UPDATE condicionales y restricciones únicas, no con caché.
 */
export async function tx<T>(fn: (t: Tx) => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const result = await fn(wrap(client));
      await client.query('COMMIT');
      return result;
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (i < attempts && (err?.code === '40P01' || err?.code === '40001')) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}
