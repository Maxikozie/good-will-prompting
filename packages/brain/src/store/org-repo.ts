import { ExpertiseSchema, PersonSchema, type Expertise, type Person } from '../domain';
import type { Db } from './db';
import { isoReq, parseRow, upsert } from './rows';

const personFromRow = (r: Record<string, any>): Person => // eslint-disable-line @typescript-eslint/no-explicit-any
  parseRow(PersonSchema, { id: r.id, namespace: 'org', createdAt: isoReq(r.created_at), name: r.name, email: r.email, team: r.team, country: r.country, active: r.active, principalIds: r.principal_ids });

export async function upsertPerson(db: Db, p: Person): Promise<void> {
  await upsert(db, 'org.person', { id: p.id, name: p.name, email: p.email, team: p.team, country: p.country, active: p.active, principal_ids: p.principalIds, created_at: p.createdAt }, ['id']);
}

export async function getPerson(db: Db, id: string): Promise<Person | null> {
  const r = await db.query('SELECT * FROM org.person WHERE id = $1', [id]);
  return r.rows[0] ? personFromRow(r.rows[0]) : null;
}

export async function listPersons(db: Db, opts: { activeOnly?: boolean } = {}): Promise<Person[]> {
  const r = await db.query(`SELECT * FROM org.person ${opts.activeOnly ? 'WHERE active' : ''} ORDER BY id`);
  return r.rows.map(personFromRow);
}

export async function upsertExpertise(db: Db, e: Expertise): Promise<void> {
  await upsert(db, 'org.expertise', { person_id: e.personId, subject: e.subject, country: e.country, weight: e.weight }, ['person_id', 'subject', 'country']);
}

/** Experts for a subject (optionally one country), strongest first. */
export async function listExperts(db: Db, subject: string, opts: { country?: string; minWeight?: number } = {}): Promise<Expertise[]> {
  const r = await db.query(
    `SELECT person_id, subject, country, weight FROM org.expertise
      WHERE subject = $1 AND ($2::text IS NULL OR country = $2) AND weight >= $3
      ORDER BY weight DESC, person_id`,
    [subject, opts.country ?? null, opts.minWeight ?? 0],
  );
  return r.rows.map((x: Record<string, any>) => parseRow(ExpertiseSchema, { personId: x.person_id, subject: x.subject, country: x.country, weight: x.weight })); // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** The full principal set of a caller: the principal ids of the person who owns `principalId` (e.g. "user:nina.maes"), else just itself. */
export async function principalSetFor(db: Db, principalId: string): Promise<string[]> {
  const r = await db.query<{ principal_ids: string[] }>('SELECT principal_ids FROM org.person WHERE $1 = ANY(principal_ids) ORDER BY id LIMIT 1', [principalId]);
  return r.rows[0] ? r.rows[0].principal_ids : [principalId];
}
