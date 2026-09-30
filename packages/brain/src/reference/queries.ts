import type { Scope, SlotTemplate } from '../domain';
import type { EnrichmentConfig } from '../rules/enrichment';

export interface QuerySpec {
  text: string;
  /** How the query was composed (for the run log). */
  kind: 'subject+attribute' | 'subject+attribute+scope' | 'terms+values';
}

export interface QueryInput {
  cfg: EnrichmentConfig;
  template: SlotTemplate;
  subject: string;
  /** The attribute to look for (for MISSING_TEMPORAL this is "effective_from", not the fact's own attribute). */
  attribute: string;
  scope: Scope;
  /** Values the evidence currently claims for this attribute (helps find pages that state one of them). */
  values?: readonly string[];
}

const words = (...parts: (string | null | undefined)[]) => parts.filter((p): p is string => !!p && p.trim() !== '').join(' ').replace(/\s+/g, ' ').trim();

/**
 * Gap-targeted queries (SPEC §5 stage 50): built from subject + attribute + scope, NEVER from the raw question alone.
 * Up to `maxQueriesPerGap` distinct queries, most specific last: subject+attribute, then with the scope words, then with
 * the values the evidence claims (or, without values, the other-language attribute words).
 */
export function buildQueries(i: QueryInput): QuerySpec[] {
  const subjectTerms = i.cfg.subjects[i.subject]?.terms ?? [i.template.label, ...i.subject.split('.')];
  const attrTerms = i.cfg.attributes[i.attribute] ?? [i.attribute.replace(/_/g, ' ')];
  const scopeWords = words(...(i.scope.country ? (i.cfg.countries[i.scope.country] ?? [i.scope.country]).slice(0, 1) : []), i.scope.jointCommittee, i.scope.employeeCategory);

  const out: QuerySpec[] = [
    { kind: 'subject+attribute', text: words(i.template.label, ...attrTerms.slice(0, 3)) },
    { kind: 'subject+attribute+scope', text: words(...subjectTerms.slice(0, 2), ...attrTerms, scopeWords) },
    i.values?.length
      ? { kind: 'terms+values', text: words(i.template.label, attrTerms[0], ...i.values) }
      : { kind: 'terms+values', text: words(...subjectTerms, ...attrTerms.slice(3)) },
  ];
  const seen = new Set<string>();
  return out.filter((q) => q.text && !seen.has(q.text) && seen.add(q.text)).slice(0, i.cfg.budgets.maxQueriesPerGap);
}
