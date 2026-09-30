import { LIMITS } from '../security/limits';
import { embedWithLimits } from '../security/model';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  PartialScopeSchema,
  IsoStringSchema,
  WikiPageSchema,
  WikiSectionSchema,
  WikiSnapshotSchema,
  personId,
  principalId,
  wikiPageId,
  wikiSectionId,
  wikiSnapshotId,
  type WikiPage,
  type WikiSection,
  type WikiSnapshot,
} from '../domain';
import type { Embedder } from '../llm';
import type { Db } from '../store/db';
import * as repo from '../store/reference-repo';
import { splitSections } from './sections';

// Wiki ingestion (the reference corpus): page → immutable snapshot → heading-aware sections → embeddings.
// Real version: a wiki/SharePoint connector; the demo loads seed pages (test/fixtures/demo/reference) and brain_ingest_reference pages.

export const WikiPageInputSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    space: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(300),
    uri: z.string().trim().min(1).max(1000),
    owner: z.string().trim().min(1).max(200).optional(),
    official: z.boolean().default(false),
    lastEditedAt: IsoStringSchema,
    lastVerifiedAt: IsoStringSchema.optional(),
    declaredScope: PartialScopeSchema.default({}),
    allowedPrincipals: z.array(z.string().min(1).max(200)).max(50).default([]),
    outLinks: z.array(z.string().min(1).max(200)).max(100).default([]),
    text: z.string().min(1).max(LIMITS.documentChars),
  })
  .strict();
export type WikiPageInput = z.input<typeof WikiPageInputSchema>;

export interface IngestResult {
  pageId: string;
  snapshotId: string;
  newSnapshot: boolean;
  sections: number;
  embedded: number;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const iso = (v: string) => new Date(v).toISOString();

/** Store (or update) a wiki page, snapshot its text immutably, split it into sections and embed them. Idempotent. */
export async function ingestWikiPage(db: Db, embedder: Embedder, raw: WikiPageInput, now: Date = new Date()): Promise<IngestResult> {
  const input = WikiPageInputSchema.parse(raw);
  const nowIso = now.toISOString();
  const page: WikiPage = WikiPageSchema.parse({
    id: wikiPageId(input.id),
    namespace: 'reference',
    createdAt: nowIso,
    space: input.space,
    title: input.title,
    uri: input.uri,
    ...(input.owner ? { ownerId: personId(input.owner) } : {}),
    official: input.official,
    lastEditedAt: iso(input.lastEditedAt),
    ...(input.lastVerifiedAt ? { lastVerifiedAt: iso(input.lastVerifiedAt) } : {}),
    declaredScope: input.declaredScope,
    allowedPrincipals: input.allowedPrincipals.map(principalId),
    outLinks: input.outLinks.map(wikiPageId),
  });
  await repo.upsertPage(db, page);

  const hash = sha256(input.text);
  const latest = await repo.latestSnapshot(db, page.id);
  let snapshot: WikiSnapshot;
  let newSnapshot = false;
  if (latest && latest.contentHash === hash) snapshot = latest;
  else {
    snapshot = WikiSnapshotSchema.parse({ id: wikiSnapshotId(`wsnap-${page.id}-${hash.slice(0, 12)}`), namespace: 'reference', createdAt: nowIso, pageId: page.id, contentHash: hash, text: input.text, fetchedAt: nowIso });
    await repo.saveSnapshot(db, snapshot);
    newSnapshot = true;
  }

  let sections: WikiSection[] = await repo.listSections(db, snapshot.id);
  if (sections.length === 0) {
    const spans = splitSections(snapshot.text);
    const made = spans.map((s) => ({ ...WikiSectionSchema.parse({ id: wikiSectionId(`${snapshot.id}#${s.ordinal}`), namespace: 'reference', createdAt: nowIso, snapshotId: snapshot.id, headingPath: s.headingPath, start: s.start, end: s.end, text: s.text }), ordinal: s.ordinal }));
    await repo.saveSections(db, made);
    sections = made;
  }
  const embedded = await embedMissingSections(db, embedder);
  return { pageId: page.id, snapshotId: snapshot.id, newSnapshot, sections: sections.length, embedded };
}

/** Embed every wiki section that has no vector yet (seeded pages arrive without embeddings). Returns how many were embedded. */
export async function embedMissingSections(db: Db, embedder: Embedder, batch = 32): Promise<number> {
  const todo = await repo.listSectionsWithoutEmbedding(db);
  for (let i = 0; i < todo.length; i += batch) {
    const slice = todo.slice(i, i + batch);
    const vectors = await embedWithLimits(embedder, slice.map((s) => s.text));
    for (let j = 0; j < slice.length; j++) await repo.setSectionEmbedding(db, slice[j]!.id, vectors[j]!);
  }
  return todo.length;
}

/** Public batch boundary: validate the entire batch before the first write/model call. */
export const WikiBatchSchema = z.object({ pages: z.array(WikiPageInputSchema).min(1).max(LIMITS.wikiPagesPerIngest) }).strict();
export async function ingestWikiPages(db: Db, embedder: Embedder, raw: z.input<typeof WikiBatchSchema>, now = new Date()) {
  const { pages } = WikiBatchSchema.parse(raw);
  const results = [];
  for (const page of pages) results.push(await ingestWikiPage(db, embedder, page, now));
  return results;
}
