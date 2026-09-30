import { LIMITS } from '../security/limits';
import { parseEnv } from '../security/env';
import { deadline } from '../security/runtime';
import { ResourceError } from '../security/errors';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import pg from 'pg';

/**
 * Minimal database surface the repositories need. Two adapters:
 *   - node-postgres against a real Postgres 16 + pgvector (docker-compose.yml), used when DATABASE_URL is set
 *   - PGlite (embedded Postgres + pgvector in WASM): used for tests and for running the demo without Docker
 * All values go through `params` ($1, $2, …). Only static identifiers are ever interpolated into SQL.
 */
export interface Db {
  query<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: R[] }>;
  /** Multi-statement SQL without parameters (migrations). */
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Wraps a JS value so the repositories send it as jsonb (node-postgres would turn arrays into Postgres arrays). */
export class Json {
  constructor(readonly value: unknown) {}
}
/** A pgvector value, sent as text and cast with ::vector. */
export class Vec {
  constructor(readonly values: readonly number[]) {}
}

export function encode(v: unknown): unknown {
  if (v instanceof Json) return JSON.stringify(v.value ?? null);
  if (v instanceof Vec) return `[${v.values.join(',')}]`;
  return v === undefined ? null : v;
}

// ---------- node-postgres
function wrapPg(client: pg.Pool | pg.PoolClient, close: () => Promise<void>, inTx = false, active: () => boolean = () => true): Db {
  return {
    query: async (sql, params = []) => {
      if (!active()) throw new ResourceError(504, 'Transaction expired');
      const r = await deadline(() => client.query(sql, params.map(encode)), LIMITS.dbTimeoutMs);
      return { rows: r.rows };
    },
    exec: async (sql) => {
      if (!active()) throw new ResourceError(504, 'Transaction expired');
      await deadline(() => client.query(sql), LIMITS.dbTimeoutMs);
    },
    transaction: async (fn) => {
      if (inTx) return fn(wrapPg(client, async () => {}, true, active)); // already inside a transaction: join it
      const c = await (client as pg.Pool).connect();
      let open = true;
      try {
        await c.query('BEGIN');
        const out = await deadline(() => fn(wrapPg(c, async () => {}, true, () => open)), LIMITS.transactionTimeoutMs, () => { open = false; });
        await c.query('COMMIT');
        return out;
      } catch (e) {
        open = false;
        await c.query('ROLLBACK');
        throw e;
      } finally {
        open = false;
        c.release();
      }
    },
    close,
  };
}

export function pgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: LIMITS.dbTimeoutMs, query_timeout: LIMITS.dbTimeoutMs, statement_timeout: LIMITS.dbTimeoutMs, idle_in_transaction_session_timeout: LIMITS.transactionTimeoutMs });
  return wrapPg(pool, () => pool.end());
}

// ---------- PGlite
function wrapPglite(client: PGlite | { query: PGlite['query']; exec: PGlite['exec'] }, close: () => Promise<void>, tx?: boolean, active: () => boolean = () => true): Db {
  return {
    query: async (sql, params = []) => {
      if (!active()) throw new ResourceError(504, 'Transaction expired');
      const r = await deadline(() => client.query(sql, params.map(encode)), LIMITS.dbTimeoutMs);
      return { rows: r.rows as never[] };
    },
    exec: async (sql) => {
      if (!active()) throw new ResourceError(504, 'Transaction expired');
      await deadline(() => client.exec(sql), LIMITS.dbTimeoutMs);
    },
    transaction: async (fn) => {
      if (tx) return fn(wrapPglite(client, async () => {}, true, active)); // already inside a transaction: join it
      let open = true;
      return deadline(() => (client as PGlite).transaction(async (t) => {
        if (!open) throw new ResourceError(504, 'Transaction expired');
        try {
          const result = await fn(wrapPglite(t as never, async () => {}, true, () => open));
          if (!open) throw new ResourceError(504, 'Transaction expired');
          return result;
        } finally { open = false; }
      }), LIMITS.transactionTimeoutMs, () => { open = false; });
    },
    close,
  };
}

/** Embedded Postgres + pgvector. `dataDir` undefined = in-memory (tests). */
export async function pgliteDb(dataDir?: string): Promise<Db> {
  if (dataDir) fs.mkdirSync(path.dirname(path.resolve(dataDir)), { recursive: true });
  const db = await deadline(() => PGlite.create(dataDir ? path.resolve(dataDir) : undefined, { extensions: { vector } }), LIMITS.transactionTimeoutMs);
  await deadline(() => db.query("SELECT set_config('statement_timeout', $1, false)", [String(LIMITS.dbTimeoutMs)]), LIMITS.dbTimeoutMs);
  return wrapPglite(db, () => db.close());
}

/**
 * DATABASE_URL set → real Postgres. Otherwise embedded PGlite persisted in BRAIN_PGLITE_DIR
 * (default ./vault-brain/pglite, gitignored), so the demo runs without Docker.
 */
export async function connect(env: NodeJS.ProcessEnv = process.env): Promise<Db> {
  const config = parseEnv(env);
  if (config.DATABASE_URL) return pgDb(config.DATABASE_URL);
  return pgliteDb(config.BRAIN_PGLITE_DIR || path.join(process.cwd(), 'vault-brain', 'pglite'));
}
