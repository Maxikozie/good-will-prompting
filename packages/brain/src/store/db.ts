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
function wrapPg(client: pg.Pool | pg.PoolClient, close: () => Promise<void>, inTx = false): Db {
  return {
    query: async (sql, params = []) => {
      const r = await client.query(sql, params.map(encode));
      return { rows: r.rows };
    },
    exec: async (sql) => {
      await client.query(sql);
    },
    transaction: async (fn) => {
      if (inTx) return fn(wrapPg(client, async () => {}, true)); // already inside a transaction: join it
      const c = await (client as pg.Pool).connect();
      try {
        await c.query('BEGIN');
        const out = await fn(wrapPg(c, async () => {}, true));
        await c.query('COMMIT');
        return out;
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    },
    close,
  };
}

export function pgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 5 });
  return wrapPg(pool, () => pool.end());
}

// ---------- PGlite
function wrapPglite(client: PGlite | { query: PGlite['query']; exec: PGlite['exec'] }, close: () => Promise<void>, tx?: boolean): Db {
  return {
    query: async (sql, params = []) => {
      const r = await client.query(sql, params.map(encode));
      return { rows: r.rows as never[] };
    },
    exec: async (sql) => {
      await client.exec(sql);
    },
    transaction: async (fn) => {
      if (tx) return fn(wrapPglite(client, async () => {}, true)); // already inside a transaction: join it
      return (client as PGlite).transaction((t) => fn(wrapPglite(t as never, async () => {}, true)));
    },
    close,
  };
}

/** Embedded Postgres + pgvector. `dataDir` undefined = in-memory (tests). */
export async function pgliteDb(dataDir?: string): Promise<Db> {
  if (dataDir) fs.mkdirSync(path.dirname(path.resolve(dataDir)), { recursive: true });
  const db = await PGlite.create(dataDir ? path.resolve(dataDir) : undefined, { extensions: { vector } });
  return wrapPglite(db, () => db.close());
}

/**
 * DATABASE_URL set → real Postgres. Otherwise embedded PGlite persisted in BRAIN_PGLITE_DIR
 * (default ./vault-brain/pglite, gitignored), so the demo runs without Docker.
 */
export async function connect(env: NodeJS.ProcessEnv = process.env): Promise<Db> {
  if (env.DATABASE_URL) return pgDb(env.DATABASE_URL);
  return pgliteDb(env.BRAIN_PGLITE_DIR || path.join(process.cwd(), 'vault-brain', 'pglite'));
}
