import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CaseVerdictSchema,
  ClaimSchema,
  EDGE_TYPES,
  EdgeSchema,
  FactSchema,
  REASON_CODES,
  ScopeSchema,
  claimKey,
  evidenceClaimId,
  evidenceDocId,
  evidencePassageId,
  evidenceSnapshotId,
  factId,
  personId,
  referenceFactId,
  runId,
  wikiPageId,
  wikiSectionId,
  wikiSnapshotId,
  type Claim,
  type EvidenceClaimId,
  type EvidenceDocId,
  type FactId,
  type PersonId,
  type ReferenceFactId,
  type RunId,
  type WikiPageId,
} from '../src/domain';

const NOW = '2026-09-30T19:00:00Z';
const key = claimKey({ subject: 'leave.small_leave.own_marriage', attribute: 'duration', qualifiers: { country: 'BE' } });
const common = {
  span: { start: 0, end: 20 },
  quote: 'Klein verlet: 2 dagen',
  subject: 'leave.small_leave.own_marriage',
  attribute: 'duration',
  value: { type: 'number', raw: '2 dagen', normalized: 2, unit: 'days' },
  qualifiers: { country: 'BE', conditions: [] },
  temporal: {},
  polarity: 'affirms',
  modality: 'rule',
  extractionConfidence: 0.9,
  claimKey: key,
  createdAt: NOW,
};

describe('Claim (discriminated by origin)', () => {
  it('parses an evidence claim and a reference fact to their own branded shapes', () => {
    const ev = ClaimSchema.parse({ ...common, id: 'ec-1', namespace: 'evidence', origin: 'evidence', sourceId: 'doc-A', snapshotId: 's1', passageId: 'p1' });
    const ref = ClaimSchema.parse({ ...common, id: 'rf-1', namespace: 'reference', origin: 'reference', sourceId: 'wiki-1', snapshotId: 'ws1', passageId: 'sec1' });
    expect(ev.origin).toBe('evidence');
    expect(ref.origin).toBe('reference');
  });

  it('rejects a claim whose namespace disagrees with its origin', () => {
    expect(ClaimSchema.safeParse({ ...common, id: 'x', namespace: 'reference', origin: 'evidence', sourceId: 'd', snapshotId: 's', passageId: 'p' }).success).toBe(false);
  });

  it('rejects a bad claimKey, a >300 char quote and out-of-range confidence', () => {
    const base = { ...common, id: 'x', namespace: 'evidence', origin: 'evidence', sourceId: 'd', snapshotId: 's', passageId: 'p' };
    expect(ClaimSchema.safeParse({ ...base, claimKey: 'nope' }).success).toBe(false);
    expect(ClaimSchema.safeParse({ ...base, quote: 'x'.repeat(301) }).success).toBe(false);
    expect(ClaimSchema.safeParse({ ...base, extractionConfidence: 1.5 }).success).toBe(false);
  });

  it('narrows on origin at compile time', () => {
    const c = ClaimSchema.parse({ ...common, id: 'ec-1', namespace: 'evidence', origin: 'evidence', sourceId: 'doc-A', snapshotId: 's1', passageId: 'p1' });
    if (c.origin === 'evidence') expectTypeOf(c.sourceId).toEqualTypeOf<EvidenceDocId>();
    else expectTypeOf(c.sourceId).toEqualTypeOf<WikiPageId>();
  });
});

describe('Edge (discriminated union on type)', () => {
  const edge = { id: 'e1', fromId: 'a', toId: 'b' };

  it('has exactly one schema per edge type', () => {
    expect(EdgeSchema.options.map((o) => o.shape.type.value).sort()).toEqual([...EDGE_TYPES].sort());
  });

  it('accepts typed props', () => {
    expect(EdgeSchema.safeParse({ ...edge, type: 'CONTRADICTS', fromKind: 'evidence_claim', toKind: 'evidence_claim', props: { type: 'value', severity: 'high', explanation: '2 vs 3 days' } }).success).toBe(true);
    expect(EdgeSchema.safeParse({ ...edge, type: 'SUPERSEDES', fromKind: 'evidence_claim', toKind: 'evidence_claim', props: { basis: 'temporal' } }).success).toBe(true);
    expect(EdgeSchema.safeParse({ ...edge, type: 'DERIVED_FROM', fromKind: 'wiki_section', toKind: 'evidence_snapshot', props: { method: 'simhash', score: 1 } }).success).toBe(true);
    expect(EdgeSchema.safeParse({ ...edge, type: 'FILLS_GAP', fromKind: 'reference_fact', toKind: 'gap', props: { score: 0.8 } }).success).toBe(true);
  });

  it('rejects props that belong to another edge type', () => {
    expect(EdgeSchema.safeParse({ ...edge, type: 'AGREES', fromKind: 'evidence_claim', toKind: 'evidence_claim', props: { basis: 'temporal' } }).success).toBe(false);
    expect(EdgeSchema.safeParse({ ...edge, type: 'MEMBER_OF', fromKind: 'evidence_claim', toKind: 'fact', props: { role: 'boss' } }).success).toBe(false);
  });

  it('rejects node kinds the edge type may not connect (e.g. evidence → reference bridge edges only from reference facts)', () => {
    expect(EdgeSchema.safeParse({ ...edge, type: 'CORROBORATES', fromKind: 'evidence_claim', toKind: 'fact', props: { score: 0.5 } }).success).toBe(false);
    expect(EdgeSchema.safeParse({ ...edge, type: 'OWNS', fromKind: 'fact', toKind: 'wiki_page', props: { since: NOW } }).success).toBe(false);
  });

  it('rejects an unknown type', () => {
    expect(EdgeSchema.safeParse({ ...edge, type: 'LIKES', fromKind: 'fact', toKind: 'fact', props: {} }).success).toBe(false);
  });
});

