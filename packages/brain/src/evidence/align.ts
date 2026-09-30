import {
  classifyPair,
  compareValues,
  conflictingScopeKeys,
  matchesQueryScope,
  type EvidenceClaim,
  type PairSide,
  type ReasonCode,
  type Scope,
  type ScopeKey,
} from '../domain';
import { cosine } from '../llm/embedder';
import type { RelationOutput } from '../llm/schemas';

// SPEC §5 stage 30, pure (no database): group claims into facts, then label every pair inside a fact.

export const SAME_FACT_SIMILARITY = 0.82; // embedding cosine ≥ this → same fact
export const LLM_BAND_MIN = 0.7; // 0.70 ≤ cosine < 0.82 → ask the relation classifier

export type RelationType = 'AGREES' | 'CONTRADICTS' | 'REFINES' | 'SUPERSEDES' | 'SCOPE_DISJOINT';

export interface Relation {
  type: RelationType;
  /** Symmetric relations point from the smaller claim id to the larger; REFINES from the more specific claim; SUPERSEDES from the newer. */
  from: string;
  to: string;
  method: 'rule' | 'llm';
  explanation: string;
  /** CONTRADICTS */
  contradiction?: { type: 'value' | 'polarity' | 'temporal' | 'scope' | 'textual'; severity: 'high' | 'low' };
  /** AGREES */
  similarity?: number;
  /** REFINES */
  addedQualifiers?: string[];
  /** SUPERSEDES */
  basis?: 'temporal';
  /** SCOPE_DISJOINT */
  differingScopeKeys?: ScopeKey[];
}

export interface AlignedFact {
  /** Smallest claimKey of the members. */
  key: string;
  subject: string;
  attribute: string;
  /** Applies to the query scope. Out-of-scope facts hold SCOPE_MISMATCH claims. */
  inScope: boolean;
  members: EvidenceClaim[];
}

export interface MemberRole {
  role: 'support' | 'context' | 'rejected';
  reason?: ReasonCode;
}

export interface AlignStats {
  claims: number;
  offTopic: number;
  inScope: number;
  outOfScope: number;
  exactGroups: number;
  mergedDeterministic: number;
  mergedByEmbedding: number;
  mergedByLlm: number;
  llmCalls: number;
  relations: Record<RelationType, number>;
}

export interface AlignResult {
  facts: AlignedFact[];
  relations: Relation[];
  roles: Map<string, MemberRole>;
  stats: AlignStats;
}

export interface AlignInput {
  claims: readonly EvidenceClaim[];
  /** Only claims about this subject take part; the rest are counted as off-topic. */
  subject: string;
  query: Scope;
  embed: (texts: string[]) => Promise<number[][]>;
  /** Ask the model how two claims relate. Called with the pair in canonical order (a.id < b.id). */
  classify: (a: EvidenceClaim, b: EvidenceClaim) => Promise<RelationOutput>;
}

const sideOf = (c: EvidenceClaim): PairSide => ({ value: c.value, polarity: c.polarity, conditions: c.qualifiers.conditions, effectiveFrom: c.temporal.effectiveFrom });
const byId = (a: EvidenceClaim, b: EvidenceClaim) => a.id.localeCompare(b.id);
const pairKey = (a: EvidenceClaim, b: EvidenceClaim) => `${a.id}|${b.id}`;

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let r = x;
    while (this.parent.get(r)! !== r) r = this.parent.get(r)!;
    this.parent.set(x, r);
    return r;
  }
  union(a: string, b: string): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
    return true;
  }
}

