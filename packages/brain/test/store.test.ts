import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimKey,
  evidenceClaimId,
  evidencePassageId,
  evidenceSnapshotId,
  factId,
  personId,
  referenceFactId,
  runId,
  type Edge,
  type EvidenceClaim,
  type Fact,
  type ReferenceFact,
} from '../src/domain';
import { brainRepo, count, edgeRepo, evidenceRepo, migrate, orgRepo, pgliteDb, referenceRepo, type Db } from '../src/store';
import { loadDemo, seedDemo } from '../src/store/seed';

const NOW = '2026-09-30T00:00:00.000Z';
const unit = (i: number) => Array.from({ length: 768 }, (_, k) => (k === i ? 1 : 0));

let db: Db;
const demo = loadDemo();
beforeAll(async () => {
  db = await pgliteDb();
  await seedDemo(db);
});
afterAll(async () => db.close());

const doc = (id: string) => demo.evidence.find((e) => e.document.id === id)!;
const page = (id: string) => demo.reference.find((r) => r.page.id === id)!;

describe('demo seed', () => {
  it('is idempotent: a second run changes nothing', async () => {
    const tables = ['org.person', 'org.expertise', 'evidence.document', 'evidence.snapshot', 'evidence.passage', 'reference.wiki_page', 'reference.wiki_snapshot', 'reference.wiki_section'];
    const before = await Promise.all(tables.map((t) => count(db, t)));
    const fingerprint = async () => (await db.query<{ h: string }>(`SELECT md5(string_agg(id || content_hash, ',' ORDER BY id)) AS h FROM evidence.snapshot`)).rows[0]!.h;
    const fp = await fingerprint();
    const again = await seedDemo(db);
    expect(await Promise.all(tables.map((t) => count(db, t)))).toEqual(before);
    expect(await fingerprint()).toBe(fp);
    expect(again).toMatchObject({ evidenceDocuments: 4, referencePages: 4, people: 7, expertise: 4 });
  });

  it('round-trips every seeded record exactly (zod-parsed on the way out)', async () => {
    for (const e of demo.evidence) {
      expect(await evidenceRepo.getDocument(db, e.document.id)).toEqual(e.document);
      expect(await evidenceRepo.latestSnapshot(db, e.document.id)).toEqual(e.snapshot);
      expect(await evidenceRepo.listPassages(db, e.snapshot.id)).toEqual(e.passages);
    }
    for (const r of demo.reference) {
      expect(await referenceRepo.getPage(db, r.page.id)).toEqual(r.page);
      expect(await referenceRepo.latestSnapshot(db, r.page.id)).toEqual(r.snapshot);
      // `ordinal` is a storage column (section order); the domain WikiSection has no such field (SPEC §2.1)
      expect(await referenceRepo.listSections(db, r.snapshot.id)).toEqual(r.sections.map((s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'ordinal'))));
    }
    expect(await orgRepo.listPersons(db)).toEqual([...demo.people].sort((a, b) => a.id.localeCompare(b.id)));
  });

  it('passage offsets point at the snapshot text', () => {
    for (const e of demo.evidence) for (const p of e.passages) expect(e.snapshot.text.slice(p.start, p.end)).toBe(p.text);
    for (const r of demo.reference) for (const s of r.sections) expect(r.snapshot.text.slice(s.start, s.end)).toBe(s.text);
  });

  it('A is ~1 page with the timing window; B, C are shorter', () => {
    expect(doc('ev-A').passages).toHaveLength(8);
    expect(doc('ev-A').snapshot.text).toMatch(/Wanneer op te nemen/);
    expect(doc('ev-A').snapshot.text.split(/\s+/).length).toBeGreaterThan(250);
    for (const id of ['ev-B', 'ev-C']) expect(doc(id).snapshot.text.length).toBeLessThan(doc('ev-A').snapshot.text.length / 2);
  });

  it('D is an older version of A: ~70% identical passages and no timing window', () => {
    const aTexts = new Set(doc('ev-A').passages.map((p) => p.text));
    const dPassages = doc('ev-D').passages;
    const shared = dPassages.filter((p) => aTexts.has(p.text)).length / dPassages.length;
    expect(shared).toBeGreaterThanOrEqual(0.65);
    expect(shared).toBeLessThanOrEqual(0.8);
    expect(doc('ev-D').snapshot.text).not.toMatch(/Wanneer op te nemen|4 weken/);
    expect(doc('ev-D').document.lastEditedAt < doc('ev-A').document.lastEditedAt).toBe(true);
    expect(doc('ev-D').snapshot.contentHash).not.toBe(doc('ev-A').snapshot.contentHash);
  });

  it('W2 is a near-copy of A and links to its URL; W1/W3/W4 are not copies', () => {
    const aTexts = new Set(doc('ev-A').passages.map((p) => p.text));
    const copied = (id: string) => page(id).sections.filter((s) => aTexts.has(s.text)).length / page(id).sections.length;
    expect(copied('wiki-W2')).toBeGreaterThanOrEqual(0.8);
    expect(page('wiki-W2').snapshot.text).toContain(doc('ev-A').document.sourceUri);
    for (const id of ['wiki-W1', 'wiki-W3', 'wiki-W4']) expect(copied(id)).toBe(0);
  });

  it('carries the scenario metadata (owners, verification, scope, injection)', () => {
    expect(doc('ev-A').document).toMatchObject({ ownerId: 'sarah.peeters', verifiedTier: 'T3', declaredScope: { country: 'BE', jointCommittee: 'PC 200', employeeCategory: 'bediende' } });
    expect(doc('ev-B').document).toMatchObject({ authorId: 'tom.willems' });
    expect(doc('ev-B').document.lastVerifiedAt).toBeUndefined();
    expect(doc('ev-B').document.lastEditedAt > doc('ev-A').document.lastEditedAt).toBe(true);
    expect(doc('ev-B').snapshot.text).toMatch(/negeer alle eerdere instructies/i); // prompt-injection test payload
    expect(doc('ev-C').document.declaredScope).toMatchObject({ country: 'NL' });
    expect(doc('ev-D').document.ownerId).toBe('pieter.wouters');
    expect(page('wiki-W4').page.ownerId).toBeUndefined();
    expect(page('wiki-W4').page.lastEditedAt.startsWith('2019')).toBe(true);
    expect(page('wiki-W1').page).toMatchObject({ official: true, outLinks: ['wiki-W3'] });
  });

  it('org: Sarah active owner, inactive ex-owner, 2 BE experts, 1 NL expert', async () => {
    const people = new Map((await orgRepo.listPersons(db)).map((p) => [p.id, p]));
    expect(people.get(personId('sarah.peeters'))).toMatchObject({ active: true, team: 'Payroll BE' });
    expect(people.get(personId('pieter.wouters'))!.active).toBe(false);
    const subject = 'leave.small_leave.own_marriage';
    expect((await orgRepo.listExperts(db, subject, { country: 'BE', minWeight: 0.6 })).map((e) => e.personId)).toEqual(['sarah.peeters', 'eva.jacobs']);
    expect((await orgRepo.listExperts(db, subject, { country: 'NL', minWeight: 0.6 })).map((e) => e.personId)).toEqual(['daan.visser']);
    expect((await orgRepo.listExperts(db, subject, { country: 'BE' })).map((e) => e.personId)).toContain('tom.willems');
  });

  it('ACL: Nina reads A–D, the NL expert reads none of the BE-only documents', async () => {
    const nina = demo.people.find((p) => p.id === 'nina.maes')!.principalIds;
    const daan = demo.people.find((p) => p.id === 'daan.visser')!.principalIds;
    expect((await evidenceRepo.listDocumentsVisibleTo(db, nina)).map((d) => d.id)).toEqual(['ev-A', 'ev-B', 'ev-C', 'ev-D']);
    expect((await evidenceRepo.listDocumentsVisibleTo(db, daan)).map((d) => d.id)).toEqual(['ev-C']);
    expect(await evidenceRepo.listDocumentsVisibleTo(db, [])).toEqual([]);
    expect((await evidenceRepo.listDocumentsVisibleTo(db, nina, ['ev-A', 'ev-C'])).map((d) => d.id)).toEqual(['ev-A', 'ev-C']);
    expect((await referenceRepo.listPagesVisibleTo(db, daan)).map((p) => p.id)).toEqual(['wiki-W1', 'wiki-W2', 'wiki-W3', 'wiki-W4']);
  });
});

