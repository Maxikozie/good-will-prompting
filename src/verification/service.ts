import { ClaimValueSchema, PartialScopeSchema } from '../../packages/brain/src/domain';
import { z } from 'zod';
import type { Db } from '../../packages/brain/src/store/db';
import { authorize, Forbidden, type Principal } from '../security/authorization';
import { authorizeFact } from '../security/brain-access';
import { actionSchema, VerificationTokens, type VerifiedToken } from './tokens';

export const submissionSchema = z.object({
  token: z.string().min(1).max(8192), action: actionSchema,
  payload: z.union([
    z.object({ note: z.string().max(1000).optional(), reason: z.string().max(1000).optional() }).strict(),
    z.object({ value: ClaimValueSchema, quote: z.string().max(300).optional(), sourceUri: z.string().max(1000).optional() }).strict(),
    z.object({ scope: PartialScopeSchema }).strict(),
    z.object({ personId: z.string().min(1).max(200) }).strict(),
  ]).optional(),
}).strict();
export type Submission = z.infer<typeof submissionSchema>;
export type ApplyVerification = (tx: Db, input: Submission, principal: Principal, token: VerifiedToken) => Promise<unknown>;

/** SPEC §10, evaluated on CURRENT org/ownership/expertise and all-source ACLs.
 * Issuance and possessing the link are never evidence of permission to submit. */
export async function canVerify(tx: Db, principal: Principal, factId: string): Promise<void> {
  authorize(principal, 'brain_submit_verification', { kind: 'service' });
  const person = await tx.query<{ id: string }>(
    'SELECT id FROM org.person WHERE id = $1 AND active AND $2 = ANY(principal_ids) FOR SHARE',
    [principal.personId, principal.id],
  );
  if (!person.rows.length) throw new Forbidden();
  await authorizeFact(tx, principal, 'brain_submit_verification', factId);
  // Lock the fact to serialize mutations/approval decisions across different tokens too.
  const fact = await tx.query<{ id: string }>('SELECT id FROM brain.fact WHERE id = $1 FOR UPDATE', [factId]);
  if (!fact.rows.length) throw new Forbidden();
  // Legacy/imported membership edges may have no run_id. Check those sources too;
  // a null/missing or inconsistent claim lineage must not grant permission.
  const memberSources = await tx.query<{ acl: string[] | null }>(`
    SELECT CASE e.from_kind
      WHEN 'evidence_claim' THEN d.allowed_principals
      WHEN 'reference_fact' THEN p.allowed_principals ELSE NULL END AS acl
    FROM brain.edge e
    LEFT JOIN evidence.claim c ON e.from_kind = 'evidence_claim' AND c.id = e.from_id
    LEFT JOIN evidence.snapshot s ON s.id = c.snapshot_id AND s.document_id = c.source_id
    LEFT JOIN evidence.passage x ON x.id = c.passage_id AND x.snapshot_id = s.id
    LEFT JOIN evidence.document d ON d.id = s.document_id AND x.id IS NOT NULL
    LEFT JOIN reference.reference_fact r ON e.from_kind = 'reference_fact' AND r.id = e.from_id
    LEFT JOIN reference.wiki_snapshot ws ON ws.id = r.snapshot_id AND ws.page_id = r.source_id
    LEFT JOIN reference.wiki_section wx ON wx.id = r.passage_id AND wx.snapshot_id = ws.id
    LEFT JOIN reference.wiki_page p ON p.id = ws.page_id AND wx.id IS NOT NULL
    WHERE e.type = 'MEMBER_OF' AND e.to_kind = 'fact' AND e.to_id = $1`, [factId]);
  for (const source of memberSources.rows) {
    authorize(principal, 'brain_submit_verification', source.acl ? { kind: 'source', allowedPrincipals: source.acl } : null);
  }
  const eligible = await tx.query(`
    WITH members(kind, id) AS (
      SELECT from_kind::text, from_id FROM brain.edge WHERE type = 'MEMBER_OF' AND to_kind = 'fact' AND to_id = $1
      UNION SELECT 'evidence_claim', c.id FROM evidence.claim c JOIN brain.fact f ON f.winner_claim_id = c.id WHERE f.id = $1
      UNION SELECT 'reference_fact', c.id FROM reference.reference_fact c JOIN brain.fact f ON f.winner_claim_id = c.id WHERE f.id = $1
    ), sources(kind, id) AS (
      SELECT 'evidence_document', c.source_id FROM evidence.claim c JOIN members m ON m.kind = 'evidence_claim' AND m.id = c.id
      UNION SELECT 'wiki_page', c.source_id FROM reference.reference_fact c JOIN members m ON m.kind = 'reference_fact' AND m.id = c.id
    )
    SELECT 1 FROM org.expertise e JOIN brain.fact f ON f.id = $1
      WHERE e.person_id = $2 AND e.subject = f.subject AND e.country = f.scope->>'country' AND e.weight >= 0.6
    UNION ALL SELECT 1 FROM evidence.document d JOIN sources s ON s.kind = 'evidence_document' AND s.id = d.id WHERE d.owner_id = $2
    UNION ALL SELECT 1 FROM reference.wiki_page p JOIN sources s ON s.kind = 'wiki_page' AND s.id = p.id WHERE p.owner_id = $2
    UNION ALL SELECT 1 FROM brain.edge e WHERE e.type = 'OWNS' AND e.from_kind = 'person' AND e.from_id = $2 AND (
      EXISTS (SELECT 1 FROM members m WHERE m.kind = e.to_kind::text AND m.id = e.to_id) OR
      EXISTS (SELECT 1 FROM sources s WHERE s.kind = e.to_kind::text AND s.id = e.to_id))
    LIMIT 1`, [factId, principal.personId]);
  if (!eligible.rows.length) throw new Forbidden();
}

/** Construct at backend startup; key parsing is synchronous and fails closed.
 * All action/audit writes MUST use the passed transaction; no external effects before commit. */
export class VerificationService {
  readonly #tokens: VerificationTokens;
  constructor(env: NodeJS.ProcessEnv = process.env) { this.#tokens = new VerificationTokens(env); }
  async submit(db: Db, input: Submission, principal: Principal, apply: ApplyVerification): Promise<unknown> {
    authorize(principal, 'brain_submit_verification', { kind: 'service' });
    const parsed = submissionSchema.parse(input);
    const token = await this.#tokens.verify(parsed.token);
    if (token.verifierId !== principal.personId || !token.allowedActions.includes(parsed.action)) throw new Forbidden();
    // Keep the default six-tool stdio executable runnable with root dependencies only.
    const { burnToken } = await import('../../packages/brain/src/store/brain-repo');
    return db.transaction(async (tx) => {
      // Authorization metadata only. Burning below is the single atomic winner, not this pre-read.
      const rows = await tx.query<{ fact_id: string; requested_from_id: string }>(
        'SELECT fact_id, requested_from_id FROM brain.verification_request WHERE token_jti = $1', [token.jti],
      );
      const request = rows.rows[0];
      if (!request || request.fact_id !== token.factId || request.requested_from_id !== token.verifierId) throw new Forbidden();
      await canVerify(tx, principal, token.factId);
      // Recheck real time after waiting for locks; no demo clock affects authorization.
      if (token.expiresAt <= Date.now() || !await burnToken(tx, token.jti)) throw new Forbidden();
      // Throwing rolls back BOTH the burn and all action/audit writes.
      return apply(tx, parsed, principal, token);
    });
  }
}
