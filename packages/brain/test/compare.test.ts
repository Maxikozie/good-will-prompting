import { describe, expect, it } from 'vitest';
import { classifyPair, compareValues, conflictingScopeKeys, matchesQueryScope, normalizeValue, scopesOverlap, type PairSide } from '../src/domain';
import { loadScoringConfig, evidenceAuthority, knownComponentScore, ownershipWeight, verificationWeight } from '../src/scoring';
import { independenceGroups } from '../src/evidence';

const v = (raw: string, hint?: Parameters<typeof normalizeValue>[1]) => normalizeValue(raw, hint);
const side = (raw: string, over: Partial<PairSide> = {}): PairSide => ({ value: v(raw), polarity: 'affirms', conditions: [], ...over });

describe('compareValues', () => {
  it.each([
    ['2 werkdagen', '2 dagen', 'equal'],
    ['2 werkdagen', '3 werkdagen', 'different'],
    ['2 dagen', '2 uur', 'incomparable'],
    ['2 dagen', '2', 'incomparable'],
    ['2-3 dagen', '2-3 dagen', 'equal'],
    ['2-3 dagen', '5-6 dagen', 'different'],
    ['2-3 dagen', '3-4 dagen', 'partial'],
    ['2 dagen', '1-3 dagen', 'a_within_b'],
    ['1-4 dagen', '2 dagen', 'b_within_a'],
    ['2-3 dagen', '1-4 dagen', 'a_within_b'],
    ['2 dagen', '4-5 dagen', 'different'],
    ['ja', 'ja', 'equal'],
    ['ja', 'nee', 'different'],
    ['1 januari 2024', '1 januari 2025', 'different'],
    ['1 januari 2024', '01/01/2024', 'equal'],
    ['120%', '50%', 'different'],
    ['€8', '8 euro', 'equal'],
    ['een dag', '1 dag', 'equal'],
    ['kopie van de akte', 'Kopie van de akte', 'equal'],
    ['kopie van de akte', 'een uittreksel', 'incomparable'],
    ['2 dagen', 'kopie van de akte', 'incomparable'],
    ['ja', '2 dagen', 'incomparable'],
  ])('%s vs %s → %s', (a, b, expected) => expect(compareValues(v(a), v(b))).toBe(expected));

  it('numbers have no tolerance', () => expect(compareValues(v('2 dagen'), v('2,01 dagen'))).toBe('different'));

  it('enum values compare by normalized form', () => {
    expect(compareValues(v('Volledig loon', { type: 'enum' }), v('volledig  loon', { type: 'enum' }))).toBe('equal');
    expect(compareValues(v('Volledig loon', { type: 'enum' }), v('Half loon', { type: 'enum' }))).toBe('different');
  });
});

describe('classifyPair (code decides everything except free text)', () => {
  it('equal values agree; different values contradict', () => {
    expect(classifyPair(side('2 werkdagen'), side('2 dagen')).kind).toBe('agree');
    const c = classifyPair(side('2 werkdagen'), side('3 werkdagen'));
    expect(c).toMatchObject({ kind: 'contradict', type: 'value' });
    expect((c as { explanation: string }).explanation).toContain('2 werkdagen');
  });

  it('non-overlapping ranges contradict, containment refines (the narrower one), partial overlap asks the model', () => {
    expect(classifyPair(side('2-3 dagen'), side('5-6 dagen')).kind).toBe('contradict');
    expect(classifyPair(side('2 dagen'), side('1-3 dagen'))).toMatchObject({ kind: 'refine', from: 'a' });
    expect(classifyPair(side('1-3 dagen'), side('2 dagen'))).toMatchObject({ kind: 'refine', from: 'b' });
    expect(classifyPair(side('2-3 dagen'), side('3-4 dagen')).kind).toBe('needs-llm');
  });

  it('bool, enum and date differences contradict', () => {
    expect(classifyPair(side('ja'), side('nee')).kind).toBe('contradict');
    expect(classifyPair(side('1 januari 2024'), side('1 januari 2025')).kind).toBe('contradict');
  });

  it('opposite polarity with the same value contradicts (polarity); with different values it needs a model', () => {
    expect(classifyPair(side('2 dagen'), side('2 dagen', { polarity: 'negates' }))).toMatchObject({ kind: 'contradict', type: 'polarity' });
    expect(classifyPair(side('2 dagen'), side('3 dagen', { polarity: 'negates' })).kind).toBe('needs-llm');
  });

  it('identical values with extra conditions: the conditional claim refines the plain one', () => {
    expect(classifyPair(side('2 dagen', { conditions: ['na 1 jaar anciënniteit'] }), side('2 dagen'))).toMatchObject({ kind: 'refine', from: 'a', addedQualifiers: ['condition:na 1 jaar anciënniteit'] });
    expect(classifyPair(side('2 dagen'), side('2 dagen', { conditions: ['x'] }))).toMatchObject({ kind: 'refine', from: 'b' });
    expect(classifyPair(side('2 dagen', { conditions: ['x'] }), side('2 dagen', { conditions: ['y'] })).kind).toBe('agree');
  });

  it('two different effective dates make the newer claim a SUPERSEDES candidate instead of a contradiction', () => {
    expect(classifyPair(side('100%', { effectiveFrom: '2022-01-01' }), side('120%', { effectiveFrom: '2026-09-01' }))).toMatchObject({ kind: 'supersede', from: 'b', basis: 'temporal' });
    expect(classifyPair(side('120%', { effectiveFrom: '2026-09-01' }), side('100%', { effectiveFrom: '2022-01-01' }))).toMatchObject({ kind: 'supersede', from: 'a' });
    expect(classifyPair(side('100%', { effectiveFrom: '2022-01-01' }), side('120%')).kind).toBe('contradict'); // only one date: not decidable by code
  });

  it('differing free text, mixed types and units need a model', () => {
    expect(classifyPair(side('binnen 4 weken'), side('binnen de maand')).kind).toBe('needs-llm');
    expect(classifyPair(side('2 dagen'), side('2 uur')).kind).toBe('needs-llm');
    expect(classifyPair(side('2 dagen'), side('enkele dagen')).kind).toBe('needs-llm');
    expect(classifyPair(side('binnen 4 weken'), side('binnen 4 weken')).kind).toBe('agree');
  });
});

