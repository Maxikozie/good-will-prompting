import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FactSchema, runId, type Edge, type Fact, type ReferenceFact, type RunId } from '../src/domain';
import { DEFAULT_FIXTURE_DIR, FakeEmbedder, FakeProvider } from '../src/llm';
import { DEMO_QUESTION } from '../src/llm/record';
import { createContext, enrich, runThroughEnrich, runThroughGaps, type PipelineCtx } from '../src/pipeline';
import { ingestWikiPage } from '../src/reference';
import { loadEnrichmentConfig } from '../src/rules';
import { brainRepo, count, edgeRepo, evidenceRepo, pgliteDb, referenceRepo, type Db } from '../src/store';
import { seedDemo } from '../src/store/seed';

const NOW = new Date('2026-09-30T12:00:00.000Z');
const NINA = 'user:nina.maes';
const SCOPE_HINT = { country: 'BE', jointCommittee: 'PC 200', employeeCategory: 'bediende' };
const ALL_DOCS = ['ev-A', 'ev-B', 'ev-C', 'ev-D'].map((id) => ({ id }));
const cfg = loadEnrichmentConfig();

let db: Db;
let ctx: PipelineCtx;
beforeAll(async () => {
  db = await pgliteDb();
  await seedDemo(db);
  ctx = createContext({ db, llm: FakeProvider.fromDir(DEFAULT_FIXTURE_DIR), embedder: new FakeEmbedder(), now: () => NOW });
});
afterAll(async () => db.close());

type E<T extends Edge['type']> = Extract<Edge, { type: T }>;

