import type { GapType, PartialScope, Scope, SlotTemplate } from '../domain';

// SPEC §5 stage 40: compare facts with the expected answer shape. Pure: no database, no model.

export interface GapClaim {
  id: string;
  /** Only `rule` claims can support a fact. */
  modality: string;
  /** Effective scope of the claim (own qualifiers + declared scope). */
  scope: PartialScope;
  effectiveFrom?: string;
  /** Score from the components known before adjudication (0–100). */
  score: number;
  /** Authority of its source (0–1). */
  authority: number;
  /** Independence group of its source document (duplicates/copies share one). */
  group: string;
}

export interface GapFact {
  factId: string;
  attribute: string;
  slotId?: string;
  /** Applies to the query scope (out-of-scope facts are SCOPE_MISMATCH and never count). */
  inScope: boolean;
  claims: GapClaim[];
  /** An open CONTRADICTS between two rule claims of this fact. */
  hasContradiction: boolean;
}

export interface GapDraft {
  type: GapType;
  slotId?: string;
  factId?: string;
  description: string;
}

export interface GapThresholds {
  scoreBelow: number;
  lowAuthorityBelow: number;
}

const ORDER: GapType[] = ['MISSING_SLOT', 'UNRESOLVED_CONFLICT', 'WEAK_SUPPORT', 'MISSING_SCOPE', 'MISSING_TEMPORAL'];
const has = (v: string | null | undefined) => typeof v === 'string' && v.trim() !== '';

/**
 * The five gap types of the SPEC table:
 *  MISSING_SLOT         a slot (required or optional) has no live fact
 *  UNRESOLVED_CONFLICT  a fact has an open CONTRADICTS between rule claims
 *  WEAK_SUPPORT         best claim scores below the threshold, or its only independent source has low authority (slot facts)
 *  MISSING_SCOPE        the best claim does not state the country / joint committee the query is about
 *  MISSING_TEMPORAL     no effective date on a numeric slot of a high-impact template (see DECISIONS.md)
 * A fact is "live" when it applies to the query scope and has at least one rule claim.
 */
export function detectGaps(template: SlotTemplate, query: Scope, facts: readonly GapFact[], th: GapThresholds): GapDraft[] {
  const live = facts.map((f) => ({ ...f, rule: f.claims.filter((c) => c.modality === 'rule') })).filter((f) => f.inScope && f.rule.length > 0);
  const out: GapDraft[] = [];

  for (const slot of template.slots) {
    if (!live.some((f) => f.attribute === slot.attribute)) {
      out.push({ type: 'MISSING_SLOT', slotId: slot.id, description: `No claim answers the ${slot.required ? 'required' : 'optional'} slot "${slot.id}" (${slot.attribute}).` });
    }
  }

  const neededScope = (['country', 'jointCommittee'] as const).filter((k) => has(query[k] ?? undefined));
  for (const f of live) {
    const best = [...f.rule].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))[0]!;
    const slot = template.slots.find((s) => s.attribute === f.attribute);
    const base = { factId: f.factId, ...(slot ? { slotId: slot.id } : {}) };

    if (f.hasContradiction) out.push({ type: 'UNRESOLVED_CONFLICT', ...base, description: `Rule claims about "${f.attribute}" contradict each other and no rule has settled it yet.` });

    if (slot) {
      const groups = new Map<string, number>();
      for (const c of f.rule) groups.set(c.group, Math.max(groups.get(c.group) ?? 0, c.authority));
      const singleLowAuthority = groups.size === 1 && [...groups.values()][0]! < th.lowAuthorityBelow;
      if (best.score < th.scoreBelow || singleLowAuthority) {
        out.push({
          type: 'WEAK_SUPPORT',
          ...base,
          description: best.score < th.scoreBelow ? `Best claim for "${f.attribute}" scores ${Math.round(best.score)} (< ${th.scoreBelow}).` : `"${f.attribute}" rests on a single low-authority source.`,
        });
      }
    }

    const missingScope = neededScope.filter((k) => !has((best.scope[k] as string | null | undefined) ?? undefined));
    if (missingScope.length) out.push({ type: 'MISSING_SCOPE', ...base, description: `The best claim for "${f.attribute}" does not state ${missingScope.join(' / ')}, which the question is about.` });

    if (template.impact === 'high' && slot?.valueType === 'number' && !best.effectiveFrom) {
      out.push({ type: 'MISSING_TEMPORAL', ...base, description: `No effective date for "${f.attribute}" in a high-impact subject.` });
    }
  }

  const slotIndex = (id?: string) => (id ? template.slots.findIndex((s) => s.id === id) : 99); // template order: required slots first, as written
  return out.sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type) || slotIndex(a.slotId) - slotIndex(b.slotId) || (a.factId ?? '').localeCompare(b.factId ?? ''));
}