describe('scope matching', () => {
  it('conflicts only where both sides state a different value; unstated dimensions never conflict', () => {
    expect(conflictingScopeKeys({ country: 'BE', jointCommittee: 'PC 200' }, { country: 'NL', jointCommittee: 'PC 200' })).toEqual(['country']);
    expect(conflictingScopeKeys({ country: 'BE' }, { country: 'BE', jointCommittee: 'PC 200' })).toEqual([]);
    expect(conflictingScopeKeys({ country: null }, { country: 'NL' })).toEqual([]);
    expect(conflictingScopeKeys(null, undefined)).toEqual([]);
    expect(conflictingScopeKeys({ jointCommittee: 'PC 200' }, { jointCommittee: 'pc200' })).toEqual([]);
    expect(conflictingScopeKeys({ jointCommittee: 'PC 200', employeeCategory: 'arbeider' }, { jointCommittee: 'PC 311', employeeCategory: 'bediende' })).toEqual(['jointCommittee', 'employeeCategory']);
  });
  it('overlap / query match', () => {
    expect(scopesOverlap({ country: 'BE' }, { country: 'BE', product: 'hr' })).toBe(true);
    expect(matchesQueryScope({ country: 'NL', product: 'hr' }, { country: 'BE', jointCommittee: 'PC 200' })).toBe(false);
    expect(matchesQueryScope({ country: null }, { country: 'BE' })).toBe(true); // undeclared applies broadly (flagged SCOPE_UNDECLARED elsewhere)
  });
});

describe('independence groups', () => {
  it('documents with duplicate passages share a group; others stand alone', () => {
    const doc: Record<string, string> = { 'pA#0': 'A', 'pA#1': 'A', 'pD#0': 'D', 'pB#0': 'B', 'pW#0': 'W' };
    const g = independenceGroups(['A', 'B', 'D', 'W'], [['pD#0', 'pA#1'], ['pW#0', 'pD#0']], (p) => doc[p]);
    expect(g.get('A')).toBe('A');
    expect(g.get('D')).toBe('A');
    expect(g.get('W')).toBe('A'); // transitive
    expect(g.get('B')).toBe('B');
  });
  it('ignores unknown passages', () => {
    expect(independenceGroups(['A', 'B'], [['x', 'y']], () => undefined).get('B')).toBe('B');
  });
});

describe('scoring config and the components known before adjudication', () => {
  const cfg = loadScoringConfig();
  const now = new Date('2026-09-30T00:00:00Z');

  it('loads rules/scoring.yaml; weights sum to 1', () => {
    expect(Object.values(cfg.weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(cfg.tierWeights.T3).toBe(0.85);
    expect(cfg.weakSupport).toEqual({ scoreBelow: 60, lowAuthorityBelow: 0.5 });
  });

  it('verification decays by half every half-life and is 0 when unverified', () => {
    const doc = { verifiedTier: 'T3' as const, lastVerifiedAt: '2025-09-30T00:00:00.000Z' };
    expect(verificationWeight(doc, now, 365, cfg)).toBeCloseTo(0.85 * 0.5, 6);
    expect(verificationWeight({ verifiedTier: 'T4', lastVerifiedAt: '2026-09-30T00:00:00.000Z' }, now, 365, cfg)).toBeCloseTo(1, 6);
    expect(verificationWeight({}, now, 365, cfg)).toBe(0);
    expect(verificationWeight({ verifiedTier: 'T3' }, now, 365, cfg)).toBe(0);
  });

  it('ownership and authority follow the tables', () => {
    expect(ownershipWeight({ active: true }, cfg)).toBe(1);
    expect(ownershipWeight({ active: false }, cfg)).toBe(0.4);
    expect(ownershipWeight(null, cfg)).toBe(0.2);
    expect(evidenceAuthority({ sourceSystem: 'sharepoint', lastVerifiedAt: '2026-01-01T00:00:00Z' }, true, cfg)).toBe(0.85);
    expect(evidenceAuthority({ sourceSystem: 'sharepoint' }, true, cfg)).toBe(0.7);
    expect(evidenceAuthority({ sourceSystem: 'teams' }, true, cfg)).toBe(0.4);
    expect(evidenceAuthority({ sourceSystem: 'email' }, false, cfg)).toBe(0.3);
    expect(evidenceAuthority({ sourceSystem: 'other' }, false, cfg)).toBe(0.2);
  });

  it('knownComponentScore rescales V/A/O to 0–100', () => {
    expect(knownComponentScore({ V: 1, A: 1, O: 1 }, cfg)).toBeCloseTo(100, 6);
    expect(knownComponentScore({ V: 0, A: 0, O: 0 }, cfg)).toBe(0);
    expect(knownComponentScore({ V: 0, A: 0.7, O: 1 }, cfg)).toBeCloseTo((100 * (0.2 * 0.7 + 0.15)) / 0.65, 6);
  });
});
