import {
  AttributionSchema,
  CanonicalSchema,
  CaseRunSchema,
  ConflictSchema,
  FactSchema,
  GapSchema,
  OrgEventSchema,
  StageLogSchema,
  VerificationEventSchema,
  VerificationRequestSchema,
  type Attribution,
  type Canonical,
  type CaseRun,
  type Conflict,
  type Fact,
  type Gap,
  type OrgEvent,
  type StageLog,
  type VerificationEvent,
  type VerificationRequest,
} from '../domain';
import type { Db } from './db';
import { clean, iso, isoReq, json, opt, parseRow, upsert } from './rows';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ns = (r: Row) => ({ namespace: 'brain', createdAt: isoReq(r.created_at) });

// ---------------------------------------------------------------- runs
const runFromRow = (r: Row): CaseRun =>
  parseRow(CaseRunSchema, clean({
    id: r.id, ...ns(r), question: r.question, principalId: r.principal_id, intent: r.intent, status: r.status, rulesVersion: r.rules_version,
    promptVersions: r.prompt_versions, modelIds: r.model_ids, evidenceSnapshotIds: r.evidence_snapshot_ids, referenceSnapshotIds: r.reference_snapshot_ids,
    startedAt: isoReq(r.started_at), finishedAt: iso(r.finished_at),
  }));

export async function saveRun(db: Db, run: CaseRun): Promise<void> {
  await upsert(db, 'brain.case_run', {
    id: run.id, question: run.question, principal_id: run.principalId, intent: json(run.intent), status: run.status, rules_version: run.rulesVersion,
    prompt_versions: json(run.promptVersions), model_ids: json(run.modelIds), evidence_snapshot_ids: run.evidenceSnapshotIds,
    reference_snapshot_ids: run.referenceSnapshotIds, started_at: run.startedAt, finished_at: run.finishedAt, created_at: run.createdAt,
  }, ['id']);
}

export async function getRun(db: Db, id: string): Promise<CaseRun | null> {
  const r = await db.query('SELECT * FROM brain.case_run WHERE id = $1', [id]);
  return r.rows[0] ? runFromRow(r.rows[0]) : null;
}

// ---------------------------------------------------------------- facts
const factFromRow = (r: Row): Fact =>
  parseRow(FactSchema, clean({
    id: r.id, ...ns(r), runId: r.run_id, claimKey: r.claim_key, subject: r.subject, attribute: r.attribute, scope: r.scope, slotId: opt(r.slot_id),
    status: r.status, confidence: r.confidence, winnerClaimId: opt(r.winner_claim_id), winningValue: opt(r.winning_value), reasons: r.reasons,
    needsVerification: r.needs_verification, impact: r.impact, referenceOnly: r.reference_only,
  }));

export async function saveFact(db: Db, input: Fact): Promise<void> {
  const f = FactSchema.parse(input); // enforces the reference-only ceiling at write time
  await upsert(db, 'brain.fact', {
    id: f.id, run_id: f.runId, claim_key: f.claimKey, subject: f.subject, attribute: f.attribute, scope: json(f.scope), slot_id: f.slotId, status: f.status,
    confidence: f.confidence, winner_claim_id: f.winnerClaimId, winning_value: f.winningValue === undefined ? null : json(f.winningValue),
    reasons: json(f.reasons), needs_verification: f.needsVerification, impact: f.impact, reference_only: f.referenceOnly, created_at: f.createdAt,
  }, ['id']);
}

export async function getFact(db: Db, id: string): Promise<Fact | null> {
  const r = await db.query('SELECT * FROM brain.fact WHERE id = $1', [id]);
  return r.rows[0] ? factFromRow(r.rows[0]) : null;
}

export async function listFacts(db: Db, runId: string): Promise<Fact[]> {
  const r = await db.query('SELECT * FROM brain.fact WHERE run_id = $1 ORDER BY id', [runId]);
  return r.rows.map(factFromRow);
}

// ---------------------------------------------------------------- gaps & conflicts
const gapFromRow = (r: Row): Gap =>
  parseRow(GapSchema, clean({ id: r.id, ...ns(r), runId: r.run_id, type: r.type, slotId: opt(r.slot_id), factId: opt(r.fact_id), description: r.description, closedBy: opt(r.closed_by), status: r.status }));