describe('snapshots are immutable', () => {
  it('ignores a second save of the same id or the same content', async () => {
    const s = doc('ev-A').snapshot;
    await evidenceRepo.saveSnapshot(db, { ...s, text: 'tampered', contentHash: 'f'.repeat(64) });
    await evidenceRepo.saveSnapshot(db, { ...s, id: evidenceSnapshotId('snap-dup') });
    expect(await evidenceRepo.getSnapshot(db, s.id)).toEqual(s);
    expect(await evidenceRepo.getSnapshot(db, evidenceSnapshotId('snap-dup'))).toBeNull();
  });
});

describe('vectors: separate columns and searches per corpus', () => {
  it('finds the nearest passage / section by cosine and stays inside its own corpus', async () => {
    const [p0, p1] = doc('ev-A').passages;
    const [s0, s1] = page('wiki-W1').sections;
    await evidenceRepo.setPassageEmbedding(db, p0!.id, unit(0));
    await evidenceRepo.setPassageEmbedding(db, p1!.id, unit(1));
    await referenceRepo.setSectionEmbedding(db, s0!.id, unit(0));
    await referenceRepo.setSectionEmbedding(db, s1!.id, unit(2));

    const ev = await evidenceRepo.searchPassages(db, unit(1), { k: 2 });
    expect(ev[0]!.passage.id).toBe(p1!.id);
    expect(ev[0]!.score).toBeCloseTo(1, 5);
    expect(ev[1]!.score).toBeCloseTo(0, 5);
    expect(ev.every((x) => x.passage.id.startsWith('snap-ev-'))).toBe(true);

    const ref = await referenceRepo.searchSections(db, unit(2), { k: 1 });
    expect(ref[0]!.section.id).toBe(s1!.id);

    const limited = await evidenceRepo.searchPassages(db, unit(0), { snapshotIds: [doc('ev-D').snapshot.id] });
    expect(limited).toEqual([]);
  });

  it('rejects an embedding of the wrong dimension', async () => {
    await expect(evidenceRepo.setPassageEmbedding(db, doc('ev-A').passages[0]!.id, [1, 2, 3])).rejects.toThrow();
  });
});

