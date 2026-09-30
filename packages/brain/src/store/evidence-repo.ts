import { z } from 'zod';
import { parseJson } from '../security/input';
import {
  EvidenceDocumentSchema,
  EvidencePassageSchema,
  EvidenceSnapshotSchema,
  type EvidenceClaim,
  type EvidenceDocument,
  type EvidencePassage,
  type EvidenceSnapshot,
} from '../domain';
import { claimCols, evidenceClaimFromRow } from './claim-rows';
import type { Db } from './db';
import { clean, iso, isoReq, json, opt, parseRow, upsert, vec } from './rows';

// Evidence corpus only (schema `evidence`). Never touches `reference.*` (SPEC §1).
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const docFromRow = (r: Row): EvidenceDocument =>
  parseRow(EvidenceDocumentSchema, clean({
    id: r.id,
    namespace: 'evidence',
    createdAt: isoReq(r.created_at),
    sourceSystem: r.source_system,
    sourceUri: r.source_uri,
    title: r.title,
    ownerId: opt(r.owner_id),
    authorId: opt(r.author_id),
    lastEditedAt: isoReq(r.last_edited_at),
    lastVerifiedAt: iso(r.last_verified_at),
    verifiedTier: opt(r.verified_tier),
    validUntil: iso(r.valid_until),
    declaredScope: r.declared_scope,
    allowedPrincipals: r.allowed_principals,
  }));

const snapFromRow = (r: Row): EvidenceSnapshot =>
  parseRow(EvidenceSnapshotSchema, { id: r.id, namespace: 'evidence', createdAt: isoReq(r.created_at), documentId: r.document_id, contentHash: r.content_hash, text: r.text, fetchedAt: isoReq(r.fetched_at), version: r.version });

const passageFromRow = (r: Row): EvidencePassage =>
  parseRow(EvidencePassageSchema, { id: r.id, namespace: 'evidence', createdAt: isoReq(r.created_at), snapshotId: r.snapshot_id, ordinal: r.ordinal, start: r.start_off, end: r.end_off, text: r.text });

export async function upsertDocument(db: Db, d: EvidenceDocument): Promise<void> {
  await upsert(db, 'evidence.document', {
    id: d.id, source_system: d.sourceSystem, source_uri: d.sourceUri, title: d.title, owner_id: d.ownerId, author_id: d.authorId,
    last_edited_at: d.lastEditedAt, last_verified_at: d.lastVerifiedAt, verified_tier: d.verifiedTier, valid_until: d.validUntil,
    declared_scope: json(d.declaredScope), allowed_principals: d.allowedPrincipals, created_at: d.createdAt,
  }, ['id']);
}

export async function getDocumentByUri(db: Db, uri: string): Promise<EvidenceDocument | null> {
  const r = await db.query('SELECT * FROM evidence.document WHERE source_uri = $1 ORDER BY id LIMIT 1', [uri]);
  return r.rows[0] ? docFromRow(r.rows[0]) : null;
}

export async function getDocument(db: Db, id: string): Promise<EvidenceDocument | null> {
  const r = await db.query('SELECT * FROM evidence.document WHERE id = $1', [id]);
  return r.rows[0] ? docFromRow(r.rows[0]) : null;
}

/** ACL filter (SPEC §13): documents whose allowed_principals contain '*' or any of the caller's principals. */
export async function listDocumentsVisibleTo(db: Db, principals: readonly string[], ids?: readonly string[]): Promise<EvidenceDocument[]> {
  const r = await db.query(
    `SELECT * FROM evidence.document
      WHERE ('*' = ANY(allowed_principals) OR allowed_principals && $1::text[])
        AND ($2::text[] IS NULL OR id = ANY($2::text[]))
      ORDER BY id`,
    [[...principals], ids ? [...ids] : null],
  );
  return r.rows.map(docFromRow);
}

/** Snapshots are immutable: a second save of the same content is a no-op. */
export async function saveSnapshot(db: Db, s: EvidenceSnapshot): Promise<void> {
  await upsert(db, 'evidence.snapshot', { id: s.id, document_id: s.documentId, content_hash: s.contentHash, text: s.text, fetched_at: s.fetchedAt, version: s.version, created_at: s.createdAt }, ['id'], 'nothing');
}

export async function getSnapshot(db: Db, id: string): Promise<EvidenceSnapshot | null> {
  const r = await db.query('SELECT * FROM evidence.snapshot WHERE id = $1', [id]);
  return r.rows[0] ? snapFromRow(r.rows[0]) : null;
}

