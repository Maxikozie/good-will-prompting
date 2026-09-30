import { createHash } from 'node:crypto';
import type { PartialScope } from './scope';

/**
 * Scope dimensions that identify a fact (SPEC §2.1 Scope, §3 claimKey).
 * `language` is deliberately NOT part of the key: the same rule written in NL and FR must still align (docs/brain/DECISIONS.md).
 */
export const SCOPE_KEYS = ['country', 'region', 'jointCommittee', 'employeeCategory', 'product', 'customerId'] as const;
export type ScopeKey = (typeof SCOPE_KEYS)[number];

type ScopeLike = { [K in ScopeKey]?: string | null | undefined } | null | undefined;

const WILDCARD = '*';

/** lowercase, strip diacritics, keep letters+digits only: "PC 200" and "pc200" are the same committee. */
export function normalizeScopeValue(v: string | null | undefined): string {
  if (v == null) return WILDCARD;
  const s = v
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return s === '' ? WILDCARD : s;
}

/**
 * Canonical string for a scope: fixed key order, normalized values, `*` for missing/null/empty.
 * Order-independent (object key order never matters) and null-safe (null/undefined scope = all wildcards).
 */
export function scopeKey(scope: ScopeLike): string {
  return SCOPE_KEYS.map((k) => `${k}=${normalizeScopeValue(scope?.[k])}`).join(';');
}

/** qualifiers ⊕ declaredScope (SPEC §3): a claim's own qualifier wins, the document's declared scope fills the blanks. */
export function mergeScope(declared: PartialScope | null | undefined, qualifiers: PartialScope | null | undefined): PartialScope {
  const out: Record<string, unknown> = {};
  for (const src of [declared, qualifiers]) {
    if (!src) continue;
    for (const k of [...SCOPE_KEYS, 'language'] as const) {
      const v = src[k];
      if (v !== undefined && v !== null && v !== '') out[k] = v;
    }
  }
  // country: null means "explicitly undeclared" and only survives if nothing declared it
  if (out.country === undefined && (qualifiers?.country === null || declared?.country === null)) out.country = null;
  return out as PartialScope;
}

/** Scope dimensions on which two scopes differ (used by ladder rule 1, scope split). */
export function differingScopeKeys(a: ScopeLike, b: ScopeLike): ScopeKey[] {
  return SCOPE_KEYS.filter((k) => normalizeScopeValue(a?.[k]) !== normalizeScopeValue(b?.[k]));
}

export interface ClaimKeyInput {
  subject: string;
  attribute: string;
  qualifiers?: PartialScope | null;
  declaredScope?: PartialScope | null;
}

/** sha1(subject|attribute|scopeKey(qualifiers ⊕ declaredScope)). Subject/attribute are trimmed and lowercased. */
export function claimKey(input: ClaimKeyInput): string {
  const scope = mergeScope(input.declaredScope, input.qualifiers);
  const raw = `${input.subject.trim().toLowerCase()}|${input.attribute.trim().toLowerCase()}|${scopeKey(scope)}`;
  return createHash('sha1').update(raw).digest('hex');
}