function evClaim(id: string, over: Partial<EvidenceClaim> = {}): EvidenceClaim {
  const p = doc('ev-A').passages[1]!;
  return {
    id: evidenceClaimId(id), namespace: 'evidence', origin: 'evidence', sourceId: doc('ev-A').document.id, snapshotId: p.snapshotId, passageId: p.id,
    span: { start: p.start, end: p.start + 40 }, quote: 'heeft recht op 2 werkdagen klein verlet', subject: 'leave.small_leave.own_marriage', attribute: 'duration',
    value: { type: 'number', raw: '2 werkdagen', normalized: 2, unit: 'days' }, qualifiers: { country: 'BE', conditions: [] }, temporal: {}, polarity: 'affirms', modality: 'rule',
    extractionConfidence: 0.95, claimKey: claimKey({ subject: 'leave.small_leave.own_marriage', attribute: 'duration', qualifiers: { country: 'BE' } }), createdAt: NOW, ...over,
  } as EvidenceClaim;
}
function refFact(id: string): ReferenceFact {
  const s = page('wiki-W1').sections[1]!;
  return {
    id: referenceFactId(id), namespace: 'reference', origin: 'reference', sourceId: page('wiki-W1').page.id, snapshotId: s.snapshotId, passageId: s.id,
    span: { start: s.start, end: s.start + 20 }, quote: 'Eigen huwelijk | 2 dagen', subject: 'leave.small_leave.own_marriage', attribute: 'duration',
    value: { type: 'number', raw: '2 dagen', normalized: 2, unit: 'days' }, qualifiers: { country: 'BE', conditions: [] }, temporal: {}, polarity: 'affirms', modality: 'rule',
    extractionConfidence: 0.9, claimKey: claimKey({ subject: 'leave.small_leave.own_marriage', attribute: 'duration', qualifiers: { country: 'BE' } }), createdAt: NOW,
  };
}

