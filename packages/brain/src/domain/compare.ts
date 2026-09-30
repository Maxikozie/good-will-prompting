import type { ClaimValue } from './claim';

// Deterministic comparison of normalized claim values (SPEC §5 stage 30): numbers with tolerance 0, ranges by overlap,
// bool/enum/date by equality. Only free text (and type/unit mismatches) is left to the LLM.

export type Comparison =
  | 'equal'
  | 'different'
  | 'a_within_b' // a is a number inside range b, or a narrower range inside b
  | 'b_within_a'
  | 'partial' // ranges overlap but neither contains the other
  | 'incomparable'; // free text, other types, other units: cannot be decided by code

interface Span {
  min: number;
  max: number;
}

function span(v: ClaimValue): Span | null {
  if (v.type === 'number' && typeof v.normalized === 'number') return { min: v.normalized, max: v.normalized };
  if (v.type === 'range') {
    const n = v.normalized as Partial<Span> | null;
    if (n && typeof n.min === 'number' && typeof n.max === 'number') return { min: n.min, max: n.max };
  }
  return null;
}

export function compareValues(a: ClaimValue, b: ClaimValue): Comparison {
  const numeric = (a.type === 'number' || a.type === 'range') && (b.type === 'number' || b.type === 'range');
  if (numeric) {
    if (a.unit !== b.unit) return 'incomparable';
    const x = span(a);
    const y = span(b);
    if (!x || !y) return 'incomparable';
    if (x.min === y.min && x.max === y.max) return 'equal';
    if (x.max < y.min || y.max < x.min) return 'different';
    if (x.min >= y.min && x.max <= y.max) return 'a_within_b';
    if (y.min >= x.min && y.max <= x.max) return 'b_within_a';
    return 'partial';
  }
  if (a.type !== b.type) return 'incomparable';
  if (a.type === 'bool' || a.type === 'enum' || a.type === 'date') return a.normalized === b.normalized ? 'equal' : 'different';
  if (a.type === 'text') return a.normalized === b.normalized ? 'equal' : 'incomparable';
  return 'incomparable';
}

/** Can code alone tell whether two values state the same thing or compete? (Everything except differing free text.) */
export const isDeterministic = (c: Comparison): boolean => c !== 'incomparable';

export type ContradictionType = 'value' | 'polarity' | 'temporal' | 'scope' | 'textual';

export interface PairSide {
  value: ClaimValue;
  polarity: 'affirms' | 'negates';
  conditions: readonly string[];
  effectiveFrom?: string;
}

export type PairVerdict =
  | { kind: 'agree'; explanation: string }
  /** `from` refines `to` (the more specific side points at the broader one). */
  | { kind: 'refine'; from: 'a' | 'b'; addedQualifiers: string[]; explanation: string }
  | { kind: 'contradict'; type: ContradictionType; explanation: string }
  /** Candidate only: stage 60 confirms. `from` is the newer side. */
  | { kind: 'supersede'; from: 'a' | 'b'; basis: 'temporal'; explanation: string }
  | { kind: 'needs-llm' };

const show = (v: ClaimValue) => `"${v.raw}"`;
const extra = (more: readonly string[], base: readonly string[]) => more.filter((c) => !base.includes(c));

/**
 * Label one pair of claims of the same fact without a model, or say that a model is needed.
 *  - equal values, same polarity → agree (refine if one adds conditions the other lacks)
 *  - equal values, opposite polarity → contradict (polarity)
 *  - different values, same polarity → contradict (value), or a supersede candidate when both carry different effective dates
 *  - one value inside the other's range → refine (the narrower one refines the broader one)
 *  - free text that differs, mixed types/units, partial range overlap, opposite polarity with different values → needs-llm
 */
export function classifyPair(a: PairSide, b: PairSide): PairVerdict {
  const cmp = compareValues(a.value, b.value);
  const samePolarity = a.polarity === b.polarity;

  if (cmp === 'equal') {
    if (!samePolarity) return { kind: 'contradict', type: 'polarity', explanation: `same value ${show(a.value)} but one claim affirms and the other negates it` };
    const aExtra = extra(a.conditions, b.conditions);
    const bExtra = extra(b.conditions, a.conditions);
    if (aExtra.length && !bExtra.length) return { kind: 'refine', from: 'a', addedQualifiers: aExtra.map((c) => `condition:${c}`), explanation: `same value ${show(a.value)}, with extra conditions` };
    if (bExtra.length && !aExtra.length) return { kind: 'refine', from: 'b', addedQualifiers: bExtra.map((c) => `condition:${c}`), explanation: `same value ${show(a.value)}, with extra conditions` };
    return { kind: 'agree', explanation: `both state ${show(a.value)}` };
  }

  if (!samePolarity) return { kind: 'needs-llm' };

  if (cmp === 'different') {
    if (a.effectiveFrom && b.effectiveFrom && a.effectiveFrom !== b.effectiveFrom) {
      const newer = a.effectiveFrom > b.effectiveFrom ? 'a' : 'b';
      return { kind: 'supersede', from: newer, basis: 'temporal', explanation: `${show(a.value)} (from ${a.effectiveFrom}) vs ${show(b.value)} (from ${b.effectiveFrom}): the later effective date replaces the earlier one` };
    }
    return { kind: 'contradict', type: 'value', explanation: `${show(a.value)} vs ${show(b.value)}` };
  }
  if (cmp === 'a_within_b') return { kind: 'refine', from: 'a', addedQualifiers: ['narrower range'], explanation: `${show(a.value)} lies within ${show(b.value)}` };
  if (cmp === 'b_within_a') return { kind: 'refine', from: 'b', addedQualifiers: ['narrower range'], explanation: `${show(b.value)} lies within ${show(a.value)}` };
  return { kind: 'needs-llm' }; // partial overlap, incomparable
}
