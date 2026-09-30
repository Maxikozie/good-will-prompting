import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, pgliteDb, type Db } from '../src/store';
import { count, upsert } from '../src/store/rows';

// Regression: upsert/count interpolated table, column and pk names into SQL (Aikido: SQL injection via concatenation).
let db: Db;
beforeAll(async () => {
  db = await pgliteDb();
  await migrate(db);
});
afterAll(async () => db.close());

const person = (id: string) => ({ id, name: 'Nina Maes', email: `${id}@example.test`, team: 'payroll', country: 'BE', active: true, principal_ids: [`user:${id}`], created_at: '2026-09-30T00:00:00.000Z' });

describe('rows identifier guard', () => {
  it('still upserts and counts an allowlisted table', async () => {
    await upsert(db, 'org.person', person('person-a'), ['id']);
    await upsert(db, 'org.person', { ...person('person-a'), team: 'hr' }, ['id']);
    expect(await count(db, 'org.person')).toBe(1);
    const r = await db.query<{ team: string }>('SELECT team FROM org.person WHERE id = $1', ['person-a']);
    expect(r.rows[0]!.team).toBe('hr');
  });

  it('rejects tables outside the allowlist or with bad syntax', async () => {
    for (const t of ['pg_catalog.pg_user', 'org.person; DROP TABLE org.person --', 'person', 'Org.Person', 'org."person"']) {
      await expect(upsert(db, t, person('person-b'), ['id'])).rejects.toThrow();
      await expect(count(db, t)).rejects.toThrow();
    }
  });

  it('rejects malicious column names', async () => {
    await expect(upsert(db, 'org.person', { ...person('person-c'), 'id; DROP TABLE org.person --': 'x' }, ['id'])).rejects.toThrow(/column identifier/);
    await expect(upsert(db, 'org.person', { ...person('person-c'), 'name" = 1 --': 'x' }, ['id'])).rejects.toThrow(/column identifier/);
  });

  it('rejects malicious or unknown primary key columns', async () => {
    await expect(upsert(db, 'org.person', person('person-d'), ['id) DO NOTHING; DROP TABLE org.person --'])).rejects.toThrow(/column identifier/);
    await expect(upsert(db, 'org.person', person('person-d'), ['not_in_row'])).rejects.toThrow(/primary key column not in row/);
    await expect(upsert(db, 'org.person', person('person-d'), [])).rejects.toThrow();
  });

  it('left the table intact', async () => {
    expect(await count(db, 'org.person')).toBe(1);
  });
});