export async function saveGap(db: Db, g: Gap): Promise<void> {
  await upsert(db, 'brain.gap', { id: g.id, run_id: g.runId, type: g.type, slot_id: g.slotId, fact_id: g.factId, description: g.description, closed_by: g.closedBy, status: g.status, created_at: g.createdAt }, ['id']);
}

export async function listGaps(db: Db, runId: string): Promise<Gap[]> {
  const r = await db.query('SELECT * FROM brain.gap WHERE run_id = $1 ORDER BY id', [runId]);
  return r.rows.map(gapFromRow);
}

const conflictFromRow = (r: Row): Conflict =>
  parseRow(ConflictSchema, clean({
    id: r.id, ...ns(r), runId: r.run_id, factId: r.fact_id, type: r.type, severity: r.severity, claimIds: r.claim_ids, resolution: opt(r.resolution),
    resolvedBy: opt(r.resolved_by), status: r.status,
  }));

export async function saveConflict(db: Db, c: Conflict): Promise<void> {
  await upsert(db, 'brain.conflict', {
    id: c.id, run_id: c.runId, fact_id: c.factId, type: c.type, severity: c.severity, claim_ids: c.claimIds, resolution: c.resolution, resolved_by: c.resolvedBy,
    status: c.status, created_at: c.createdAt,
  }, ['id']);
}

export async function listConflicts(db: Db, opts: { runId?: string; factId?: string; status?: 'open' | 'resolved' } = {}): Promise<Conflict[]> {
  const r = await db.query(
    `SELECT * FROM brain.conflict WHERE ($1::text IS NULL OR run_id = $1) AND ($2::text IS NULL OR fact_id = $2) AND ($3::text IS NULL OR status = $3) ORDER BY id`,
    [opts.runId ?? null, opts.factId ?? null, opts.status ?? null],
  );
  return r.rows.map(conflictFromRow);
}

// ---------------------------------------------------------------- canonical
const canonicalFromRow = (r: Row): Canonical =>
  parseRow(CanonicalSchema, { key: r.key, ...ns(r), value: r.value, factId: r.fact_id, runId: r.run_id, confidence: r.confidence, verifiedTier: r.verified_tier, nextReviewAt: isoReq(r.next_review_at) });

export async function upsertCanonical(db: Db, c: Canonical): Promise<void> {
  await upsert(db, 'brain.canonical', { key: c.key, value: json(c.value), fact_id: c.factId, run_id: c.runId, confidence: c.confidence, verified_tier: c.verifiedTier, next_review_at: c.nextReviewAt, created_at: c.createdAt }, ['key']);
}

export async function getCanonical(db: Db, key: string): Promise<Canonical | null> {
  const r = await db.query('SELECT * FROM brain.canonical WHERE key = $1', [key]);
  return r.rows[0] ? canonicalFromRow(r.rows[0]) : null;
}

// ---------------------------------------------------------------- attribution
const attributionFromRow = (r: Row): Attribution =>
  parseRow(AttributionSchema, { runId: r.run_id, sourceKind: r.source_kind, sourceId: r.source_id, contributionPct: r.contribution_pct, acceptedClaims: r.accepted_claims, rejectedClaims: r.rejected_claims, reliabilityPct: r.reliability_pct });

/** Replace the whole attribution table of a run (it is recomputed as a unit). */
export async function replaceAttribution(db: Db, runId: string, rows: readonly Attribution[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query('DELETE FROM brain.attribution WHERE run_id = $1', [runId]);
    for (const a of rows) {
      await upsert(tx, 'brain.attribution', {
        run_id: a.runId, source_kind: a.sourceKind, source_id: a.sourceId, contribution_pct: a.contributionPct, accepted_claims: a.acceptedClaims,
        rejected_claims: json(a.rejectedClaims), reliability_pct: a.reliabilityPct,
      }, ['run_id', 'source_kind', 'source_id']);
    }
  });
}

