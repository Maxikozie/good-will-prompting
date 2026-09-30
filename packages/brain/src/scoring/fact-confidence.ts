import type { PartialScope, Scope } from '../domain';
import { normalizeScopeValue } from '../domain';
import type { ScoringConfig } from './config';

type Dim = 'country' | 'region' | 'jointCommittee' | 'employeeCategory' | 'customerId';
const DIMS: Dim[] = ['country', 'region', 'jointCommittee', 'employeeCategory', 'customerId'];
const stated = (v: string | null | undefined) => normalizeScopeValue(v) !== '*';

/**
 * ScopeFit (SPEC §8.2): exact 1.0 · parent scope 0.8 (the claim is broader than the question: e.g. country-level for a joint-committee
 * question, or no country stated) · product unknown 0.6 · a conflicting scope (other country, committee, …) 0.
 */
export function scopeFit(claim: PartialScope | null | undefined, query: Scope, cfg: ScoringConfig): number {
  const c = (claim ?? {}) as Record<string, string | null | undefined>;
  const q = query as unknown as Record<string, string | null | undefined>;
  for (const d of [...DIMS, 'product'] as const) if (stated(c[d]) && stated(q[d]) && normalizeScopeValue(c[d]) !== normalizeScopeValue(q[d])) return cfg.scopeFit.otherCountry;
  let fit = cfg.scopeFit.exact;
  for (const d of DIMS) if (stated(q[d]) && !stated(c[d])) fit = Math.min(fit, cfg.scopeFit.parent);
  if (stated(q.product) && !stated(c.product)) fit = Math.min(fit, cfg.scopeFit.productUnknown);
  return fit;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** FactConfidence = min(100, winnerScore + bonus × min(1, independentCorroborations / forFullBonus)) × ScopeFit. */
export function factConfidence(winnerScore: number, independentCorroborations: number, fit: number, cfg: ScoringConfig): number {
  const bonus = cfg.corroboration.bonus * Math.min(1, Math.max(0, independentCorroborations) / cfg.corroboration.forFullBonus);
  return round2(Math.max(0, Math.min(100, Math.min(100, winnerScore + bonus) * fit)));
}

/** Bands (SPEC §8.2): ≥ 80 trusted · 60–79 use with care · < 60 ask the owner. */
export function confidenceBand(confidence: number, cfg: ScoringConfig): 'trusted' | 'careful' | 'ask_owner' {
  return confidence >= cfg.bands.trusted ? 'trusted' : confidence >= cfg.bands.careful ? 'careful' : 'ask_owner';
}
