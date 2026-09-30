import { SCOPE_KEYS, normalizeScopeValue, type ScopeKey } from './keys';

type ScopeLike = { [K in ScopeKey]?: string | null | undefined } | null | undefined;

/**
 * Scope dimensions on which two scopes CONTRADICT: both state a value and the values differ.
 * A dimension one side leaves out (missing, null, empty) is "applies broadly" and never conflicts.
 */
export function conflictingScopeKeys(a: ScopeLike, b: ScopeLike): ScopeKey[] {
  return SCOPE_KEYS.filter((k) => {
    const x = normalizeScopeValue(a?.[k]);
    const y = normalizeScopeValue(b?.[k]);
    return x !== '*' && y !== '*' && x !== y;
  });
}

/** Two scopes overlap when no dimension conflicts: a document for "BE" and one for "BE, PC 200" can describe the same fact. */
export const scopesOverlap = (a: ScopeLike, b: ScopeLike): boolean => conflictingScopeKeys(a, b).length === 0;

/** Does a claim's effective scope apply to the query scope? (SCOPE_MISMATCH when not.) Same test, named for what it means. */
export const matchesQueryScope = (claimScope: ScopeLike, queryScope: ScopeLike): boolean => scopesOverlap(claimScope, queryScope);