export async function listAttribution(db: Db, runId: string): Promise<Attribution[]> {
  const r = await db.query('SELECT * FROM brain.attribution WHERE run_id = $1 ORDER BY contribution_pct DESC, source_id', [runId]);
  return r.rows.map(attributionFromRow);
}

// ---------------------------------------------------------------- verification
const requestFromRow = (r: Row): VerificationRequest =>
  parseRow(VerificationRequestSchema, { id: r.id, ...ns(r), factId: r.fact_id, requestedFromId: r.requested_from_id, reason: r.reason, status: r.status, tokenJti: r.token_jti, expiresAt: isoReq(r.expires_at) });

export async function saveVerificationRequest(db: Db, v: VerificationRequest): Promise<void> {
  // Issuance is insert-only: re-saving an old request must never reopen a spent token.
  if (v.status !== 'pending') throw new Error('New verification requests must be pending');
  await db.query(
    `INSERT INTO brain.verification_request (id, fact_id, requested_from_id, reason, status, token_jti, expires_at, created_at) VALUES ($1,$2,$3,$4,'pending',$5,$6,$7)`,
    [v.id, v.factId, v.requestedFromId, v.reason, v.tokenJti, v.expiresAt, v.createdAt],
  );
}

export async function getVerificationRequest(db: Db, id: string): Promise<VerificationRequest | null> {
  const r = await db.query('SELECT * FROM brain.verification_request WHERE id = $1', [id]);
  return r.rows[0] ? requestFromRow(r.rows[0]) : null;
}

export async function getVerificationRequestByJti(db: Db, jti: string): Promise<VerificationRequest | null> {
  const r = await db.query('SELECT * FROM brain.verification_request WHERE token_jti = $1', [jti]);
  return r.rows[0] ? requestFromRow(r.rows[0]) : null;
}

export async function listVerificationRequests(db: Db, opts: { personId?: string; factId?: string; status?: string } = {}): Promise<VerificationRequest[]> {
  const r = await db.query(
    `SELECT * FROM brain.verification_request WHERE ($1::text IS NULL OR requested_from_id = $1) AND ($2::text IS NULL OR fact_id = $2) AND ($3::text IS NULL OR status = $3) ORDER BY created_at, id`,
    [opts.personId ?? null, opts.factId ?? null, opts.status ?? null],
  );
  return r.rows.map(requestFromRow);
}

/** Single-use token: call with the same transaction used for the action and audit. No pre-read/check-then-act. */
export async function burnToken(db: Db, jti: string): Promise<boolean> {
  const r = await db.query(`UPDATE brain.verification_request SET used_at = now(), status = 'completed' WHERE token_jti = $1 AND used_at IS NULL AND status = 'pending' AND expires_at > now() RETURNING id`, [jti]);
  return r.rows.length === 1;
}

const eventFromRow = (r: Row): VerificationEvent =>
  parseRow(VerificationEventSchema, clean({ id: r.id, ...ns(r), factId: r.fact_id, claimId: opt(r.claim_id), verifierId: r.verifier_id, action: r.action, tier: r.tier, payload: r.payload, at: isoReq(r.at) }));

