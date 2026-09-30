import type { Db } from '../../packages/brain/src/store/db';
import { authorize, Forbidden, type Action, type Principal, type RunResource } from './authorization';

/** Read only authorization metadata after the service gate; never materialize text/claims before the ACL gate. */
export async function authorizeRun(db: Db, principal: Principal, action: Action, runId: string): Promise<RunResource> {
  authorize(principal, action, { kind: 'service' });
  const runs = await db.query<{ principal_id: string }>('SELECT principal_id FROM brain.case_run WHERE id = $1', [runId]);
  if (!runs.rows[0]) throw new Forbidden();
  // Check every source reachable directly from the persisted result, not just the initial snapshot list.
  // UNION keeps corpus kinds distinct even when evidence/reference use the same textual ID.
  const result = await db.query<{ acl: string[] | null }>(`
    WITH nodes(kind, id) AS (
      SELECT 'evidence_snapshot', unnest(evidence_snapshot_ids) FROM brain.case_run WHERE id = $1
      UNION SELECT 'wiki_snapshot', unnest(reference_snapshot_ids) FROM brain.case_run WHERE id = $1
      UNION SELECT 'claim', winner_claim_id FROM brain.fact WHERE run_id = $1 AND winner_claim_id IS NOT NULL
      UNION SELECT 'claim', unnest(claim_ids) FROM brain.conflict WHERE run_id = $1
      UNION SELECT CASE source_kind WHEN 'evidence' THEN 'evidence_document' ELSE 'wiki_page' END, source_id FROM brain.attribution WHERE run_id = $1
      UNION SELECT 'claim', unnest(accepted_claims) FROM brain.attribution WHERE run_id = $1
      UNION SELECT 'claim', item->>'claimId' FROM brain.attribution, jsonb_array_elements(rejected_claims) item WHERE run_id = $1
      UNION SELECT 'reference_fact', unnest(closed_by) FROM brain.gap WHERE run_id = $1
      UNION SELECT from_kind::text, from_id FROM brain.edge WHERE run_id = $1
      UNION SELECT to_kind::text, to_id FROM brain.edge WHERE run_id = $1
    ), sources(kind, id, acl) AS (
      SELECT 'evidence_document', id, allowed_principals FROM evidence.document
      UNION ALL SELECT 'wiki_page', id, allowed_principals FROM reference.wiki_page
      UNION ALL SELECT 'evidence_snapshot', s.id, d.allowed_principals FROM evidence.snapshot s JOIN evidence.document d ON d.id = s.document_id
      UNION ALL SELECT 'wiki_snapshot', s.id, p.allowed_principals FROM reference.wiki_snapshot s JOIN reference.wiki_page p ON p.id = s.page_id
      UNION ALL SELECT 'evidence_passage', p.id, d.allowed_principals FROM evidence.passage p JOIN evidence.snapshot s ON s.id = p.snapshot_id JOIN evidence.document d ON d.id = s.document_id
      UNION ALL SELECT 'wiki_section', x.id, p.allowed_principals FROM reference.wiki_section x JOIN reference.wiki_snapshot s ON s.id = x.snapshot_id JOIN reference.wiki_page p ON p.id = s.page_id
      UNION ALL SELECT 'evidence_claim', c.id, d.allowed_principals FROM evidence.claim c JOIN evidence.document d ON d.id = c.source_id JOIN evidence.snapshot s ON s.id = c.snapshot_id AND s.document_id = c.source_id JOIN evidence.passage p ON p.id = c.passage_id AND p.snapshot_id = c.snapshot_id
      UNION ALL SELECT 'reference_fact', c.id, p.allowed_principals FROM reference.reference_fact c JOIN reference.wiki_page p ON p.id = c.source_id JOIN reference.wiki_snapshot s ON s.id = c.snapshot_id AND s.page_id = c.source_id JOIN reference.wiki_section x ON x.id = c.passage_id AND x.snapshot_id = c.snapshot_id
    )
    SELECT CASE WHEN n.kind = 'claim' AND (
      (SELECT count(*) FROM evidence.claim WHERE id = n.id) +
      (SELECT count(*) FROM reference.reference_fact WHERE id = n.id)
    ) <> 1 THEN NULL ELSE s.acl END AS acl FROM nodes n LEFT JOIN sources s ON s.id = n.id AND
      (s.kind = n.kind OR (n.kind = 'claim' AND s.kind IN ('evidence_claim', 'reference_fact')))
    WHERE n.kind IN ('evidence_document', 'wiki_page', 'evidence_snapshot', 'wiki_snapshot', 'evidence_passage', 'wiki_section', 'evidence_claim', 'reference_fact', 'claim')
  `, [runId]);
  // Graph pointers to another run/fact are not a licence to traverse its results.
  const crossRun = await db.query(`
    SELECT 1 FROM brain.edge e WHERE e.run_id = $1 AND (
      (e.from_kind = 'case_run' AND e.from_id <> $1) OR (e.to_kind = 'case_run' AND e.to_id <> $1) OR
      (e.from_kind = 'fact' AND NOT EXISTS (SELECT 1 FROM brain.fact f WHERE f.id = e.from_id AND f.run_id = $1)) OR
      (e.to_kind = 'fact' AND NOT EXISTS (SELECT 1 FROM brain.fact f WHERE f.id = e.to_id AND f.run_id = $1))
    )
    UNION ALL SELECT 1 FROM brain.conflict c WHERE c.run_id = $1 AND NOT EXISTS (SELECT 1 FROM brain.fact f WHERE f.id = c.fact_id AND f.run_id = $1)
    UNION ALL SELECT 1 FROM brain.gap g WHERE g.run_id = $1 AND g.fact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM brain.fact f WHERE f.id = g.fact_id AND f.run_id = $1)
    LIMIT 1`, [runId]);
  const resource: RunResource = {
    kind: 'run', startedBy: runs.rows[0].principal_id,
    complete: !crossRun.rows.length && result.rows.every((r) => Array.isArray(r.acl)),
    sources: result.rows.map((r) => ({ kind: 'source', allowedPrincipals: r.acl ?? [] })),
  };
  authorize(principal, action, resource);
  return resource;
}

export async function authorizeFact(db: Db, principal: Principal, action: Action, factId: string): Promise<RunResource> {
  authorize(principal, action, { kind: 'service' });
  const result = await db.query<{ run_id: string }>('SELECT run_id FROM brain.fact WHERE id = $1', [factId]);
  if (!result.rows[0]) throw new Forbidden();
  return authorizeRun(db, principal, action, result.rows[0].run_id);
}