describe('enums and contracts', () => {
  it('has the 21 reason codes of SPEC §6', () => {
    expect(REASON_CODES).toHaveLength(21);
    expect(new Set(REASON_CODES).size).toBe(21);
  });

  it('Scope allows country null (undeclared) but requires the key', () => {
    expect(ScopeSchema.safeParse({ country: null }).success).toBe(true);
    expect(ScopeSchema.safeParse({}).success).toBe(false);
    expect(ScopeSchema.safeParse({ country: 'BE', product: 'payroll' }).success).toBe(false);
  });

  it('Fact parses with reasons', () => {
    const f = FactSchema.parse({
      id: 'f1', namespace: 'brain', createdAt: NOW, runId: 'r1', claimKey: key, subject: 's', attribute: 'duration',
      scope: { country: 'BE' }, status: 'LIKELY', confidence: 82, reasons: [{ code: 'OWNER_VERIFIED', message: 'Verified by Sarah' }],
      needsVerification: true, impact: 'high',
    });
    expect(f.status).toBe('LIKELY');
    expect(FactSchema.safeParse({ ...f, status: 'MAYBE' }).success).toBe(false);
    expect(FactSchema.safeParse({ ...f, reasons: [{ code: 'MADE_UP', message: 'x' }] }).success).toBe(false);
  });

  it('CaseVerdict parses an empty verdict', () => {
    const v = CaseVerdictSchema.parse({
      runId: 'r1', question: 'q', scope: { country: 'BE' }, generatedSlots: false,
      answer: { text: '', sentences: [] }, facts: [], conflicts: [], gaps: [],
      attribution: { evidenceTotalPct: 0, referenceTotalPct: 0, sources: [] }, verification: [],
      versions: { rulesVersion: '1', promptVersions: {}, modelIds: {} },
    });
    expect(v.runId).toBe('r1');
  });
});

describe('branded ids cannot be mixed (compile-time)', () => {
  it('are distinct types', () => {
    expectTypeOf<EvidenceDocId>().not.toEqualTypeOf<WikiPageId>();
    expectTypeOf<EvidenceClaimId>().not.toEqualTypeOf<ReferenceFactId>();
    expectTypeOf<FactId>().not.toEqualTypeOf<RunId>();
    expectTypeOf<PersonId>().not.toEqualTypeOf<FactId>();
    expectTypeOf<EvidenceDocId>().toExtend<string>();
  });

  it('are not assignable to each other (tsc fails if one of these stops erroring)', () => {
    const doc = evidenceDocId('d');
    const page = wikiPageId('p');
    // @ts-expect-error an evidence doc id is not a wiki page id
    const a: WikiPageId = doc;
    // @ts-expect-error a wiki page id is not an evidence doc id
    const b: EvidenceDocId = page;
    // @ts-expect-error a plain string is not an id
    const c: FactId = 'f1';
    // @ts-expect-error reference fact id is not an evidence claim id
    const d: EvidenceClaimId = referenceFactId('r');
    const claimIds: Claim['id'][] = [evidenceClaimId('e'), referenceFactId('r')];
    expect([a, b, c, d, claimIds.length].length).toBe(5);
    // the other id constructors exist
    expect([evidencePassageId('x'), evidenceSnapshotId('x'), wikiSectionId('x'), wikiSnapshotId('x'), factId('x'), runId('x'), personId('x')]).toHaveLength(7);
  });
});
