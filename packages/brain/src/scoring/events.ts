import { conflictingScopeKeys, type OrgEvent, type PartialScope } from '../domain';

/**
 * Does an OrgEvent (law change, indexation, CAO update…) invalidate a claim? It does when the event took effect, its scope
 * overlaps the claim's, it concerns the claim's subject domain, and the claim was not (re-)verified after the event.
 * `domain` matches the subject exactly or as a dotted prefix ("leave" invalidates "leave.small_leave.own_marriage").
 */
export function eventInvalidates(event: Pick<OrgEvent, 'domain' | 'scope' | 'effectiveAt'>, claim: { subject: string; scope: PartialScope; lastVerifiedAt?: string }, now: Date): boolean {
  if (new Date(event.effectiveAt).getTime() > now.getTime()) return false; // not in force yet
  if (!(claim.subject === event.domain || claim.subject.startsWith(`${event.domain}.`))) return false;
  if (conflictingScopeKeys(event.scope, claim.scope).length) return false;
  return !claim.lastVerifiedAt || new Date(claim.lastVerifiedAt).getTime() < new Date(event.effectiveAt).getTime();
}