describe('the demo through stage 50', () => {
  let RUN: RunId;
  let res: Awaited<ReturnType<typeof runThroughEnrich>>;
  let edges: Edge[];
  let facts: Fact[];
  let refFacts: ReferenceFact[];
  let factIdOf: (attribute: string, referenceOnly?: boolean) => string;
  const refOf = (pageId: string, attribute?: string) => refFacts.filter((f) => f.sourceId === pageId && (!attribute || f.attribute === attribute));
  const from = <T extends Edge['type']>(type: T, ids: string[]) => edges.filter((e): e is E<T> => e.type === type && ids.includes(e.fromId));

  beforeAll(async () => {
    res = await runThroughEnrich(ctx, { question: DEMO_QUESTION, principalId: NINA, scopeHint: SCOPE_HINT, documents: ALL_DOCS });
    RUN = res.intake.runId;
    edges = await edgeRepo.edgesByRun(db, RUN);
    facts = await brainRepo.listFacts(db, RUN);
    refFacts = [];
    for (const id of res.enrich.referenceFactIds) refFacts.push((await referenceRepo.getFact(db, id))!);
    factIdOf = (attribute, referenceOnly = false) => facts.find((f) => f.attribute === attribute && f.referenceOnly === referenceOnly && f.status !== 'REJECTED')!.id;
  });

  it('retrieves W1–W4 within budget: ≤ 3 queries per gap, ≤ 12 per run, top-k 5', async () => {
    const stats = (await brainRepo.listStageLogs(db, RUN)).find((l) => l.stage === '50-enrich')!.stats as Record<string, unknown>;
    expect(stats).toMatchObject({ gapsConsidered: 4, queriesSkippedByBudget: 0, budget: { perGap: 3, perRun: 12, topK: 5, linkHops: 1 } });
    expect(stats.queriesIssued as number).toBeLessThanOrEqual(12);
    expect(stats.queriesIssued as number).toBeGreaterThanOrEqual(4);
    expect(res.enrich.queriesIssued).toBe(stats.queriesIssued);
    expect([...(stats.pages as string[])].sort()).toEqual(['wiki-W1', 'wiki-W2', 'wiki-W3', 'wiki-W4']);
    expect(stats).toMatchObject({ sectionsExtracted: 14, extractionFailures: 0, droppedNotVerbatim: 0 });
  });

  describe('circularity guard', () => {
    it('W2 is DERIVED_FROM A (page-level via its link to A, and per copied section); W1, W3, W4 are not', async () => {
      const a = (await evidenceRepo.latestSnapshot(db, 'ev-A'))!;
      const d = edges.filter((e): e is E<'DERIVED_FROM'> => e.type === 'DERIVED_FROM');
      const w2Snapshot = (await referenceRepo.latestSnapshot(db, 'wiki-W2'))!;
      const pageLevel = d.find((e) => e.fromKind === 'wiki_snapshot');
      expect(pageLevel).toMatchObject({ fromId: w2Snapshot.id, toId: a.id, toKind: 'evidence_snapshot', props: { method: 'link', score: 1 } }); // W2 is newer than A, so it points at its original
      const sections = d.filter((e) => e.fromKind === 'wiki_section');
      expect(sections).toHaveLength(6); // Doel, Duur, Wie, Wanneer, Loon, Bewijs (W2's intro differs)
      for (const e of sections) {
        expect(e.toId).toBe(a.id);
        expect(e.fromId.startsWith(w2Snapshot.id)).toBe(true);
        expect(e.props).toMatchObject({ method: 'exact', score: 1 });
      }
      for (const page of ['wiki-W1', 'wiki-W3', 'wiki-W4']) {
        const snap = (await referenceRepo.latestSnapshot(db, page))!;
        expect(d.some((e) => e.fromId.startsWith(snap.id) || e.toId.startsWith(snap.id))).toBe(false);
      }
    });

    it('stores one independence group per claim: A, D and W2 share a group, B and every other wiki page stand alone', async () => {
      const groups = await brainRepo.listClaimGroups(db, RUN);
      const byClaim = new Map(groups.map((g) => [g.claimId, g]));
      const evidenceClaims = (await Promise.all(['ev-A', 'ev-B', 'ev-C', 'ev-D'].map(async (d) => evidenceRepo.listClaimsBySnapshot(db, (await evidenceRepo.latestSnapshot(db, d))!.id)))).flat();
      expect(groups).toHaveLength(evidenceClaims.length + refFacts.length);
      for (const c of evidenceClaims) expect(byClaim.get(c.id)).toMatchObject({ sourceKind: 'evidence', sourceId: c.sourceId });
      const groupOf = (id: string) => byClaim.get(id)!.groupId;
      const claimOf = (doc: string) => evidenceClaims.find((c) => c.sourceId === doc && c.attribute === 'duration')!;
      expect(groupOf(claimOf('ev-A').id)).toBe('ev-A');
      expect(groupOf(claimOf('ev-D').id)).toBe('ev-A');
      expect(groupOf(claimOf('ev-B').id)).toBe('ev-B');
      expect(groupOf(claimOf('ev-C').id)).toBe('ev-C');
      for (const f of refOf('wiki-W2')) expect(groupOf(f.id), f.attribute).toBe('ev-A'); // a copy shares the group of its original
      expect(new Set(refOf('wiki-W1').map((f) => groupOf(f.id)))).toEqual(new Set(['wiki-W1']));
      expect(new Set(refOf('wiki-W3').map((f) => groupOf(f.id)))).toEqual(new Set(['wiki-W3']));
      expect(new Set(refOf('wiki-W4').map((f) => groupOf(f.id)))).toEqual(new Set(['wiki-W4']));
      expect(new Set(groups.map((g) => g.groupId)).size).toBe(6); // ev-A(A,D,W2), ev-B, ev-C, W1, W3, W4
    });

    it('W2 gets zero independent credit: context edges only, never CORROBORATES / FILLS_GAP / CONTRADICTS', () => {
      const w2: string[] = refOf('wiki-W2').map((f) => f.id);
      expect(w2.length).toBe(6);
      const mine = edges.filter((e) => w2.includes(e.fromId));
      expect(new Set(mine.map((e) => e.type))).toEqual(new Set(['ADDS_CONTEXT']));
      expect(mine.filter((e) => ['CORROBORATES', 'FILLS_GAP', 'CONTRADICTS', 'MEMBER_OF'].includes(e.type))).toEqual([]);
    });
  });

  describe('bridge edges', () => {
    it('W3 FILLS_GAP the legal_basis and effective_from slots and closes them', async () => {
      const gaps = await brainRepo.listGaps(db, RUN);
      const w3 = refOf('wiki-W3');
      const legal = w3.find((f) => f.attribute === 'legal_basis')!;
      const eff = w3.find((f) => f.attribute === 'effective_from')!;
      for (const [fact, slot] of [[legal, 'legal_basis'], [eff, 'effective_from']] as const) {
        const gap = gaps.find((g) => g.type === 'MISSING_SLOT' && g.slotId === slot)!;
        const fill = edges.find((e): e is E<'FILLS_GAP'> => e.type === 'FILLS_GAP' && e.fromId === fact.id && e.toId === gap.id)!;
        expect(fill).toMatchObject({ fromKind: 'reference_fact', toKind: 'gap', runId: RUN });
        expect(fill.props.score).toBeGreaterThan(0);
        expect(gap).toMatchObject({ status: 'closed', closedBy: [fact.id] });
      }
      // the effective date also answers "MISSING_TEMPORAL" on the duration fact
      const temporal = gaps.find((g) => g.type === 'MISSING_TEMPORAL')!;
      expect(temporal).toMatchObject({ status: 'closed', closedBy: [eff.id] });
      expect(edges.some((e) => e.type === 'FILLS_GAP' && e.fromId === eff.id && e.toId === temporal.id)).toBe(true);
      // the conflict stays open: only the ladder or an owner settles it
      expect(gaps.find((g) => g.type === 'UNRESOLVED_CONFLICT')!.status).toBe('open');
      expect(res.enrich.closedGapIds.length).toBe(3);
      expect(res.enrich.partiallyClosedGapIds).toEqual([]);
    });

    it('W1 CORROBORATES the duration fact (and the proof fact), and contradicts only the claim that disagrees (B=3)', async () => {
      const w1Duration = refOf('wiki-W1', 'duration').find((f) => f.subject === 'leave.small_leave.own_marriage')!;
      expect(w1Duration.value).toMatchObject({ normalized: 2, unit: 'days' });
      const corroborates = edges.filter((e): e is E<'CORROBORATES'> => e.type === 'CORROBORATES' && e.fromId === w1Duration.id);
      expect(corroborates).toEqual([expect.objectContaining({ toId: factIdOf('duration'), toKind: 'fact', fromKind: 'reference_fact' })]);
      const contradicts = from('CONTRADICTS', [w1Duration.id]);
      const claims = (await Promise.all(['ev-A', 'ev-B', 'ev-D'].map(async (d) => evidenceRepo.listClaimsBySnapshot(db, (await evidenceRepo.latestSnapshot(db, d))!.id)))).flat().filter((c) => c.attribute === 'duration');
      const b3 = claims.find((c) => c.sourceId === 'ev-B' && c.value.normalized === 3)!;
      expect(contradicts.map((e) => e.toId)).toEqual([b3.id]);
      expect(contradicts[0]!.props).toMatchObject({ type: 'value', severity: 'medium', method: 'rule' });
      // the proof statement in W1 is independent corroboration too
      const w1Proof = refOf('wiki-W1', 'proof_required').find((f) => f.subject === 'leave.small_leave.own_marriage')!;
      expect(edges.some((e) => e.type === 'CORROBORATES' && e.fromId === w1Proof.id && e.toId === factIdOf('proof_required'))).toBe(true);
    });

    it('W4 (2019, no owner, 1 day) CONTRADICTS the duration claims and corroborates nothing', async () => {
      const w4 = refOf('wiki-W4', 'duration')[0]!;
      expect(w4.value).toMatchObject({ normalized: 1 });
      const contradicts = from('CONTRADICTS', [w4.id]);
      const targets = await Promise.all(contradicts.map((e) => evidenceRepo.getClaim(db, e.toId)));
      expect(targets.every((c) => c!.attribute === 'duration')).toBe(true);
      expect(targets.map((c) => `${c!.sourceId}:${c!.value.normalized}`).sort()).toEqual(['ev-A:2', 'ev-B:3', 'ev-D:2']);
      expect(edges.some((e) => e.type === 'CORROBORATES' && e.fromId === w4.id)).toBe(false);
      expect(edges.some((e) => e.type === 'FILLS_GAP' && e.fromId === w4.id)).toBe(false);
    });

    it('creates bridge edges only in the stage: every edge from a reference fact or to a gap is a bridge type, with run id and valid kinds', () => {
      const bridgeTypes = new Set(['FILLS_GAP', 'CORROBORATES', 'CONTRADICTS', 'ADDS_CONTEXT', 'DERIVED_FROM', 'MEMBER_OF']);
      for (const e of edges.filter((x) => x.fromKind === 'reference_fact' || (x.toKind as string) === 'gap')) expect(bridgeTypes.has(e.type), e.type).toBe(true);
      expect(res.enrich.bridges).toMatchObject({ FILLS_GAP: 3 });
      expect(Object.keys(res.enrich.bridges).sort()).toEqual(['ADDS_CONTEXT', 'CONTRADICTS', 'CORROBORATES', 'DERIVED_FROM', 'FILLS_GAP', 'MEMBER_OF']);
    });
  });

  describe('reference-only facts (ceiling PROVISIONAL)', () => {
    it('legal_basis and effective_from become referenceOnly facts backed by W3; the gaps point at them', async () => {
      const refOnly = facts.filter((f) => f.referenceOnly);
      expect(refOnly.map((f) => f.attribute).sort()).toEqual(['effective_from', 'legal_basis']);
      for (const f of refOnly) {
        expect(f).toMatchObject({ status: 'UNKNOWN', slotId: f.attribute, impact: 'high', reasons: [{ code: 'REFERENCE_ONLY' }] });
        const members = edges.filter((e): e is E<'MEMBER_OF'> => e.type === 'MEMBER_OF' && e.toId === f.id);
        expect(members).toHaveLength(1);
        expect(members[0]).toMatchObject({ fromKind: 'reference_fact', props: { role: 'support' } });
        expect(refFacts.find((r) => r.id === members[0]!.fromId)!.sourceId).toBe('wiki-W3');
        // no evidence claim in a reference-only fact
        expect(members.every((m) => m.fromKind === 'reference_fact')).toBe(true);
        // cannot be raised above PROVISIONAL, by the schema or by the database
        expect(FactSchema.safeParse({ ...f, status: 'LIKELY' }).success).toBe(false);
        await expect(db.query(`UPDATE brain.fact SET status = 'VERIFIED' WHERE id = $1`, [f.id])).rejects.toThrow();
      }
      const gaps = await brainRepo.listGaps(db, RUN);
      for (const slot of ['legal_basis', 'effective_from']) {
        expect(gaps.find((g) => g.type === 'MISSING_SLOT' && g.slotId === slot)!.factId).toBe(refOnly.find((f) => f.attribute === slot)!.id);
      }
    });

    it('evidence-backed facts are untouched (still not referenceOnly)', () => {
      expect(facts.filter((f) => !f.referenceOnly && f.status === 'UNKNOWN').map((f) => f.attribute).sort()).toEqual(['deadline', 'duration', 'eligibility', 'pay_continuation', 'proof_required', 'timing_window']);
    });
  });

  describe('corpus separation', () => {
    it('no reference row was written to an evidence table (and no evidence row to a reference table)', async () => {
      const ids = async (sql: string) => new Set((await db.query<{ id: string }>(sql)).rows.map((r) => r.id));
      const evidence = new Set([
        ...(await ids('SELECT id FROM evidence.document')), ...(await ids('SELECT id FROM evidence.snapshot')), ...(await ids('SELECT id FROM evidence.passage')), ...(await ids('SELECT id FROM evidence.claim')),
        ...(await ids('SELECT document_id AS id FROM evidence.snapshot')), ...(await ids('SELECT source_id AS id FROM evidence.claim')),
      ]);
      const reference = new Set([
        ...(await ids('SELECT id FROM reference.wiki_page')), ...(await ids('SELECT id FROM reference.wiki_snapshot')), ...(await ids('SELECT id FROM reference.wiki_section')), ...(await ids('SELECT id FROM reference.reference_fact')),
        ...(await ids('SELECT page_id AS id FROM reference.wiki_snapshot')), ...(await ids('SELECT source_id AS id FROM reference.reference_fact')),
      ]);
      expect([...evidence].filter((x) => reference.has(x))).toEqual([]); // no id lives on both sides
      expect([...evidence].filter((x) => x.startsWith('wiki-') || x.startsWith('wsnap-') || x.startsWith('rf-'))).toEqual([]);
      expect([...reference].filter((x) => x.startsWith('ev-') || x.startsWith('snap-') || x.startsWith('ec-'))).toEqual([]);
      expect(await count(db, 'evidence.document')).toBe(4);
      expect(await count(db, 'evidence.claim')).toBe(17); // exactly the claims of stage 20: enrichment added none
      expect(await count(db, 'reference.reference_fact')).toBe(refFacts.length);
      expect(refFacts.length).toBeGreaterThan(0);
    });

    it('every reference fact points at a wiki page, section and snapshot of its own corpus', async () => {
      const r = await db.query<{ n: string }>(`SELECT count(*) AS n FROM reference.reference_fact f JOIN reference.wiki_page p ON p.id = f.source_id JOIN reference.wiki_section s ON s.id = f.passage_id JOIN reference.wiki_snapshot n ON n.id = f.snapshot_id`);
      expect(Number(r.rows[0]!.n)).toBe(refFacts.length);
    });

    it('bridge edges are the only link: each connects a reference id to a brain/evidence id, never as a row in either corpus', () => {
      for (const e of edges.filter((x) => x.type === 'DERIVED_FROM')) expect([e.fromKind, e.toKind].sort().join()).toMatch(/evidence_snapshot,wiki_(section|snapshot)/);
    });
  });

  it('rerunning stage 50 gives the same graph: no duplicate facts, edges, groups; gaps return to the same state', async () => {
    const snapshot = async () => ({
      edges: (await edgeRepo.edgesByRun(db, RUN)).map((e) => e.id).sort(),
      facts: (await brainRepo.listFacts(db, RUN)).map((f) => f.id).sort(),
      gaps: (await brainRepo.listGaps(db, RUN)).map((g) => [g.id, g.status, g.factId ?? null, [...(g.closedBy ?? [])].sort()]),
      groups: (await brainRepo.listClaimGroups(db, RUN)).map((g) => `${g.claimId}=${g.groupId}`),
      refFacts: await count(db, 'reference.reference_fact'),
    });
    const before = await snapshot();
    await enrich(ctx, { runId: RUN, slotTemplate: res.intake.slotTemplate, principals: ['user:nina.maes', 'group:customer-service-be', 'group:all-staff'] });
    expect(await snapshot()).toEqual(before);
  });
});