/** Append-only (a database trigger rejects UPDATE/DELETE). */
export async function appendVerificationEvent(db: Db, e: VerificationEvent): Promise<void> {
  await db.query(
    `INSERT INTO brain.verification_event (id, fact_id, claim_id, verifier_id, action, tier, payload, at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
    [e.id, e.factId, e.claimId ?? null, e.verifierId, e.action, e.tier, JSON.stringify(e.payload), e.at, e.createdAt],
  );
}

export async function listVerificationEvents(db: Db, factId: string): Promise<VerificationEvent[]> {
  const r = await db.query('SELECT * FROM brain.verification_event WHERE fact_id = $1 ORDER BY at, id', [factId]);
  return r.rows.map(eventFromRow);
}

// ---------------------------------------------------------------- org events
const orgEventFromRow = (r: Row): OrgEvent => parseRow(OrgEventSchema, { id: r.id, ...ns(r), type: r.type, scope: r.scope, domain: r.domain, effectiveAt: isoReq(r.effective_at) });

export async function saveOrgEvent(db: Db, e: OrgEvent): Promise<void> {
  await upsert(db, 'brain.org_event', { id: e.id, type: e.type, scope: json(e.scope), domain: e.domain, effective_at: e.effectiveAt, created_at: e.createdAt }, ['id']);
}

export async function listOrgEvents(db: Db): Promise<OrgEvent[]> {
  const r = await db.query('SELECT * FROM brain.org_event ORDER BY effective_at, id');
  return r.rows.map(orgEventFromRow);
}

// ---------------------------------------------------------------- pipeline stage log
const stageFromRow = (r: Row): StageLog =>
  parseRow(StageLogSchema, clean({ runId: r.run_id, stage: r.stage, status: r.status, startedAt: isoReq(r.started_at), finishedAt: isoReq(r.finished_at), stats: r.stats, error: opt(r.error) }));

/** Re-running a stage replaces its row. */
export async function saveStageLog(db: Db, l: StageLog): Promise<void> {
  await upsert(db, 'brain.run_stage', { run_id: l.runId, stage: l.stage, status: l.status, started_at: l.startedAt, finished_at: l.finishedAt, stats: json(l.stats), error: l.error }, ['run_id', 'stage']);
}

export async function listStageLogs(db: Db, runId: string): Promise<StageLog[]> {
  const r = await db.query('SELECT * FROM brain.run_stage WHERE run_id = $1 ORDER BY stage', [runId]);
  return r.rows.map(stageFromRow);
}

/** Facts are recomputed as a unit by stage 30; their gaps, conflicts and verification requests cascade with them. */
export async function deleteFactsByRun(db: Db, runId: string): Promise<void> {
  await db.query('DELETE FROM brain.fact WHERE run_id = $1', [runId]);
}

export async function deleteGapsByRun(db: Db, runId: string): Promise<void> {
  await db.query('DELETE FROM brain.gap WHERE run_id = $1', [runId]);
}

// ---------------------------------------------------------------- enrichment (stage 50)
/** Undo what stage 50 did to the run's gaps and drop its reference-only facts, so a rerun starts from the stage-40 state. */
export async function resetEnrichment(db: Db, runId: string): Promise<void> {
  await db.query(
    `UPDATE brain.gap g SET status = 'open', closed_by = NULL,
            fact_id = CASE WHEN EXISTS (SELECT 1 FROM brain.fact f WHERE f.id = g.fact_id AND f.reference_only) THEN NULL ELSE g.fact_id END
      WHERE g.run_id = $1`,
    [runId],
  );
  await db.query('DELETE FROM brain.fact WHERE run_id = $1 AND reference_only', [runId]);
  await db.query('DELETE FROM brain.claim_group WHERE run_id = $1', [runId]);
}

export async function updateGap(db: Db, id: string, patch: { status: 'open' | 'closed' | 'partially_closed'; closedBy?: string[]; factId?: string }): Promise<void> {
  await db.query('UPDATE brain.gap SET status = $2, closed_by = $3, fact_id = COALESCE($4, fact_id) WHERE id = $1', [id, patch.status, patch.closedBy ?? null, patch.factId ?? null]);
}

export interface ClaimGroupRow {
  runId: string;
  claimId: string;
  sourceKind: 'evidence' | 'reference';
  sourceId: string;
  groupId: string;
}

export async function saveClaimGroups(db: Db, rows: readonly ClaimGroupRow[]): Promise<void> {
  for (const r of rows) {
    await upsert(db, 'brain.claim_group', { run_id: r.runId, claim_id: r.claimId, source_kind: r.sourceKind, source_id: r.sourceId, group_id: r.groupId }, ['run_id', 'claim_id']);
  }
}

export async function listClaimGroups(db: Db, runId: string): Promise<ClaimGroupRow[]> {
  const r = await db.query('SELECT * FROM brain.claim_group WHERE run_id = $1 ORDER BY claim_id', [runId]);
  return r.rows.map((x: Row) => ({ runId: x.run_id, claimId: x.claim_id, sourceKind: x.source_kind, sourceId: x.source_id, groupId: x.group_id }));
}
