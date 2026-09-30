import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FactSchema, REFERENCE_ONLY_CEILING, capStatus, normalizeValue, runId, unionGroups, type Fact, type FactStatus, type Scope } from '../src/domain';
import { FakeEmbedder } from '../src/llm';
import { planBridges, type BridgeClaim, type BridgeFact, type BridgeGap, type BridgeRef } from '../src/pipeline';
import { buildQueries, embedMissingSections, hopPages, ingestWikiPage, searchSections, splitSections, titleMatchesSubject } from '../src/reference';
import { loadEnrichmentConfig, loadSlotTemplates } from '../src/rules';
import { brainRepo, count, migrate, pgliteDb, referenceRepo, type Db } from '../src/store';
import { seedDemo } from '../src/store/seed';

const cfg = loadEnrichmentConfig();
const template = loadSlotTemplates().find((t) => t.subject === 'leave.small_leave.own_marriage')!;
const SUBJECT = template.subject;
const QUERY: Scope = { country: 'BE', jointCommittee: 'PC 200', employeeCategory: 'bediende' };
const QUESTION = 'Hoeveel dagen klein verlet krijg ik voor mijn eigen huwelijk en wanneer moet ik ze opnemen?';

describe('enrichment config', () => {
  it('holds the SPEC budgets', () => {
    expect(cfg.budgets).toEqual({ maxQueriesPerGap: 3, maxQueriesPerRun: 12, topK: 5, overFetch: 4, maxLinkHops: 1 });
  });
});

describe('gap-targeted query builder', () => {
  const base = { cfg, template, subject: SUBJECT, scope: QUERY };

  it('builds at most 3 distinct queries from subject + attribute + scope, and never uses the raw question', () => {
    const qs = buildQueries({ ...base, attribute: 'legal_basis' });
    expect(qs.length).toBeGreaterThan(1);
    expect(qs.length).toBeLessThanOrEqual(3);
    expect(new Set(qs.map((q) => q.text)).size).toBe(qs.length);
    for (const q of qs) {
      expect(q.text).not.toContain('Hoeveel');
      expect(q.text).not.toContain(QUESTION);
      expect(q.text.toLowerCase()).toMatch(/klein verlet|verlof|huwelijk/); // subject
      expect(q.text.toLowerCase()).toMatch(/wettelijke basis|koninklijk besluit|cao|legal/); // attribute
    }
    expect(qs.map((q) => q.kind)).toEqual(['subject+attribute', 'subject+attribute+scope', 'terms+values']);
  });

  it('adds the scope words (country, joint committee, category) only in the scoped query', () => {
    const qs = buildQueries({ ...base, attribute: 'duration' });
    expect(qs[0]!.text).not.toMatch(/PC 200|België/);
    expect(qs[1]!.text).toMatch(/België/);
    expect(qs[1]!.text).toContain('PC 200');
    expect(qs[1]!.text).toContain('bediende');
  });

  it('uses the values the evidence claims when there are some (to find pages stating one of them)', () => {
    const qs = buildQueries({ ...base, attribute: 'duration', values: ['2 werkdagen', '3 werkdagen'] });
    expect(qs[2]!.text).toContain('2 werkdagen');
    expect(qs[2]!.text).toContain('3 werkdagen');
    expect(buildQueries({ ...base, attribute: 'duration' })[2]!.text).not.toMatch(/\d werkdagen/);
  });

  it('falls back to the slot label and the attribute name for unknown subjects and attributes; respects a smaller budget', () => {
    const q = buildQueries({ cfg, template: { ...template, label: 'Thuiswerk' }, subject: 'telework.weekly_days', attribute: 'max_days', scope: { country: 'NL' } });
    expect(q[0]!.text).toBe('Thuiswerk max days');
    expect(q.every((x) => !x.text.includes('undefined'))).toBe(true);
    const tight = { ...cfg, budgets: { ...cfg.budgets, maxQueriesPerGap: 1 } };
    expect(buildQueries({ ...base, cfg: tight, attribute: 'duration' })).toHaveLength(1);
  });
});

const val = (raw: string) => normalizeValue(raw);
const ref = (id: string, attribute: string, raw: string, over: Partial<BridgeRef> = {}): BridgeRef => ({ id, attribute, value: val(raw), polarity: 'affirms', modality: 'rule', conditions: [], scope: { country: 'BE' }, score: 0.8, derived: false, group: `g-${id}`, ...over });
const claim = (id: string, raw: string): BridgeClaim => ({ id, value: val(raw), polarity: 'affirms', conditions: [] });
const fact = (id: string, attribute: string, claims: BridgeClaim[]): BridgeFact => ({ id, attribute, claims });
const gap = (id: string, type: BridgeGap['type'], attribute: string, over: Partial<BridgeGap> = {}): BridgeGap => ({ id, type, attribute, ...over });

