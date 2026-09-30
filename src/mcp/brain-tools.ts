import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../../packages/brain/src/store/db';
import { authorize, Forbidden, type Action, type Principal } from '../security/authorization';
import { authorizeFact, authorizeRun } from '../security/brain-access';

const id = z.string().trim().min(1).max(200);
const analyzeSchema = z.object({ question: z.string().trim().min(3).max(1000), documents: z.array(z.object({ id }).strict()).min(1).max(50) }).strict();
const submitSchema = z.object({ token: z.string().min(1).max(8192), action: z.enum(['confirm', 'correct', 'rescope', 'reassign', 'reject']), payload: z.record(z.string(), z.unknown()).optional() }).strict();
// Source metadata/ACLs must come from the trusted connector in ingestReference, never wiki text.
const ingestSchema = z.object({ pages: z.array(z.object({ id, text: z.string().max(100_000) }).strict()).min(1).max(50) }).strict();

export interface VerifiedToken {
  jti: string; factId: string; verifierId: string; allowedActions: readonly string[]; expiresAt: number;
}
const verifiedTokenSchema = z.object({
  jti: id, factId: id, verifierId: id, allowedActions: z.array(id).max(5), expiresAt: z.number().finite(),
}).strict();

export interface BrainOperations {
  // Deliberately no default/stub implementations. Register only when the actual pipeline/verification service is available.
  // Implementations use the provided transaction and principal, and never read identity from tool input.
  analyzeCase(db: Db, input: z.infer<typeof analyzeSchema>, principal: Principal): Promise<unknown>;
  getVerdict(db: Db, runId: string): Promise<unknown>;
  explainFact(db: Db, factId: string): Promise<unknown>;
  /** Must cryptographically verify signature, issuer, audience and expiry before returning bindings. */
  verifyToken(token: string): Promise<VerifiedToken>;
  /** Recheck can_verify/four-eyes and consume the token atomically with mutation and audit in this transaction. */
  submitVerification(db: Db, input: z.infer<typeof submitSchema>, principal: Principal, token: VerifiedToken): Promise<unknown>;
  ingestReference(db: Db, input: z.infer<typeof ingestSchema>, principal: Principal): Promise<unknown>;
  health(db: Db, input: { domain?: string; country?: string }): Promise<unknown>;
}
export interface BrainToolDependencies { db: Db; operations: BrainOperations }

/** The sole registration boundary for all seven Brain tools. Identity is captured from the authenticated transport. */
export function registerBrainTools(server: McpServer, principal: Principal, deps: BrainToolDependencies): void {
  function register<S extends z.ZodRawShape>(name: Action, shape: S, handle: (tx: Db, input: z.infer<z.ZodObject<S>>) => Promise<unknown>) {
    const schema = z.object(shape).strict();
    server.registerTool<z.ZodRawShape, typeof schema>(name, { inputSchema: schema }, async (input) => {
      try {
        // This MUST precede even acquiring a DB transaction (BEGIN is itself a DB operation).
        authorize(principal, name, { kind: 'service' });
        const result = await deps.db.transaction((tx) => handle(tx, input as z.infer<z.ZodObject<S>>));
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (err) {
        // Uniform denial: no IDs, existence hints, database messages, source names or tokens.
        return { isError: true, content: [{ type: 'text' as const, text: err instanceof Forbidden ? '403 Forbidden' : 'Internal error' }] };
      }
    });
  }

  register('brain_analyze_case', analyzeSchema.shape, async (tx, input) => {
    for (const doc of input.documents) {
      authorize(principal, 'brain_analyze_case', { kind: 'service' });
      const rows = await tx.query<{ allowed_principals: string[] }>('SELECT allowed_principals FROM evidence.document WHERE id = $1', [doc.id]);
      authorize(principal, 'brain_analyze_case', rows.rows[0] ? { kind: 'source', allowedPrincipals: rows.rows[0].allowed_principals } : null);
    }
    return deps.operations.analyzeCase(tx, input, principal);
  });
  register('brain_get_verdict', { runId: id }, async (tx, { runId }) => {
    await authorizeRun(tx, principal, 'brain_get_verdict', runId);
    return deps.operations.getVerdict(tx, runId);
  });
  register('brain_explain_fact', { factId: id }, async (tx, { factId }) => {
    await authorizeFact(tx, principal, 'brain_explain_fact', factId);
    return deps.operations.explainFact(tx, factId);
  });
  register('brain_list_verifications', {}, async (tx) => {
    authorize(principal, 'brain_list_verifications', { kind: 'service' });
    // Query only this person's requests, and never return token_jti/bearer tokens.
    const requests = await tx.query<{ id: string; fact_id: string; requested_from_id: string; reason: string; status: string; expires_at: string }>(
      'SELECT id, fact_id, requested_from_id, reason, status, expires_at FROM brain.verification_request WHERE requested_from_id = $1 ORDER BY created_at, id', [principal.personId],
    );
    const visible = [];
    for (const request of requests.rows) {
      try {
        const run = await authorizeFact(tx, principal, 'brain_list_verifications', request.fact_id);
        authorize(principal, 'brain_list_verifications', { kind: 'verification', requestedFrom: request.requested_from_id, run });
        visible.push(request);
      } catch (err) {
        if (!(err instanceof Forbidden)) throw err;
      }
    }
    return visible;
  });
  register('brain_submit_verification', submitSchema.shape, async (tx, input) => {
    let token: VerifiedToken;
    try { token = verifiedTokenSchema.parse(await deps.operations.verifyToken(input.token)); } catch { throw new Forbidden(); }
    if (token.verifierId !== principal.personId || token.expiresAt <= Date.now() || !token.allowedActions.includes(input.action)) throw new Forbidden();
    authorize(principal, 'brain_submit_verification', { kind: 'service' });
    const rows = await tx.query<{ fact_id: string; requested_from_id: string }>(
      "SELECT fact_id, requested_from_id FROM brain.verification_request WHERE token_jti = $1 AND status = 'pending' AND expires_at > now()", [token.jti],
    );
    const request = rows.rows[0];
    if (!request || request.fact_id !== token.factId || request.requested_from_id !== principal.personId) throw new Forbidden();
    const run = await authorizeFact(tx, principal, 'brain_submit_verification', request.fact_id);
    authorize(principal, 'brain_submit_verification', { kind: 'verification', requestedFrom: request.requested_from_id, run });
    return deps.operations.submitVerification(tx, input, principal, token);
  });
  register('brain_ingest_reference', ingestSchema.shape, (tx, input) => deps.operations.ingestReference(tx, input, principal));
  register('brain_health', { domain: id.optional(), country: id.optional() }, (tx, input) => deps.operations.health(tx, input));
}