describe('ACL and scope on the wiki side', () => {
  it('a wiki page the caller may not read is never searched; an out-of-scope page never becomes a fact', async () => {
    const d = await pgliteDb();
    try {
      await seedDemo(d);
      const provider = FakeProvider.fromDir(DEFAULT_FIXTURE_DIR);
      const c = createContext({ db: d, llm: provider, embedder: new FakeEmbedder(), now: () => NOW });
      const text = (n: string) => `# Klein verlet huwelijk ${n}\n\n## Wettelijke basis\n\nWettelijke basis koninklijk besluit klein verlet huwelijk ${n}.\n`;
      await ingestWikiPage(d, c.embedder, { id: 'wiki-secret', space: 'HR', title: 'Verlof intern', uri: 'https://x/secret', lastEditedAt: '2026-01-01', declaredScope: { country: 'BE' }, allowedPrincipals: ['group:hr-only'], text: text('intern') }, NOW);
      await ingestWikiPage(d, c.embedder, { id: 'wiki-nl', space: 'HR', title: 'Verlof Nederland', uri: 'https://x/nl', lastEditedAt: '2026-01-01', declaredScope: { country: 'NL' }, allowedPrincipals: ['*'], text: text('nl') }, NOW);
      const r = await runThroughGaps(c, { question: DEMO_QUESTION, principalId: NINA, scopeHint: SCOPE_HINT, documents: ALL_DOCS, runId: runId('run-acl-wiki') });
      // the two extra pages have no extraction fixtures: if they were retrieved the stage would fail loudly (MissingFixtureError)
      const out = await enrich(c, { runId: r.intake.runId, slotTemplate: r.intake.slotTemplate, principals: ['user:nina.maes', 'group:customer-service-be', 'group:all-staff'] });
      const pages = ((await brainRepo.listStageLogs(d, r.intake.runId)).find((l) => l.stage === '50-enrich')!.stats as { pages: string[] }).pages;
      expect(pages).not.toContain('wiki-secret');
      expect(pages).not.toContain('wiki-nl');
      expect(out.referenceFactIds.length).toBeGreaterThan(0);
    } finally {
      await d.close();
    }
  });

  it('respects a smaller run budget: queries beyond it are skipped, not silently issued', async () => {
    const d = await pgliteDb();
    try {
      await seedDemo(d);
      const c = createContext({ db: d, llm: FakeProvider.fromDir(DEFAULT_FIXTURE_DIR), embedder: new FakeEmbedder(), now: () => NOW });
      const r = await runThroughGaps(c, { question: DEMO_QUESTION, principalId: NINA, scopeHint: SCOPE_HINT, documents: ALL_DOCS, runId: runId('run-budget') });
      expect(cfg.budgets.maxQueriesPerRun).toBe(12);
      const out = await enrich(c, { runId: r.intake.runId, slotTemplate: r.intake.slotTemplate, principals: ['user:nina.maes', 'group:all-staff'] });
      expect(out.queriesIssued).toBeLessThanOrEqual(12);
      const stats = (await brainRepo.listStageLogs(d, r.intake.runId)).find((l) => l.stage === '50-enrich')!.stats as { queriesIssued: number; queriesReused: number };
      expect(stats.queriesIssued + stats.queriesReused).toBeLessThanOrEqual(4 * cfg.budgets.maxQueriesPerGap); // 4 gaps × 3
    } finally {
      await d.close();
    }
  });
});