export async function latestSnapshot(db: Db, documentId: string): Promise<EvidenceSnapshot | null> {
  const r = await db.query('SELECT * FROM evidence.snapshot WHERE document_id = $1 ORDER BY version DESC LIMIT 1', [documentId]);
  return r.rows[0] ? snapFromRow(r.rows[0]) : null;
}

export async function savePassages(db: Db, passages: readonly (EvidencePassage & { embedding?: readonly number[] })[]): Promise<void> {
  for (const p of passages) {
    await upsert(db, 'evidence.passage', { id: p.id, snapshot_id: p.snapshotId, ordinal: p.ordinal, start_off: p.start, end_off: p.end, text: p.text, embedding: vec(p.embedding), created_at: p.createdAt }, ['id'], 'nothing');
  }
}

export async function listPassages(db: Db, snapshotId: string): Promise<EvidencePassage[]> {
  const r = await db.query('SELECT * FROM evidence.passage WHERE snapshot_id = $1 ORDER BY ordinal', [snapshotId]);
  return r.rows.map(passageFromRow);
}

export async function setPassageEmbedding(db: Db, passageId: string, embedding: readonly number[]): Promise<void> {
  await db.query('UPDATE evidence.passage SET embedding = $2::vector WHERE id = $1', [passageId, `[${embedding.join(",")}]`]);
}

/** Cosine nearest passages (score = 1 - distance), optionally limited to some snapshots. */
export async function searchPassages(db: Db, embedding: readonly number[], opts: { k?: number; snapshotIds?: readonly string[] } = {}): Promise<{ passage: EvidencePassage; score: number }[]> {
  const r = await db.query(
    `SELECT *, 1 - (embedding <=> $1::vector) AS score FROM evidence.passage
      WHERE embedding IS NOT NULL AND ($2::text[] IS NULL OR snapshot_id = ANY($2::text[]))
      ORDER BY embedding <=> $1::vector LIMIT $3`,
    [`[${embedding.join(',')}]`, opts.snapshotIds ? [...opts.snapshotIds] : null, opts.k ?? 5],
  );
  return r.rows.map((x: Row) => ({ passage: passageFromRow(x), score: Number(x.score) }));
}

export async function saveClaims(db: Db, claims: readonly EvidenceClaim[]): Promise<void> {
  for (const c of claims) await upsert(db, 'evidence.claim', claimCols(c), ['id']);
}

export async function getClaim(db: Db, id: string): Promise<EvidenceClaim | null> {
  const r = await db.query('SELECT * FROM evidence.claim WHERE id = $1', [id]);
  return r.rows[0] ? evidenceClaimFromRow(r.rows[0]) : null;
}

export async function listClaimsBySnapshot(db: Db, snapshotId: string): Promise<EvidenceClaim[]> {
  const r = await db.query('SELECT * FROM evidence.claim WHERE snapshot_id = $1 ORDER BY span_start, id', [snapshotId]);
  return r.rows.map(evidenceClaimFromRow);
}

export async function listClaimsByKey(db: Db, claimKey: string): Promise<EvidenceClaim[]> {
  const r = await db.query('SELECT * FROM evidence.claim WHERE claim_key = $1 ORDER BY id', [claimKey]);
  return r.rows.map(evidenceClaimFromRow);
}

/** Passages of a snapshot that still have no embedding (so embedding is computed once, idempotently). */
export async function listPassageIdsWithoutEmbedding(db: Db, snapshotId: string): Promise<string[]> {
  const r = await db.query<{ id: string }>('SELECT id FROM evidence.passage WHERE snapshot_id = $1 AND embedding IS NULL ORDER BY ordinal', [snapshotId]);
  return r.rows.map((x) => x.id);
}

/** Embeddings of a snapshot's passages, by passage id (for duplicate detection). */
export async function getPassageEmbeddings(db: Db, snapshotId: string): Promise<Map<string, number[]>> {
  const r = await db.query<{ id: string; e: string }>('SELECT id, embedding::text AS e FROM evidence.passage WHERE snapshot_id = $1 AND embedding IS NOT NULL', [snapshotId]);
  return new Map(r.rows.map((x) => [x.id, z.array(z.number().finite()).length(768).parse(parseJson(x.e))]));
}

/** Highest snapshot version of a document (0 if none). */
export async function maxSnapshotVersion(db: Db, documentId: string): Promise<number> {
  const r = await db.query<{ v: number | null }>('SELECT max(version) AS v FROM evidence.snapshot WHERE document_id = $1', [documentId]);
  return Number(r.rows[0]?.v ?? 0);
}