export async function alignClaims(input: AlignInput): Promise<AlignResult> {
  const { subject, query } = input;
  const onTopic = input.claims.filter((c) => c.subject === subject);
  const inScope = onTopic.filter((c) => matchesQueryScope(c.qualifiers, query));
  const outScope = onTopic.filter((c) => !matchesQueryScope(c.qualifiers, query));

  const stats: AlignStats = {
    claims: input.claims.length,
    offTopic: input.claims.length - onTopic.length,
    inScope: inScope.length,
    outOfScope: outScope.length,
    exactGroups: 0,
    mergedDeterministic: 0,
    mergedByEmbedding: 0,
    mergedByLlm: 0,
    llmCalls: 0,
    relations: { AGREES: 0, CONTRADICTS: 0, REFINES: 0, SUPERSEDES: 0, SCOPE_DISJOINT: 0 },
  };

  // ---- lazy embeddings of claim quotes (only text claims that need a similarity check)
  const vectors = new Map<string, number[]>();
  const embedClaims = async (claims: EvidenceClaim[]) => {
    const todo = claims.filter((c) => !vectors.has(c.id));
    if (!todo.length) return;
    const out = await input.embed(todo.map((c) => c.quote));
    todo.forEach((c, i) => vectors.set(c.id, out[i]!));
  };

  // ---- LLM answers, asked at most once per pair
  const llmCache = new Map<string, RelationOutput>();
  const ask = async (x: EvidenceClaim, y: EvidenceClaim): Promise<{ a: EvidenceClaim; b: EvidenceClaim; out: RelationOutput }> => {
    const [a, b] = byId(x, y) <= 0 ? [x, y] : [y, x];
    const k = pairKey(a, b);
    let out = llmCache.get(k);
    if (!out) {
      out = await input.classify(a, b);
      llmCache.set(k, out);
      stats.llmCalls++;
    }
    return { a, b, out };
  };

  // ---- tier 1: exact claimKey
  const exact = new Map<string, EvidenceClaim[]>();
  for (const c of inScope) (exact.get(c.claimKey) ?? exact.set(c.claimKey, []).get(c.claimKey)!).push(c);
  stats.exactGroups = exact.size;
  const uf = new UnionFind();
  for (const members of exact.values()) for (const m of members) uf.union(m.id, members[0]!.id);

  // ---- tiers 2 and 3: same subject + attribute and overlapping scope, different claimKey
  const groups = [...exact.values()];
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const gi = groups[i]!;
      const gj = groups[j]!;
      if (gi[0]!.attribute !== gj[0]!.attribute) continue;
      if (conflictingScopeKeys(gi[0]!.qualifiers, gj[0]!.qualifiers).length) continue;
      if (uf.find(gi[0]!.id) === uf.find(gj[0]!.id)) continue;
      let merged = false;
      for (const x of gi) {
        for (const y of gj) {
          const cmp = compareValues(x.value, y.value);
          if (cmp !== 'incomparable') {
            merged = true; // values code can compare (same type and unit, or identical text): one proposition with competing or agreeing values
            stats.mergedDeterministic++;
          } else {
            await embedClaims([x, y]);
            const sim = cosine(vectors.get(x.id)!, vectors.get(y.id)!);
            if (sim >= SAME_FACT_SIMILARITY) {
              merged = true;
              stats.mergedByEmbedding++;
            } else if (sim >= LLM_BAND_MIN) {
              const { out } = await ask(x, y);
              if (out.relation !== 'unrelated' && out.relation !== 'scope_disjoint') {
                merged = true;
                stats.mergedByLlm++;
              }
            }
          }
          if (merged) break;
        }
        if (merged) break;
      }
      if (merged) uf.union(gi[0]!.id, gj[0]!.id);
    }
  }

  // ---- facts
  const byRoot = new Map<string, EvidenceClaim[]>();
  for (const c of inScope) (byRoot.get(uf.find(c.id)) ?? byRoot.set(uf.find(c.id), []).get(uf.find(c.id))!).push(c);
  const facts: AlignedFact[] = [...byRoot.values()].map((members) => ({
    key: members.map((m) => m.claimKey).sort()[0]!,
    subject,
    attribute: members[0]!.attribute,
    inScope: true,
    members: members.sort(byId),
  }));
  const outByKey = new Map<string, EvidenceClaim[]>();
  for (const c of outScope) (outByKey.get(c.claimKey) ?? outByKey.set(c.claimKey, []).get(c.claimKey)!).push(c);
  for (const [key, members] of outByKey) facts.push({ key, subject, attribute: members[0]!.attribute, inScope: false, members: members.sort(byId) });
  facts.sort((a, b) => Number(b.inScope) - Number(a.inScope) || a.attribute.localeCompare(b.attribute) || a.key.localeCompare(b.key));

  // ---- member roles (a claim that cannot win is still kept in the graph, with the reason)
  const roles = new Map<string, MemberRole>();
  for (const c of inScope) roles.set(c.id, c.modality === 'rule' ? { role: 'support' } : { role: 'context', reason: 'NOT_A_RULE' });
  for (const c of outScope) roles.set(c.id, { role: 'rejected', reason: 'SCOPE_MISMATCH' });

  // ---- pairwise relations inside each in-scope fact
  const relations: Relation[] = [];
  const push = (r: Relation) => {
    relations.push(r);
    stats.relations[r.type]++;
  };
  for (const fact of facts.filter((f) => f.inScope)) {
    const m = fact.members;
    for (let i = 0; i < m.length; i++) {
      for (let j = i + 1; j < m.length; j++) {
        const a = m[i]!;
        const b = m[j]!; // a.id < b.id (members are sorted)
        const severity = a.modality === 'rule' && b.modality === 'rule' ? 'high' : 'low';
        const verdict = classifyPair(sideOf(a), sideOf(b));
        switch (verdict.kind) {
          case 'agree':
            push({ type: 'AGREES', from: a.id, to: b.id, method: 'rule', explanation: verdict.explanation, similarity: 1 });
            break;
          case 'refine': {
            const [from, to] = verdict.from === 'a' ? [a, b] : [b, a];
            push({ type: 'REFINES', from: from.id, to: to.id, method: 'rule', explanation: verdict.explanation, addedQualifiers: verdict.addedQualifiers });
            break;
          }
          case 'contradict':
            push({ type: 'CONTRADICTS', from: a.id, to: b.id, method: 'rule', explanation: verdict.explanation, contradiction: { type: verdict.type, severity } });
            break;
          case 'supersede': {
            const [from, to] = verdict.from === 'a' ? [a, b] : [b, a];
            push({ type: 'SUPERSEDES', from: from.id, to: to.id, method: 'rule', explanation: verdict.explanation, basis: verdict.basis });
            break;
          }
          case 'needs-llm': {
            const { out } = await ask(a, b);
            const direct = (d: 'a' | 'b' | null, fallback: [EvidenceClaim, EvidenceClaim]): [EvidenceClaim, EvidenceClaim] => (d === 'a' ? [a, b] : d === 'b' ? [b, a] : fallback);
            if (out.relation === 'agree') {
              await embedClaims([a, b]);
              push({ type: 'AGREES', from: a.id, to: b.id, method: 'llm', explanation: out.explanation, similarity: Math.max(0, Math.min(1, cosine(vectors.get(a.id)!, vectors.get(b.id)!))) });
            } else if (out.relation === 'contradict') {
              push({ type: 'CONTRADICTS', from: a.id, to: b.id, method: 'llm', explanation: out.explanation, contradiction: { type: 'textual', severity } });
            } else if (out.relation === 'refine') {
              const [from, to] = direct(out.direction, a.qualifiers.conditions.length >= b.qualifiers.conditions.length ? [a, b] : [b, a]); // fallback: the claim with more conditions is the specific one
              push({ type: 'REFINES', from: from.id, to: to.id, method: 'llm', explanation: out.explanation, addedQualifiers: [] });
            } else if (out.relation === 'supersede') {
              const [from, to] = direct(out.direction, [b, a]); // fallback: the claim with the larger id is taken as the newer one
              push({ type: 'SUPERSEDES', from: from.id, to: to.id, method: 'llm', explanation: out.explanation, basis: 'temporal' });
            } else if (out.relation === 'scope_disjoint') {
              const keys = conflictingScopeKeys(a.qualifiers, b.qualifiers);
              push({ type: 'SCOPE_DISJOINT', from: a.id, to: b.id, method: 'llm', explanation: out.explanation, differingScopeKeys: keys.length ? keys : ['country'] });
            }
            break; // 'unrelated': no edge
          }
        }
      }
    }
  }

  // ---- SCOPE_DISJOINT between a claim that does not apply to the query and the claims that do (same subject + attribute), for explanation
  for (const o of outScope) {
    for (const i of inScope) {
      if (i.attribute !== o.attribute) continue;
      const keys = conflictingScopeKeys(o.qualifiers, i.qualifiers);
      if (!keys.length) continue;
      const [from, to] = byId(o, i) <= 0 ? [o, i] : [i, o];
      push({ type: 'SCOPE_DISJOINT', from: from.id, to: to.id, method: 'rule', explanation: `applies to a different ${keys.join(' / ')}`, differingScopeKeys: keys });
    }
  }

  return { facts, relations, roles, stats };
}
