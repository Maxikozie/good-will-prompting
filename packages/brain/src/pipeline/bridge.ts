import { classifyPair, compareValues, type ClaimValue, type ConflictType, type PairSide, type PartialScope } from '../domain';

// Stage 50, decision logic only (pure): which reference facts fill a gap, corroborate or contradict the case documents, or only add
// context. Nothing here touches the database; src/pipeline/50-enrich.ts turns the plan into bridge edges (the only place they are made).

export interface BridgeRef {
  id: string;
  attribute: string;
  value: ClaimValue;
  polarity: 'affirms' | 'negates';
  modality: string;
  conditions: readonly string[];
  effectiveFrom?: string;
  scope: PartialScope;
  /** Retrieval similarity of its section (0.5 when the page was only pulled in by a link hop or page expansion). */
  score: number;
  /** A copy of (or derived from) a case document: same independence group as some evidence. It adds no independent evidence. */
  derived: boolean;
  /** Independence group of this fact. */
  group: string;
}

export interface BridgeClaim {
  id: string;
  value: ClaimValue;
  polarity: 'affirms' | 'negates';
  conditions: readonly string[];
  effectiveFrom?: string;
}

export interface BridgeFact {
  id: string;
  attribute: string;
  /** Rule claims of the case documents that apply to the question. */
  claims: BridgeClaim[];
}

export interface BridgeGap {
  id: string;
  type: 'MISSING_SLOT' | 'UNRESOLVED_CONFLICT' | 'WEAK_SUPPORT' | 'MISSING_SCOPE' | 'MISSING_TEMPORAL';
  slotId?: string;
  /** MISSING_SLOT: the slot's attribute. Others: the fact it is about. */
  attribute: string;
  factId?: string;
  /** MISSING_SCOPE: the dimensions the best claim lacks. */
  missingScope?: readonly string[];
}

export interface GapClosure {
  gapId: string;
  status: 'closed' | 'partially_closed';
  closedBy: string[];
}

export interface BridgePlan {
  fills: { refId: string; gapId: string; score: number }[];
  corroborates: { refId: string; factId: string; score: number }[];
  contradicts: { refId: string; claimId: string; type: ConflictType; explanation: string }[];
  context: { refId: string; target: { kind: 'fact' | 'gap'; id: string }; score: number }[];
  closures: GapClosure[];
  /** Slots filled only by reference facts: stage 50 creates a referenceOnly fact for each (ceiling: PROVISIONAL). */
  referenceOnlyFacts: { attribute: string; slotId: string; gapId: string; refIds: string[] }[];
}

const side = (x: { value: ClaimValue; polarity: 'affirms' | 'negates'; conditions: readonly string[]; effectiveFrom?: string }): PairSide => ({ value: x.value, polarity: x.polarity, conditions: x.conditions, effectiveFrom: x.effectiveFrom });
const independentRule = (r: BridgeRef) => r.modality === 'rule' && !r.derived;

/** Do all these reference facts state the same value? (Then the gap they fill is closed; otherwise only partially.) */
const agreeing = (refs: readonly BridgeRef[]) => refs.every((r) => compareValues(r.value, refs[0]!.value) === 'equal');

export function planBridges(refs: readonly BridgeRef[], facts: readonly BridgeFact[], gaps: readonly BridgeGap[]): BridgePlan {
  const plan: BridgePlan = { fills: [], corroborates: [], contradicts: [], context: [], closures: [], referenceOnlyFacts: [] };
  const sorted = [...refs].sort((a, b) => a.id.localeCompare(b.id));

  // ---- facts: corroborate / contradict / context, per reference fact
  const corroboratedBy = new Map<string, BridgeRef[]>(); // factId → independent corroborating refs
  for (const ref of sorted) {
    for (const fact of facts.filter((f) => f.attribute === ref.attribute)) {
      if (!independentRule(ref)) {
        plan.context.push({ refId: ref.id, target: { kind: 'fact', id: fact.id }, score: ref.score }); // copies and non-rules: context, never credit
        continue;
      }
      let agrees = 0;
      let undecided = 0;
      for (const claim of [...fact.claims].sort((a, b) => a.id.localeCompare(b.id))) {
        const v = classifyPair(side(ref), side(claim));
        if (v.kind === 'agree' || v.kind === 'refine') agrees++;
        else if (v.kind === 'contradict' || v.kind === 'supersede') plan.contradicts.push({ refId: ref.id, claimId: claim.id, type: v.kind === 'contradict' ? v.type : 'temporal', explanation: v.explanation });
        else undecided++;
      }
      if (agrees > 0) {
        plan.corroborates.push({ refId: ref.id, factId: fact.id, score: ref.score });
        corroboratedBy.set(fact.id, [...(corroboratedBy.get(fact.id) ?? []), ref]);
      } else if (undecided > 0 || fact.claims.length === 0) {
        plan.context.push({ refId: ref.id, target: { kind: 'fact', id: fact.id }, score: ref.score });
      }
    }
  }

  // ---- gaps
  for (const gap of [...gaps].sort((a, b) => a.id.localeCompare(b.id))) {
    if (gap.type === 'MISSING_SLOT' || gap.type === 'MISSING_TEMPORAL') {
      const wanted = gap.type === 'MISSING_TEMPORAL' ? 'effective_from' : gap.attribute;
      const fillers = sorted.filter((r) => independentRule(r) && r.attribute === wanted);
      if (!fillers.length) continue;
      for (const r of fillers) plan.fills.push({ refId: r.id, gapId: gap.id, score: r.score });
      plan.closures.push({ gapId: gap.id, status: agreeing(fillers) ? 'closed' : 'partially_closed', closedBy: fillers.map((r) => r.id) });
      if (gap.type === 'MISSING_SLOT' && gap.slotId) plan.referenceOnlyFacts.push({ attribute: wanted, slotId: gap.slotId, gapId: gap.id, refIds: fillers.map((r) => r.id) });
    } else if (gap.type === 'WEAK_SUPPORT' && gap.factId) {
      const support = corroboratedBy.get(gap.factId) ?? [];
      const groups = new Set(support.map((r) => r.group));
      if (groups.size) plan.closures.push({ gapId: gap.id, status: groups.size >= 2 ? 'closed' : 'partially_closed', closedBy: support.map((r) => r.id) });
    } else if (gap.type === 'MISSING_SCOPE' && gap.factId) {
      // a reference fact that agrees with the fact and states the missing scope adds context (it does not repair the evidence claim)
      for (const r of (corroboratedBy.get(gap.factId) ?? []).filter((x) => (gap.missingScope ?? []).some((k) => (x.scope as Record<string, unknown>)[k]))) {
        plan.context.push({ refId: r.id, target: { kind: 'gap', id: gap.id }, score: r.score });
      }
    }
    // UNRESOLVED_CONFLICT stays open: only the ladder in stage 60 or an owner resolves it
  }
  return plan;
}