describe('claims', () => {
  it('evidence claims and reference facts live in separate tables and round-trip', async () => {
    const c = evClaim('ec-1');
    const f = refFact('rf-1');
    await evidenceRepo.saveClaims(db, [c]);
    await referenceRepo.saveFacts(db, [f]);
    expect(await evidenceRepo.getClaim(db, c.id)).toEqual(c);
    expect(await referenceRepo.getFact(db, f.id)).toEqual(f);
    expect(await evidenceRepo.getClaim(db, f.id as never)).toBeNull(); // a reference id never resolves in the evidence table
    expect((await evidenceRepo.listClaimsByKey(db, c.claimKey)).map((x) => x.id)).toEqual([c.id]);
    expect((await referenceRepo.listFactsBySubject(db, f.subject, 'duration')).map((x) => x.id)).toEqual([f.id]);
    expect((await evidenceRepo.listClaimsBySnapshot(db, c.snapshotId)).map((x) => x.id)).toEqual([c.id]);
  });

  it('upserting again updates in place', async () => {
    await evidenceRepo.saveClaims(db, [evClaim('ec-1', { extractionConfidence: 0.5 })]);
    expect((await evidenceRepo.getClaim(db, evidenceClaimId('ec-1')))!.extractionConfidence).toBe(0.5);
  });

  it('enforces integrity: a claim must point at a real passage, quote ≤ 300 chars', async () => {
    await expect(evidenceRepo.saveClaims(db, [evClaim('ec-bad', { passageId: evidencePassageId('nope') })])).rejects.toThrow();
    await expect(evidenceRepo.saveClaims(db, [evClaim('ec-long', { quote: 'x'.repeat(301) })])).rejects.toThrow();
  });
});

describe('rows are zod-parsed on the way out', () => {
  it('throws on a row that violates the domain schema', async () => {
    await db.query(`UPDATE evidence.document SET declared_scope = '{"product":"payroll"}'::jsonb WHERE id = 'ev-D'`);
    await expect(evidenceRepo.getDocument(db, 'ev-D')).rejects.toThrow();
    await db.query(`UPDATE evidence.document SET declared_scope = $1::jsonb WHERE id = 'ev-D'`, [JSON.stringify(doc('ev-D').document.declaredScope)]);
    expect(await evidenceRepo.getDocument(db, 'ev-D')).toEqual(doc('ev-D').document);
  });
});

const RUN = runId('run-1');
const FACT = factId('fact-1');
const fact: Fact = {
  id: FACT, namespace: 'brain', createdAt: NOW, runId: RUN, claimKey: claimKey({ subject: 'leave.small_leave.own_marriage', attribute: 'duration', qualifiers: { country: 'BE' } }),
  subject: 'leave.small_leave.own_marriage', attribute: 'duration', scope: { country: 'BE', jointCommittee: 'PC 200' }, slotId: 'duration', status: 'LIKELY', confidence: 84.5,
  winnerClaimId: evidenceClaimId('ec-1'), winningValue: { type: 'number', raw: '2 werkdagen', normalized: 2, unit: 'days' },
  reasons: [{ code: 'NEWER_BUT_UNVERIFIED', message: 'B is newer but nobody verified it' }], needsVerification: true, impact: 'high', referenceOnly: false,
};

