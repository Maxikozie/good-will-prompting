/** Identity is supplied by a trusted transport adapter, never by tool arguments. */
export interface Principal {
  readonly id: string;
  readonly personId: string;
  readonly groups: readonly string[];
  readonly roles: readonly ('reader' | 'contributor' | 'verifier' | 'admin')[];
}

export const ACTIONS = [
  'verify_sources', 'trusted_answer', 'knowledge_health', 'flag_for_owner', 'resolve', 'find_expert',
  'brain_analyze_case', 'brain_get_verdict', 'brain_explain_fact', 'brain_list_verifications',
  'brain_submit_verification', 'brain_ingest_reference', 'brain_health',
] as const;
export type Action = typeof ACTIONS[number];

export interface SourceResource { kind: 'source'; allowedPrincipals: readonly string[] }
export interface RunResource {
  kind: 'run';
  startedBy: string;
  sources: readonly SourceResource[];
  /** False when a referenced snapshot/source is missing or its lineage is inconsistent. */
  complete: boolean;
}
export type Resource =
  | { kind: 'service' }
  | SourceResource
  | RunResource
  | { kind: 'legacy-vault'; allowedPrincipals: readonly string[] }
  | { kind: 'legacy-task'; allowedPrincipals: readonly string[]; assigneeId: string; leadId?: string }
  | { kind: 'verification'; requestedFrom: string; run: RunResource };

export class Forbidden extends Error {
  readonly status = 403;
  constructor() { super('Forbidden'); }
}

const roles: Record<Action, readonly Principal['roles'][number][]> = {
  verify_sources: ['reader', 'admin'], trusted_answer: ['reader', 'admin'],
  knowledge_health: ['reader', 'admin'], find_expert: ['reader', 'admin'],
  flag_for_owner: ['contributor', 'admin'], resolve: ['verifier', 'admin'],
  brain_analyze_case: ['contributor', 'admin'], brain_get_verdict: ['reader', 'admin'],
  brain_explain_fact: ['reader', 'admin'], brain_list_verifications: ['verifier', 'admin'],
  brain_submit_verification: ['verifier', 'admin'], brain_health: ['admin'], brain_ingest_reference: ['admin'],
};

function readable(p: Principal, acl: readonly string[]): boolean {
  // '*' grants read access only; it never grants a role or authenticated identity.
  return acl.some((id) => id === '*' || id === p.id || p.groups.includes(id));
}
function readableRun(p: Principal, r: RunResource): boolean {
  // Starting a run does not bypass revoked source ACLs, including for administrators.
  return r.complete && (r.sources.length > 0 || r.startedBy === p.id) && r.sources.every((s) => readable(p, s.allowedPrincipals));
}

/** Deny by default. Use a service gate BEFORE reading authorization metadata, then a resource gate BEFORE content. */
export function authorize(principal: Principal | null, action: Action, resource: Resource | null): asserts principal is Principal {
  const permittedRoles = Object.hasOwn(roles, action) ? roles[action] : undefined;
  if (!principal || !principal.id || !principal.personId || !resource || !permittedRoles?.some((r) => principal.roles.includes(r))) throw new Forbidden();
  let allowed = false;
  switch (resource.kind) {
    case 'service': allowed = true; break;
    case 'source':
    case 'legacy-vault': allowed = readable(principal, resource.allowedPrincipals); break;
    case 'run': allowed = readableRun(principal, resource); break;
    case 'legacy-task':
      allowed = readable(principal, resource.allowedPrincipals) &&
        (principal.personId === resource.assigneeId || principal.personId === resource.leadId);
      break;
    case 'verification':
      allowed = principal.personId === resource.requestedFrom && readableRun(principal, resource.run);
      break;
  }
  if (!allowed) throw new Forbidden();
}