describe('planBridges', () => {
  const duration = fact('f-dur', 'duration', [claim('a', '2 werkdagen'), claim('b', '3 werkdagen')]);

  it('an independent reference fact that agrees CORROBORATES the fact and CONTRADICTS the claims it disagrees with', () => {
    const p = planBridges([ref('w1', 'duration', '2 dagen')], [duration], []);
    expect(p.corroborates).toEqual([{ refId: 'w1', factId: 'f-dur', score: 0.8 }]);
    expect(p.contradicts).toEqual([expect.objectContaining({ refId: 'w1', claimId: 'b', type: 'value' })]);
    expect(p.fills).toEqual([]);
  });

  it('a reference fact that disagrees with every claim only CONTRADICTS (no corroboration)', () => {
    const p = planBridges([ref('w4', 'duration', '1 dag')], [duration], []);
    expect(p.corroborates).toEqual([]);
    expect(p.contradicts.map((c) => c.claimId)).toEqual(['a', 'b']);
  });

  it('derived copies and non-rule facts add context only: never corroboration, contradiction or a fill', () => {
    const p = planBridges([ref('w2', 'duration', '2 dagen', { derived: true }), ref('w5', 'duration', '9 dagen', { modality: 'opinion' })], [duration], [gap('g1', 'MISSING_SLOT', 'duration', { slotId: 'duration' })]);
    expect(p.context.map((c) => c.refId).sort()).toEqual(['w2', 'w5']);
    expect(p.corroborates).toEqual([]);
    expect(p.contradicts).toEqual([]);
    expect(p.fills).toEqual([]);
    expect(p.closures).toEqual([]);
  });

  it('MISSING_SLOT is filled by independent rule facts of that attribute: closed when they agree, partially when they differ; a referenceOnly fact is planned', () => {
    const gaps = [gap('g-legal', 'MISSING_SLOT', 'legal_basis', { slotId: 'legal_basis' })];
    const agree = planBridges([ref('x', 'legal_basis', 'koninklijk besluit van 1963'), ref('y', 'legal_basis', 'Koninklijk besluit van 1963')], [], gaps);
    expect(agree.fills.map((f) => f.refId)).toEqual(['x', 'y']);
    expect(agree.closures).toEqual([{ gapId: 'g-legal', status: 'closed', closedBy: ['x', 'y'] }]);
    expect(agree.referenceOnlyFacts).toEqual([{ attribute: 'legal_basis', slotId: 'legal_basis', gapId: 'g-legal', refIds: ['x', 'y'] }]);
    const differ = planBridges([ref('x', 'legal_basis', 'KB van 1963'), ref('y', 'legal_basis', 'CAO van 2020')], [], gaps);
    expect(differ.closures[0]!.status).toBe('partially_closed');
    expect(planBridges([], [], gaps).closures).toEqual([]);
  });

  it('MISSING_TEMPORAL is filled by an effective_from fact and creates no new fact', () => {
    const p = planBridges([ref('w3', 'effective_from', '1 januari 2024')], [duration], [gap('g-temp', 'MISSING_TEMPORAL', 'duration', { factId: 'f-dur' })]);
    expect(p.fills).toEqual([{ refId: 'w3', gapId: 'g-temp', score: 0.8 }]);
    expect(p.closures).toEqual([{ gapId: 'g-temp', status: 'closed', closedBy: ['w3'] }]);
    expect(p.referenceOnlyFacts).toEqual([]);
  });

  it('WEAK_SUPPORT closes by independent corroboration: partially with one independent group, closed with two', () => {
    const f = fact('f-x', 'proof_required', [claim('a', 'kopie akte')]);
    const g = [gap('g-weak', 'WEAK_SUPPORT', 'proof_required', { factId: 'f-x' })];
    const one = planBridges([ref('r1', 'proof_required', 'kopie akte', { group: 'wiki-W1' }), ref('r2', 'proof_required', 'kopie akte', { group: 'wiki-W1' })], [f], g);
    expect(one.closures).toEqual([{ gapId: 'g-weak', status: 'partially_closed', closedBy: ['r1', 'r2'] }]);
    const two = planBridges([ref('r1', 'proof_required', 'kopie akte', { group: 'wiki-W1' }), ref('r3', 'proof_required', 'kopie akte', { group: 'wiki-W9' })], [f], g);
    expect(two.closures[0]!.status).toBe('closed');
    const none = planBridges([ref('r4', 'proof_required', 'een uittreksel', { group: 'wiki-W7' })], [f], g);
    expect(none.closures).toEqual([]);
  });

  it('UNRESOLVED_CONFLICT is never closed by enrichment', () => {
    const p = planBridges([ref('w1', 'duration', '2 dagen')], [duration], [gap('g-conf', 'UNRESOLVED_CONFLICT', 'duration', { factId: 'f-dur' })]);
    expect(p.closures).toEqual([]);
  });

  it('is deterministic regardless of input order', () => {
    const refs = [ref('w1', 'duration', '2 dagen'), ref('w4', 'duration', '1 dag')];
    expect(planBridges([...refs].reverse(), [duration], [])).toEqual(planBridges(refs, [duration], []));
  });
});

