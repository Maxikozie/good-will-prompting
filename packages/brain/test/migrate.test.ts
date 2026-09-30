import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS_DIR } from '../src/store/migrate';
import { brainRepo } from '../src/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EDGE_TYPES, NODE_KINDS } from '../src/domain';
import { migrate, pgliteDb, type Db } from '../src/store';

let db: Db;
beforeAll(async () => {
  db = await pgliteDb();
});
afterAll(async () => db.close());

describe('migrations', () => {
  it('apply once and are idempotent', async () => {
    expect(await migrate(db)).toEqual(['001_init.sql', '002_llm_cache.sql', '003_run_stage.sql', '004_reference_only.sql', '005_verification_token_use.sql']);
    expect(await migrate(db)).toEqual([]);
  });

  it('create the four schemas and the expected tables', async () => {
    const r = await db.query<{ t: string }>(`SELECT table_schema || '.' || table_name AS t FROM information_schema.tables WHERE table_schema IN ('evidence','reference','brain','org')`);
    const tables = new Set(r.rows.map((x) => x.t));
    for (const t of [
      'org.person', 'org.expertise',
      'evidence.document', 'evidence.snapshot', 'evidence.passage', 'evidence.claim',
      'reference.wiki_page', 'reference.wiki_snapshot', 'reference.wiki_section', 'reference.reference_fact',
      'brain.case_run', 'brain.fact', 'brain.gap', 'brain.conflict', 'brain.canonical', 'brain.attribution',
      'brain.verification_request', 'brain.verification_event', 'brain.org_event', 'brain.edge', 'brain.llm_cache', 'brain.run_stage', 'brain.claim_group',
    ]) expect(tables, t).toContain(t);
  });

  it('keeps the corpora apart: no foreign key crosses evidence <-> reference', async () => {
    const r = await db.query<{ from_schema: string; to_schema: string }>(`
      SELECT n1.nspname AS from_schema, n2.nspname AS to_schema
        FROM pg_constraint c
        JOIN pg_class c1 ON c1.oid = c.conrelid   JOIN pg_namespace n1 ON n1.oid = c1.relnamespace
        JOIN pg_class c2 ON c2.oid = c.confrelid  JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
       WHERE c.contype = 'f' AND n1.nspname IN ('evidence','reference')`);
    for (const x of r.rows) expect(x.from_schema, 'FK stays inside its own schema').toBe(x.to_schema);
  });

  it('has separate pgvector columns and hnsw indexes for passages and sections', async () => {
    const cols = await db.query<{ t: string }>(`SELECT table_schema || '.' || table_name AS t FROM information_schema.columns WHERE udt_name = 'vector' ORDER BY 1`);
    expect(cols.rows.map((c) => c.t)).toEqual(['evidence.passage', 'reference.wiki_section']);
    const idx = await db.query<{ indexname: string; indexdef: string }>(`SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('passage_embedding','section_embedding')`);
    expect(idx.rows).toHaveLength(2);
    for (const i of idx.rows) expect(i.indexdef).toMatch(/hnsw/);
  });

  it('edge table: enum types match the domain, indexes exist, run_id is nullable', async () => {
    const labels = async (type: string) => (await db.query<{ e: string }>(`SELECT enumlabel AS e FROM pg_enum JOIN pg_type t ON t.oid = enumtypid WHERE t.typname = $1 ORDER BY enumsortorder`, [type])).rows.map((x) => x.e);
    expect(await labels('edge_type')).toEqual([...EDGE_TYPES]);
    expect((await labels('node_kind')).sort()).toEqual([...NODE_KINDS].sort());
    const idx = await db.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'brain' AND tablename = 'edge'`);
    const defs = idx.rows.map((r) => r.indexdef).join('\n');
    expect(defs).toMatch(/\(from_id, type\)/);
    expect(defs).toMatch(/\(to_id, type\)/);
    expect(defs).toMatch(/\(run_id\)/);
    const nullable = await db.query<{ is_nullable: string }>(`SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'brain' AND table_name = 'edge' AND column_name = 'run_id'`);
    expect(nullable.rows[0]!.is_nullable).toBe('YES');
  });
});


it('upgrades consumed requests without reopening them and prevents token rebinding', async () => {
  const previous = await pgliteDb();
  try {
    // Actual original schema, before the used_at migration.
    await previous.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, '001_init.sql'), 'utf8'));
    await previous.query(`INSERT INTO brain.case_run (id, question, principal_id, intent, status, rules_version, started_at)
      VALUES ($1,$2,$3,$4::jsonb,'completed',$5,now())`, ['upgrade-run', 'test', 'user:test', '{}', '1']);
    await previous.query(`INSERT INTO brain.fact (id,run_id,claim_key,subject,attribute,scope,status,confidence,needs_verification,impact)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,'LIKELY',80,true,'low')`, ['upgrade-fact', 'upgrade-run', 'a'.repeat(40), 'leave', 'duration', '{}']);
    for (const status of ['pending', 'completed', 'cancelled']) {
      await previous.query(`INSERT INTO brain.verification_request (id,fact_id,requested_from_id,reason,status,token_jti,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,now() + interval '1 day')`, [status, 'upgrade-fact', 'person', 'test', status, 'upgrade-' + status]);
    }
    await previous.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, '005_verification_token_use.sql'), 'utf8'));
    expect(await brainRepo.burnToken(previous, 'upgrade-completed')).toBe(false);
    expect(await brainRepo.burnToken(previous, 'upgrade-cancelled')).toBe(false);
    expect(await brainRepo.burnToken(previous, 'upgrade-pending')).toBe(true);
    expect(await brainRepo.burnToken(previous, 'upgrade-pending')).toBe(false);
    const spent = await previous.query<{ used_at: unknown }>('SELECT used_at FROM brain.verification_request WHERE id = $1', ['completed']);
    expect(spent.rows[0]!.used_at).toBeTruthy();
    await expect(previous.query('UPDATE brain.verification_request SET token_jti = $1 WHERE id = $2', ['new-jti', 'completed'])).rejects.toThrow(/immutable/);
    await expect(previous.query("UPDATE brain.verification_request SET status = 'pending', used_at = NULL WHERE id = $1", ['completed'])).rejects.toThrow(/immutable/);
  } finally { await previous.close(); }
});