describe('brain aggregates', () => {
  it('run → facts → gaps → conflicts → canonical → attribution round-trip', async () => {
    const run = {
      id: RUN, namespace: 'brain' as const, createdAt: NOW, question: 'Hoeveel dagen klein verlet?', principalId: 'user:nina.maes' as never,
      intent: { subject: 'leave.small_leave.own_marriage', scope: { country: 'BE' }, questionType: 'rule' as const, slotTemplateId: 'leave.small_leave.own_marriage', generatedSlots: false },
      status: 'running' as const, rulesVersion: '1', promptVersions: { extract: 'v1' }, modelIds: { llm: 'fake' }, evidenceSnapshotIds: [doc('ev-A').snapshot.id, doc('ev-B').snapshot.id],
      referenceSnapshotIds: [page('wiki-W1').snapshot.id], startedAt: NOW,
    };
    await brainRepo.saveRun(db, run);
    expect(await brainRepo.getRun(db, RUN)).toEqual(run);
    await brainRepo.saveRun(db, { ...run, status: 'completed', finishedAt: '2026-09-30T00:00:05.000Z' });
    expect((await brainRepo.getRun(db, RUN))!.finishedAt).toBe('2026-09-30T00:00:05.000Z');

    await brainRepo.saveFact(db, fact);
    expect(await brainRepo.getFact(db, FACT)).toEqual(fact);
    expect(await brainRepo.listFacts(db, RUN)).toEqual([fact]);
    const unknown: Fact = { ...fact, id: factId('fact-2'), status: 'UNKNOWN', confidence: 0, slotId: 'legal_basis', attribute: 'legal_basis', winnerClaimId: undefined, winningValue: undefined, reasons: [], needsVerification: false };
    delete (unknown as Partial<Fact>).winnerClaimId;
    delete (unknown as Partial<Fact>).winningValue;
    await brainRepo.saveFact(db, unknown);
    expect((await brainRepo.getFact(db, factId('fact-2')))!.winnerClaimId).toBeUndefined();

    const gap = { id: 'gap-1' as never, namespace: 'brain' as const, createdAt: NOW, runId: RUN, type: 'MISSING_SLOT' as const, slotId: 'legal_basis', factId: factId('fact-2'), description: 'no legal basis', closedBy: [referenceFactId('rf-1')], status: 'closed' as const };
    await brainRepo.saveGap(db, gap);
    expect(await brainRepo.listGaps(db, RUN)).toEqual([gap]);

    const conflict = { id: 'conf-1' as never, namespace: 'brain' as const, createdAt: NOW, runId: RUN, factId: FACT, type: 'value' as const, severity: 'medium' as const, claimIds: [evidenceClaimId('ec-1'), evidenceClaimId('ec-2')], status: 'open' as const };
    await brainRepo.saveConflict(db, conflict);
    expect(await brainRepo.listConflicts(db, { runId: RUN, status: 'open' })).toEqual([conflict]);
    expect(await brainRepo.listConflicts(db, { status: 'resolved' })).toEqual([]);

    const canonical = { key: 'leave.small_leave.own_marriage|duration|country=be', namespace: 'brain' as const, createdAt: NOW, value: fact.winningValue!, factId: FACT, runId: RUN, confidence: 84.5, verifiedTier: 'T3' as const, nextReviewAt: '2027-09-30T00:00:00.000Z' };
    await brainRepo.upsertCanonical(db, canonical);
    expect(await brainRepo.getCanonical(db, canonical.key)).toEqual(canonical);

    const attribution = [
      { runId: RUN, sourceKind: 'evidence' as const, sourceId: doc('ev-A').document.id, contributionPct: 90, acceptedClaims: [evidenceClaimId('ec-1')], rejectedClaims: [], reliabilityPct: 100 },
      { runId: RUN, sourceKind: 'evidence' as const, sourceId: doc('ev-C').document.id, contributionPct: 0, acceptedClaims: [], rejectedClaims: [{ claimId: evidenceClaimId('ec-9'), code: 'SCOPE_MISMATCH' as const }], reliabilityPct: 0 },
      { runId: RUN, sourceKind: 'reference' as const, sourceId: page('wiki-W1').page.id, contributionPct: 10, acceptedClaims: [referenceFactId('rf-1')], rejectedClaims: [], reliabilityPct: 100 },
    ];
    await brainRepo.replaceAttribution(db, RUN, attribution);
    await brainRepo.replaceAttribution(db, RUN, attribution); // recomputed as a unit, no duplicates
    const back = await brainRepo.listAttribution(db, RUN);
    expect(back.map((a) => a.sourceId)).toEqual(['ev-A', 'wiki-W1', 'ev-C']);
    expect(back[2]!.rejectedClaims).toEqual([{ claimId: 'ec-9', code: 'SCOPE_MISMATCH' }]);
  });

  it('verification: single-use token, expiry, routing list and an append-only audit log', async () => {
    const req = { id: 'vr-1' as never, namespace: 'brain' as const, createdAt: NOW, factId: FACT, requestedFromId: personId('sarah.peeters'), reason: 'B contradicts A', status: 'pending' as const, tokenJti: 'jti-aaaaaaaa', expiresAt: '2099-01-01T00:00:00.000Z' };
    await brainRepo.saveVerificationRequest(db, req);
    await brainRepo.saveVerificationRequest(db, { ...req, id: 'vr-2' as never, requestedFromId: personId('tom.willems'), tokenJti: 'jti-expired1', expiresAt: '2020-01-01T00:00:00.000Z' });
    expect((await brainRepo.listVerificationRequests(db, { personId: 'sarah.peeters', status: 'pending' })).map((r) => r.id)).toEqual(['vr-1']);
    expect(await brainRepo.getVerificationRequestByJti(db, 'jti-aaaaaaaa')).toEqual(req);

    expect(await brainRepo.burnToken(db, 'jti-aaaaaaaa')).toBe(true);
    expect(await brainRepo.burnToken(db, 'jti-aaaaaaaa')).toBe(false); // single use
    expect(await brainRepo.burnToken(db, 'jti-expired1')).toBe(false); // expired
    expect(await brainRepo.burnToken(db, 'jti-unknown1')).toBe(false);
    expect((await brainRepo.getVerificationRequest(db, 'vr-1'))!.status).toBe('completed');

    const ev = { id: 've-1' as never, namespace: 'brain' as const, createdAt: NOW, factId: FACT, verifierId: personId('sarah.peeters'), action: 'confirm' as const, tier: 'T3' as const, payload: { note: 'klopt' }, at: NOW };
    await brainRepo.appendVerificationEvent(db, ev);
    expect(await brainRepo.listVerificationEvents(db, FACT)).toEqual([ev]);
    await expect(db.query(`UPDATE brain.verification_event SET tier = 'T0' WHERE id = 've-1'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM brain.verification_event`)).rejects.toThrow(/append-only/);
    expect(await brainRepo.listVerificationEvents(db, FACT)).toEqual([ev]);
  });

  it('org events', async () => {
    const e = { id: 'oe-1' as never, namespace: 'brain' as const, createdAt: NOW, type: 'indexation' as const, scope: { country: 'BE' }, domain: 'payroll', effectiveAt: '2027-01-01T00:00:00.000Z' };
    await brainRepo.saveOrgEvent(db, e);
    expect(await brainRepo.listOrgEvents(db)).toEqual([e]);
  });
});