describe('reference-only ceiling (type-level flag)', () => {
  const fact0 = (over: Record<string, unknown>): unknown => ({
    id: 'f1', namespace: 'brain', createdAt: '2026-09-30T00:00:00.000Z', runId: 'r1', claimKey: 'a'.repeat(40), subject: 's', attribute: 'legal_basis', scope: { country: 'BE' },
    status: 'PROVISIONAL', confidence: 50, reasons: [], needsVerification: true, impact: 'high', ...over,
  });

  it('the schema refuses a referenceOnly fact above PROVISIONAL, and accepts everything else', () => {
    expect(FactSchema.safeParse(fact0({ referenceOnly: true })).success).toBe(true);
    for (const status of ['UNKNOWN', 'DISPUTED', 'REJECTED', 'PROVISIONAL']) expect(FactSchema.safeParse(fact0({ referenceOnly: true, status })).success, status).toBe(true);
    for (const status of ['VERIFIED', 'LIKELY']) {
      const r = FactSchema.safeParse(fact0({ referenceOnly: true, status }));
      expect(r.success, status).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toMatch(/max PROVISIONAL/);
    }
    expect(FactSchema.safeParse(fact0({ referenceOnly: false, status: 'VERIFIED' })).success).toBe(true);
    expect(FactSchema.parse(fact0({})).referenceOnly).toBe(false); // default
  });

  it('capStatus lowers VERIFIED/LIKELY only for reference-only facts', () => {
    expect(REFERENCE_ONLY_CEILING).toBe('PROVISIONAL');
    const rows: [FactStatus, boolean, FactStatus][] = [
      ['VERIFIED', true, 'PROVISIONAL'], ['LIKELY', true, 'PROVISIONAL'], ['PROVISIONAL', true, 'PROVISIONAL'], ['DISPUTED', true, 'DISPUTED'], ['UNKNOWN', true, 'UNKNOWN'],
      ['VERIFIED', false, 'VERIFIED'], ['LIKELY', false, 'LIKELY'],
    ];
    for (const [status, only, expected] of rows) expect(capStatus(status, only), `${status}/${only}`).toBe(expected);
  });
});

describe('unionGroups', () => {
  it('links are transitive; the group id is the smallest member; unknown ids are ignored', () => {
    const g = unionGroups(['wiki-W2', 'ev-A', 'ev-D', 'wiki-W1'], [['wiki-W2', 'ev-A'], ['ev-D', 'ev-A'], ['nope', 'ev-A']]);
    expect([...g.entries()].sort()).toEqual([['ev-A', 'ev-A'], ['ev-D', 'ev-A'], ['wiki-W1', 'wiki-W1'], ['wiki-W2', 'ev-A']]);
  });
});

