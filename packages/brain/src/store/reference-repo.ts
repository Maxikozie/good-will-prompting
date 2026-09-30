import {
  WikiPageSchema,
  WikiSectionSchema,
  WikiSnapshotSchema,
  type ReferenceFact,
  type WikiPage,
  type WikiSection,
  type WikiSnapshot,
} from '../domain';
import { claimCols, referenceFactFromRow } from './claim-rows';
import type { Db } from './db';
import { clean, iso, isoReq, json, opt, parseRow, upsert, vec } from './rows';

// Reference corpus only (schema `reference`). Never touches `evidence.*` (SPEC §1).
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const pageFromRow = (r: Row): WikiPage =>
  parseRow(WikiPageSchema, clean({
    id: r.id,
    namespace: 'reference',
    createdAt: isoReq(r.created_at),
    space: r.space,
    title: r.title,
    uri: r.uri,
    ownerId: opt(r.owner_id),
    official: r.official,
    lastEditedAt: isoReq(r.last_edited_at),
    lastVerifiedAt: iso(r.last_verified_at),
    declaredScope: r.declared_scope,
    allowedPrincipals: r.allowed_principals,
    outLinks: r.out_links,
  }));

const snapFromRow = (r: Row): WikiSnapshot =>
  parseRow(WikiSnapshotSchema, { id: r.id, namespace: 'reference', createdAt: isoReq(r.created_at), pageId: r.page_id, contentHash: r.content_hash, text: r.text, fetchedAt: isoReq(r.fetched_at) });

const sectionFromRow = (r: Row): WikiSection =>
  parseRow(WikiSectionSchema, { id: r.id, namespace: 'reference', createdAt: isoReq(r.created_at), snapshotId: r.snapshot_id, headingPath: r.heading_path, start: r.start_off, end: r.end_off, text: r.text });

export async function upsertPage(db: Db, p: WikiPage): Promise<void> {
  await upsert(db, 'reference.wiki_page', {
    id: p.id, space: p.space, title: p.title, uri: p.uri, owner_id: p.ownerId, official: p.official, last_edited_at: p.lastEditedAt,
    last_verified_at: p.lastVerifiedAt, declared_scope: json(p.declaredScope), allowed_principals: p.allowedPrincipals, out_links: p.outLinks, created_at: p.createdAt,
  }, ['id']);
}

export async function getPage(db: Db, id: string): Promise<WikiPage | null> {
  const r = await db.query('SELECT * FROM reference.wiki_page WHERE id = $1', [id]);
  return r.rows[0] ? pageFromRow(r.rows[0]) : null;
}

export async function listPagesVisibleTo(db: Db, principals: readonly string[]): Promise<WikiPage[]> {
  const r = await db.query(`SELECT * FROM reference.wiki_page WHERE '*' = ANY(allowed_principals) OR allowed_principals && $1::text[] ORDER BY id`, [[...principals]]);
  return r.rows.map(pageFromRow);
}

export async function saveSnapshot(db: Db, s: WikiSnapshot): Promise<void> {
  await upsert(db, 'reference.wiki_snapshot', { id: s.id, page_id: s.pageId, content_hash: s.contentHash, text: s.text, fetched_at: s.fetchedAt, created_at: s.createdAt }, ['id'], 'nothing');
}

export async function getSnapshot(db: Db, id: string): Promise<WikiSnapshot | null> {
  const r = await db.query('SELECT * FROM reference.wiki_snapshot WHERE id = $1', [id]);
  return r.rows[0] ? snapFromRow(r.rows[0]) : null;
}

export async function latestSnapshot(db: Db, pageId: string): Promise<WikiSnapshot | null> {
  const r = await db.query('SELECT * FROM reference.wiki_snapshot WHERE page_id = $1 ORDER BY fetched_at DESC LIMIT 1', [pageId]);
  return r.rows[0] ? snapFromRow(r.rows[0]) : null;
}

export async function saveSections(db: Db, sections: readonly (WikiSection & { ordinal: number; embedding?: readonly number[] })[]): Promise<void> {
  for (const s of sections) {
    await upsert(db, 'reference.wiki_section', { id: s.id, snapshot_id: s.snapshotId, ordinal: s.ordinal, heading_path: s.headingPath, start_off: s.start, end_off: s.end, text: s.text, embedding: vec(s.embedding), created_at: s.createdAt }, ['id'], 'nothing');
  }
}

export async function listSections(db: Db, snapshotId: string): Promise<WikiSection[]> {
  const r = await db.query('SELECT * FROM reference.wiki_section WHERE snapshot_id = $1 ORDER BY ordinal', [snapshotId]);
  return r.rows.map(sectionFromRow);
}

export async function setSectionEmbedding(db: Db, sectionId: string, embedding: readonly number[]): Promise<void> {
  await db.query('UPDATE reference.wiki_section SET embedding = $2::vector WHERE id = $1', [sectionId, `[${embedding.join(',')}]`]);
}

export async function searchSections(db: Db, embedding: readonly number[], opts: { k?: number; snapshotIds?: readonly string[] } = {}): Promise<{ section: WikiSection; score: number }[]> {
  const r = await db.query(
    `SELECT *, 1 - (embedding <=> $1::vector) AS score FROM reference.wiki_section
      WHERE embedding IS NOT NULL AND ($2::text[] IS NULL OR snapshot_id = ANY($2::text[]))
      ORDER BY embedding <=> $1::vector LIMIT $3`,
    [`[${embedding.join(',')}]`, opts.snapshotIds ? [...opts.snapshotIds] : null, opts.k ?? 5],
  );
  return r.rows.map((x: Row) => ({ section: sectionFromRow(x), score: Number(x.score) }));
}

export async function saveFacts(db: Db, facts: readonly ReferenceFact[]): Promise<void> {
  for (const f of facts) await upsert(db, 'reference.reference_fact', claimCols(f), ['id']);
}

export async function getFact(db: Db, id: string): Promise<ReferenceFact | null> {
  const r = await db.query('SELECT * FROM reference.reference_fact WHERE id = $1', [id]);
  return r.rows[0] ? referenceFactFromRow(r.rows[0]) : null;
}

export async function listFactsBySubject(db: Db, subject: string, attribute?: string): Promise<ReferenceFact[]> {
  const r = await db.query('SELECT * FROM reference.reference_fact WHERE subject = $1 AND ($2::text IS NULL OR attribute = $2) ORDER BY id', [subject, attribute ?? null]);
  return r.rows.map(referenceFactFromRow);
}