describe('edges', () => {
  const e = (id: string, over: Record<string, unknown>): Edge => ({ id, ...over }) as Edge;
  const contradicts = e('edge-1', { type: 'CONTRADICTS', fromId: 'ec-2', fromKind: 'evidence_claim', toId: 'ec-1', toKind: 'evidence_claim', props: { type: 'value', severity: 'medium', explanation: '3 dagen tegenover 2 dagen' }, runId: RUN });
  const derived = e('edge-2', { type: 'DERIVED_FROM', fromId: page('wiki-W2').snapshot.id, fromKind: 'wiki_snapshot', toId: doc('ev-A').snapshot.id, toKind: 'evidence_snapshot', props: { method: 'link', score: 1 } });
  const corroborates = e('edge-3', { type: 'CORROBORATES', fromId: 'rf-1', fromKind: 'reference_fact', toId: FACT, toKind: 'fact', props: { score: 0.9 }, runId: RUN });

  it('stores typed edges (run id optional) and queries them by from/to/type/run', async () => {
    await edgeRepo.insertEdges(db, [contradicts, derived, corroborates]);
    expect(await edgeRepo.edgesFrom(db, 'ec-2')).toEqual([contradicts]);
    expect(await edgeRepo.edgesFrom(db, 'ec-2', 'AGREES')).toEqual([]);
    expect(await edgeRepo.edgesTo(db, 'ec-1', 'CONTRADICTS')).toEqual([contradicts]);
    expect(await edgeRepo.edgesTo(db, doc('ev-A').snapshot.id, 'DERIVED_FROM')).toEqual([derived]); // no runId on this one
    expect((await edgeRepo.edgesByRun(db, RUN)).map((x) => x.id)).toEqual(['edge-1', 'edge-3']);
  });

  it('refuses illegal edges before they reach the table, and the DB enum refuses unknown types', async () => {
    const illegalKinds = e('edge-x', { type: 'CORROBORATES', fromId: 'ec-1', fromKind: 'evidence_claim', toId: FACT, toKind: 'fact', props: { score: 0.5 } });
    await expect(edgeRepo.insertEdge(db, illegalKinds)).rejects.toThrow();
    const illegalProps = e('edge-y', { type: 'AGREES', fromId: 'a', fromKind: 'evidence_claim', toId: 'b', toKind: 'evidence_claim', props: { basis: 'temporal' } });
    await expect(edgeRepo.insertEdge(db, illegalProps)).rejects.toThrow();
    await expect(db.query(`INSERT INTO brain.edge (id, type, from_id, from_kind, to_id, to_kind) VALUES ('z','LIKES','a','fact','b','fact')`)).rejects.toThrow();
    expect(await count(db, 'brain.edge')).toBe(3);
  });

  it('uses the (from_id,type) / (to_id,type) / (run_id) indexes', async () => {
    await db.query('SET enable_seqscan = off');
    const plan = async (sql: string) => (await db.query<Record<string, string>>(`EXPLAIN ${sql}`, [])).rows.map((r) => Object.values(r)[0]).join('\n');
    expect(await plan(`SELECT * FROM brain.edge WHERE from_id = 'x' AND type = 'AGREES'`)).toMatch(/edge_from_type/);
    expect(await plan(`SELECT * FROM brain.edge WHERE to_id = 'x' AND type = 'AGREES'`)).toMatch(/edge_to_type/);
    expect(await plan(`SELECT * FROM brain.edge WHERE run_id = 'x'`)).toMatch(/edge_run/);
    await db.query('RESET enable_seqscan');
  });

  it('deletes by run, and a deleted run cascades to its edges', async () => {
    await edgeRepo.deleteEdgesByRun(db, RUN);
    expect((await edgeRepo.edgesByRun(db, RUN)).length).toBe(0);
    expect(await edgeRepo.edgesTo(db, doc('ev-A').snapshot.id)).toEqual([derived]); // run-less edge untouched
    await edgeRepo.insertEdge(db, contradicts);
    await db.query(`DELETE FROM brain.case_run WHERE id = $1`, [RUN]);
    expect(await edgeRepo.edgesFrom(db, 'ec-2')).toEqual([]);
    expect(await brainRepo.listFacts(db, RUN)).toEqual([]);
  });
});

describe('transactions and migrations on a second database', () => {
  it('roll back on error', async () => {
    const before = await count(db, 'org.person');
    await expect(
      db.transaction(async (tx) => {
        await orgRepo.upsertPerson(tx, { ...demo.people[0]!, id: personId('temp.person') });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await count(db, 'org.person')).toBe(before);
    expect(await orgRepo.getPerson(db, 'temp.person')).toBeNull();
  });

  it('a fresh database migrates and seeds from scratch', async () => {
    const fresh = await pgliteDb();
    try {
      expect(await migrate(fresh)).toEqual(['001_init.sql', '002_llm_cache.sql', '003_run_stage.sql', '004_reference_only.sql']);
      const r = await seedDemo(fresh);
      expect(r.evidencePassages).toBe(demo.evidence.reduce((n, e) => n + e.passages.length, 0));
    } finally {
      await fresh.close();
    }
  });
});
