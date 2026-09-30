import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  evidenceDocId,
  evidencePassageId,
  evidenceSnapshotId,
  personId,
  principalId,
  wikiPageId,
  wikiSectionId,
  wikiSnapshotId,
  type EvidenceDocument,
  type EvidencePassage,
  type EvidenceSnapshot,
  type Expertise,
  type Person,
  type WikiPage,
  type WikiSection,
  type WikiSnapshot,
} from '../domain';
import type { Db } from './db';
import { splitPassages } from '../evidence/passages';
import { splitSections } from '../reference/sections';
import { migrate } from './migrate';
import * as evidenceRepo from './evidence-repo';
import * as orgRepo from './org-repo';
import * as referenceRepo from './reference-repo';

// Loads test/fixtures/demo (FICTIONAL demo data, SPEC §14) into the database. Idempotent: every write is an upsert or a
// no-op for immutable rows, and every id/timestamp is derived from the fixture content, so a second run changes nothing.

export const DEMO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'demo');
export const SEED_NOW = '2026-09-30T00:00:00.000Z'; // demo "today"

function frontmatter(src: string): { data: Record<string, any>; body: string } { // eslint-disable-line @typescript-eslint/no-explicit-any
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error('fixture without frontmatter');
  return { data: (parse(m[1]!) ?? {}) as Record<string, any>, body: m[2]! }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));

export interface DemoData {
  people: Person[];
  expertise: Expertise[];
  evidence: { document: EvidenceDocument; snapshot: EvidenceSnapshot; passages: EvidencePassage[] }[];
  reference: { page: WikiPage; snapshot: WikiSnapshot; sections: (WikiSection & { ordinal: number })[] }[];
}

export function loadDemo(dir = DEMO_DIR): DemoData {
  const orgFile = parse(fs.readFileSync(path.join(dir, 'org', 'people.yaml'), 'utf8')) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const createdAt: string = orgFile.created_at ?? SEED_NOW;

  const people: Person[] = orgFile.people.map((p: any) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
    id: personId(p.id), namespace: 'org', createdAt, name: p.name, email: p.email, team: p.team, country: p.country, active: p.active, principalIds: (p.principal_ids ?? []).map(principalId),
  }));
  const expertise: Expertise[] = orgFile.expertise.map((e: any) => ({ personId: personId(e.person), subject: e.subject, country: e.country, weight: e.weight })); // eslint-disable-line @typescript-eslint/no-explicit-any

  const list = (sub: string) => fs.readdirSync(path.join(dir, sub)).filter((f) => f.endsWith('.md')).sort();

  const evidence = list('evidence').map((f) => {
    const { data, body } = frontmatter(fs.readFileSync(path.join(dir, 'evidence', f), 'utf8'));
    const hash = sha256(body);
    const docId = evidenceDocId(data.id);
    const snapId = evidenceSnapshotId(`snap-${data.id}-${hash.slice(0, 12)}`);
    const document: EvidenceDocument = {
      id: docId, namespace: 'evidence', createdAt: SEED_NOW, sourceSystem: data.source_system, sourceUri: data.uri, title: data.title,
      ...(data.owner ? { ownerId: personId(data.owner) } : {}), ...(data.author ? { authorId: personId(data.author) } : {}),
      lastEditedAt: String(data.last_edited), ...(str(data.last_verified) ? { lastVerifiedAt: str(data.last_verified)! } : {}),
      ...(data.verified_tier ? { verifiedTier: data.verified_tier } : {}), ...(str(data.valid_until) ? { validUntil: str(data.valid_until)! } : {}),
      declaredScope: data.declared_scope ?? {}, allowedPrincipals: (data.allowed_principals ?? []).map(principalId),
    };
    const snapshot: EvidenceSnapshot = { id: snapId, namespace: 'evidence', createdAt: SEED_NOW, documentId: docId, contentHash: hash, text: body, fetchedAt: SEED_NOW, version: 1 };
    const passages: EvidencePassage[] = splitPassages(body).map((s) => ({
      id: evidencePassageId(`${snapId}#${s.ordinal}`), namespace: 'evidence', createdAt: SEED_NOW, snapshotId: snapId, ordinal: s.ordinal, start: s.start, end: s.end, text: s.text,
    }));
    return { document, snapshot, passages };
  });

  const reference = list('reference').map((f) => {
    const { data, body } = frontmatter(fs.readFileSync(path.join(dir, 'reference', f), 'utf8'));
    const hash = sha256(body);
    const pageId = wikiPageId(data.id);
    const snapId = wikiSnapshotId(`wsnap-${data.id}-${hash.slice(0, 12)}`);
    const page: WikiPage = {
      id: pageId, namespace: 'reference', createdAt: SEED_NOW, space: data.space, title: data.title, uri: data.uri,
      ...(data.owner ? { ownerId: personId(data.owner) } : {}), official: !!data.official, lastEditedAt: String(data.last_edited),
      ...(str(data.last_verified) ? { lastVerifiedAt: str(data.last_verified)! } : {}), declaredScope: data.declared_scope ?? {},
      allowedPrincipals: (data.allowed_principals ?? []).map(principalId), outLinks: (data.out_links ?? []).map(wikiPageId),
    };
    const snapshot: WikiSnapshot = { id: snapId, namespace: 'reference', createdAt: SEED_NOW, pageId, contentHash: hash, text: body, fetchedAt: SEED_NOW };
    const sections = splitSections(body).map((s) => ({
      id: wikiSectionId(`${snapId}#${s.ordinal}`), namespace: 'reference' as const, createdAt: SEED_NOW, snapshotId: snapId, ordinal: s.ordinal, headingPath: s.headingPath, start: s.start, end: s.end, text: s.text,
    }));
    return { page, snapshot, sections };
  });

  return { people, expertise, evidence, reference };
}

export interface SeedResult {
  people: number;
  expertise: number;
  evidenceDocuments: number;
  evidencePassages: number;
  referencePages: number;
  referenceSections: number;
}

/** Run migrations, then load the demo fixtures. Safe to run any number of times. */
export async function seedDemo(db: Db, dir = DEMO_DIR): Promise<SeedResult> {
  await migrate(db);
  const demo = loadDemo(dir);
  await db.transaction(async (tx) => {
    for (const p of demo.people) await orgRepo.upsertPerson(tx, p);
    for (const e of demo.expertise) await orgRepo.upsertExpertise(tx, e);
    for (const e of demo.evidence) {
      await evidenceRepo.upsertDocument(tx, e.document);
      await evidenceRepo.saveSnapshot(tx, e.snapshot);
      await evidenceRepo.savePassages(tx, e.passages);
    }
    for (const r of demo.reference) {
      await referenceRepo.upsertPage(tx, r.page);
      await referenceRepo.saveSnapshot(tx, r.snapshot);
      await referenceRepo.saveSections(tx, r.sections);
    }
  });
  return {
    people: demo.people.length,
    expertise: demo.expertise.length,
    evidenceDocuments: demo.evidence.length,
    evidencePassages: demo.evidence.reduce((n, e) => n + e.passages.length, 0),
    referencePages: demo.reference.length,
    referenceSections: demo.reference.reduce((n, r) => n + r.sections.length, 0),
  };
}