describe('wiki ingestion, retrieval and link hop', () => {
  let db: Db;
  const emb = new FakeEmbedder();
  const NOW = new Date('2026-09-30T12:00:00.000Z');
  const page = (id: string, text: string, over: Record<string, unknown> = {}) => ({ id, space: 'HR-wiki', title: id, uri: `https://wiki.example/${id}`, official: false, lastEditedAt: '2026-01-01', declaredScope: { country: 'BE' }, allowedPrincipals: ['*'], outLinks: [], text, ...over });

  beforeAll(async () => {
    db = await pgliteDb();
    await migrate(db);
  });
  afterAll(async () => db.close());

  it('ingests a page into snapshot, heading-aware sections with heading paths, and embeddings; a second ingest changes nothing', async () => {
    const text = '# Verlof overzicht\n\nIntro over verlof.\n\n## Klein verlet\n\nEigen huwelijk: 2 dagen.\n\n## Bewijs\n\nHuwelijksakte.\n';
    const r1 = await ingestWikiPage(db, emb, page('p-one', text), NOW);
    expect(r1).toMatchObject({ pageId: 'p-one', newSnapshot: true, sections: 3, embedded: 3 });
    const latest = (await referenceRepo.listLatestSections(db, 'p-one'))!;
    expect(latest.sections.map((s) => s.headingPath)).toEqual([['Verlof overzicht'], ['Verlof overzicht', 'Klein verlet'], ['Verlof overzicht', 'Bewijs']]);
    for (const s of latest.sections) expect(latest.snapshot.text.slice(s.start, s.end)).toBe(s.text);
    const r2 = await ingestWikiPage(db, emb, page('p-one', text), NOW);
    expect(r2).toMatchObject({ newSnapshot: false, sections: 3, embedded: 0 });
    expect(await count(db, 'reference.wiki_snapshot')).toBe(1);
    expect(await count(db, 'reference.wiki_section')).toBe(3);
  });

  it('an edited page becomes a new snapshot; search only sees the latest snapshot', async () => {
    await ingestWikiPage(db, emb, page('p-one', '# Verlof overzicht\n\n## Klein verlet\n\nEigen huwelijk: 3 dagen nieuwe regeling.\n'), new Date('2026-10-01T00:00:00Z'));
    expect(await count(db, 'reference.wiki_snapshot')).toBe(2);
    const hits = await searchSections(db, emb, cfg, { text: 'Eigen huwelijk dagen', principals: ['x'], scope: { country: 'BE' } });
    expect(hits.every((h) => h.page.id === 'p-one')).toBe(true);
    expect(hits.some((h) => h.section.text.includes('2 dagen.'))).toBe(false); // the old snapshot is gone from search
    expect(hits.some((h) => h.section.text.includes('3 dagen'))).toBe(true);
  });

  it('rejects malformed page input', async () => {
    await expect(ingestWikiPage(db, emb, { ...page('bad', 'x'), extra: 1 } as never)).rejects.toThrow();
    await expect(ingestWikiPage(db, emb, page('bad', ''))).rejects.toThrow();
  });

  it('retrieval respects ACL, the scope filter and top-k', async () => {
    const text = (n: string) => `# ${n}\n\n## Klein verlet\n\nBij eigen huwelijk heeft een werknemer recht op verlof ${n}.\n`;
    await ingestWikiPage(db, emb, page('p-secret', text('secret'), { allowedPrincipals: ['group:hr-only'] }), NOW);
    await ingestWikiPage(db, emb, page('p-nl', text('nl'), { declaredScope: { country: 'NL' } }), NOW);
    await ingestWikiPage(db, emb, page('p-be', text('be')), NOW);
    const ask = (principals: string[], scope: Scope) => searchSections(db, emb, cfg, { text: 'klein verlet eigen huwelijk recht op verlof', principals, scope });
    const pagesOf = (hits: { page: { id: string } }[]) => new Set(hits.map((h) => h.page.id));
    const outsider = pagesOf(await ask(['user:nina'], { country: 'BE' }));
    expect(outsider.has('p-secret')).toBe(false); // ACL: the caller may not read it
    expect(outsider.has('p-nl')).toBe(false); // scope filter: a Dutch page is not evidence for a Belgian question
    expect(outsider.has('p-be')).toBe(true);
    expect(pagesOf(await ask(['group:hr-only'], { country: 'BE' })).has('p-secret')).toBe(true);
    expect(pagesOf(await ask(['user:nina'], { country: 'NL' })).has('p-nl')).toBe(true);
    expect((await ask(['group:hr-only'], { country: 'BE' })).length).toBeLessThanOrEqual(cfg.budgets.topK);
  });

  it('link hop: follows outLinks once, only to readable, in-scope pages whose TITLE matches the subject', async () => {
    const mk = (id: string, title: string, links: string[], over: Record<string, unknown> = {}) => ingestWikiPage(db, emb, page(id, `# ${title}\n\nTekst.\n`, { title, outLinks: links, ...over }), NOW);
    await mk('h-start', 'Overzicht', ['h-verlof', 'h-payroll', 'h-secret', 'h-nl']);
    await mk('h-verlof', 'CAO-referenties voor verlof', ['h-deep']);
    await mk('h-deep', 'Verlof archief', []);
    await mk('h-payroll', 'Payroll kalender', []);
    await mk('h-secret', 'Verlof intern', [], { allowedPrincipals: ['group:hr-only'] });
    await mk('h-nl', 'Verlof Nederland', [], { declaredScope: { country: 'NL' } });
    const start = (await referenceRepo.getPagesByIds(db, ['h-start']))[0]!;
    const hopped = await hopPages(db, cfg, { from: [start], terms: ['verlof', 'klein verlet'], principals: ['user:nina'], scope: { country: 'BE' } });
    expect(hopped.map((p) => p.id)).toEqual(['h-verlof']); // not payroll (title), not secret (ACL), not NL (scope), not h-deep (2nd hop)
    const twoHops = await hopPages(db, { ...cfg, budgets: { ...cfg.budgets, maxLinkHops: 2 } }, { from: [start], terms: ['verlof'], principals: ['user:nina'], scope: { country: 'BE' } });
    expect(twoHops.map((p) => p.id).sort()).toEqual(['h-deep', 'h-verlof']);
    expect(await hopPages(db, { ...cfg, budgets: { ...cfg.budgets, maxLinkHops: 0 } }, { from: [start], terms: ['verlof'], principals: ['user:nina'], scope: { country: 'BE' } })).toEqual([]);
  });

  it('titleMatchesSubject ignores case and diacritics', () => {
    expect(titleMatchesSubject('CONGÉ de mariage', ['congé'])).toBe(true);
    expect(titleMatchesSubject('Payroll kalender', ['verlof'])).toBe(false);
  });

  it('embedMissingSections embeds seeded sections once', async () => {
    const seeded = await pgliteDb();
    try {
      await seedDemo(seeded);
      expect(await embedMissingSections(seeded, emb)).toBe(14);
      expect(await embedMissingSections(seeded, emb)).toBe(0);
    } finally {
      await seeded.close();
    }
  });

  it('splitSections keeps heading paths and offsets (shared splitter)', () => {
    const t = '# Titel\n\nIntro.\n\n## Een\n\nTekst.\n';
    const s = splitSections(t);
    expect(s.map((x) => x.headingPath)).toEqual([['Titel'], ['Titel', 'Een']]);
    for (const x of s) expect(t.slice(x.start, x.end)).toBe(x.text);
  });
});

describe('the database refuses a reference-only fact above PROVISIONAL', () => {
  it('writer-side (saveFact parses) and storage-side (CHECK constraint)', async () => {
    const db = await pgliteDb();
    try {
      await migrate(db);
      await brainRepo.saveRun(db, {
        id: runId('r1'), namespace: 'brain', createdAt: '2026-09-30T00:00:00.000Z', question: 'q?', principalId: 'user:x' as never,
        intent: { subject: 's', scope: { country: 'BE' }, questionType: 'rule', slotTemplateId: 's', generatedSlots: false }, status: 'running', rulesVersion: '1',
        promptVersions: {}, modelIds: {}, evidenceSnapshotIds: [], referenceSnapshotIds: [], startedAt: '2026-09-30T00:00:00.000Z',
      });
      const f = { id: 'f1', namespace: 'brain', createdAt: '2026-09-30T00:00:00.000Z', runId: 'r1', claimKey: 'a'.repeat(40), subject: 's', attribute: 'a', scope: { country: 'BE' }, status: 'PROVISIONAL', confidence: 10, reasons: [], needsVerification: true, impact: 'low', referenceOnly: true } as unknown as Fact;
      await brainRepo.saveFact(db, f);
      await expect(brainRepo.saveFact(db, { ...f, status: 'LIKELY' })).rejects.toThrow(/PROVISIONAL/);
      await expect(db.query(`UPDATE brain.fact SET status = 'VERIFIED' WHERE id = 'f1'`)).rejects.toThrow();
      await expect(db.query(`UPDATE brain.fact SET status = 'LIKELY' WHERE id = 'f1'`)).rejects.toThrow();
      await db.query(`UPDATE brain.fact SET reference_only = false, status = 'LIKELY' WHERE id = 'f1'`); // an evidence-backed fact may
      expect((await brainRepo.getFact(db, 'f1'))!.status).toBe('LIKELY');
    } finally {
      await db.close();
    }
  });
});
