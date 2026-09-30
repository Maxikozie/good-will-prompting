import { createHash } from 'node:crypto';
import {
  ClaimIdSchema,
  ConflictIdSchema,
  ConflictSchema,
  EdgeIdSchema,
  FactIdSchema,
  FactSchema,
  SourceIdSchema,
  type ClaimValue,
  type Edge,
  type EvidenceClaim,
  type EvidenceDocument,
  type Fact,
  type OrgEvent,
  type ReferenceFact,
  type WikiPage,
} from '../domain';
import { adjudicateFact, loadRules, type Cand, type FactInput } from '../rules';
import { evidenceAuthority, eventInvalidates, loadScoringConfig } from '../scoring';
import { brainRepo, edgeRepo, evidenceRepo, orgRepo, referenceRepo } from '../store';
import { defineStage } from './stage';
import { AdjudicateInputSchema, AdjudicateOutputSchema } from './types';

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

/**
 * 60 Adjudicate: for every fact, run the ladder (SPEC §7) with the claim scores (SPEC §8) and assign the status (SPEC §6).
 * Deterministic: rules and arithmetic only, never a model or an embedder (neither is read from the pipeline context here). Persists the fact's
 * status, winner, confidence and reasons, its conflicts (open/resolved, severity), every claim's score + breakdown + role, the confirmed
 * SUPERSEDES edges, the final MEMBER_OF roles, and which rules fired.
 */
export const adjudicate = defineStage({
  name: '60-adjudicate',
  input: AdjudicateInputSchema,
  output: AdjudicateOutputSchema,
  async run(ctx, input) {
    const run = await brainRepo.getRun(ctx.db, input.runId);
    if (!run) throw new Error(`unknown run ${input.runId}`);
    const rules = loadRules();
    const scoring = loadScoringConfig();
    const now = ctx.now();
    const nowIso = now.toISOString();
    const template = input.slotTemplate;
    const halfLifeDays = template.halfLifeDays ?? scoring.halfLifeDays;
    const subject = run.intent.subject;

    const facts = await brainRepo.listFacts(ctx.db, input.runId);
    const edges = await edgeRepo.edgesByRun(ctx.db, input.runId);
    const groups = new Map((await brainRepo.listClaimGroups(ctx.db, input.runId)).map((g) => [g.claimId, g.groupId]));
    const events: OrgEvent[] = await brainRepo.listOrgEvents(ctx.db);

    // ---- sources
    const docs = new Map<string, EvidenceDocument>();
    const claims = new Map<string, EvidenceClaim>();
    const passageClaims = new Map<string, EvidenceClaim[]>();
    for (const snapshotId of run.evidenceSnapshotIds) {
      const snap = await evidenceRepo.getSnapshot(ctx.db, snapshotId);
      const doc = snap && (await evidenceRepo.getDocument(ctx.db, snap.documentId));
      if (!snap || !doc) continue;
      docs.set(doc.id, doc);
      for (const c of await evidenceRepo.listClaimsBySnapshot(ctx.db, snap.id)) {
        claims.set(c.id, c);
        (passageClaims.get(c.passageId) ?? passageClaims.set(c.passageId, []).get(c.passageId)!).push(c);
      }
    }
    const refFacts = new Map<string, ReferenceFact>();
    const pages = new Map<string, WikiPage>();
    const refIds = new Set(edges.filter((e) => e.fromKind === 'reference_fact').map((e) => e.fromId));
    for (const id of refIds) {
      const f = await referenceRepo.getFact(ctx.db, id);
      if (!f) continue;
      refFacts.set(f.id, f);
      if (!pages.has(f.sourceId)) {
        const [p] = await referenceRepo.getPagesByIds(ctx.db, [f.sourceId]);
        if (p) pages.set(p.id, p);
      }
    }
    const personCache = new Map<string, { active: boolean } | null>();
    const person = async (id: string | undefined) => {
      if (!id) return null;
      if (!personCache.has(id)) personCache.set(id, await orgRepo.getPerson(ctx.db, id));
      return personCache.get(id)!;
    };
    const invalidated = (subj: string, scope: Cand['scope'], lastVerifiedAt: string | undefined) => events.some((e) => eventInvalidates(e, { subject: subj, scope, lastVerifiedAt }, now));

    const evidenceCand = async (c: EvidenceClaim): Promise<Cand> => {
      const d = docs.get(c.sourceId)!;
      const owner = await person(d.ownerId);
      return {
        id: c.id, origin: 'evidence', sourceId: d.id, group: groups.get(c.id) ?? d.id, value: c.value, polarity: c.polarity, conditions: c.qualifiers.conditions, modality: c.modality, scope: c.qualifiers,
        scopeUndeclared: c.qualifiers.country === null || c.qualifiers.country === undefined, tier: d.lastVerifiedAt ? d.verifiedTier : undefined, lastVerifiedAt: d.lastVerifiedAt, lastEditedAt: d.lastEditedAt,
        validUntil: d.validUntil, effectiveFrom: c.temporal.effectiveFrom, authority: evidenceAuthority(d, !!owner?.active, scoring), owner, ownerId: d.ownerId, driftRatio: null,
        usage: { resolved: 0, reopened: 0 }, invalidatedByEvent: invalidated(c.subject, c.qualifiers, d.lastVerifiedAt),
      };
    };
    const referenceCand = async (f: ReferenceFact): Promise<Cand> => {
      const p = pages.get(f.sourceId)!;
      const owner = await person(p.ownerId);
      const officialOwned = p.official && !!owner;
      return {
        id: f.id, origin: 'reference', sourceId: p.id, group: groups.get(f.id) ?? p.id, value: f.value, polarity: f.polarity, conditions: f.qualifiers.conditions, modality: f.modality, scope: f.qualifiers,
        scopeUndeclared: f.qualifiers.country === null || f.qualifiers.country === undefined, tier: officialOwned && p.lastVerifiedAt ? scoring.reference.verifiedTier : undefined, lastVerifiedAt: p.lastVerifiedAt,
        lastEditedAt: p.lastEditedAt, effectiveFrom: f.temporal.effectiveFrom, authority: officialOwned ? scoring.authority.reference.official_owned : scoring.authority.reference.default, owner, ownerId: p.ownerId,
        driftRatio: null, usage: { resolved: 0, reopened: 0 }, invalidatedByEvent: invalidated(f.subject, f.qualifiers, p.lastVerifiedAt),
      };
    };

    // ---- relations the ladder needs
    const agreeing = edges.filter((e) => (e.type === 'AGREES' || e.type === 'REFINES') && e.fromKind === 'evidence_claim').map((e) => [e.fromId, e.toId] as [string, string]);
    const dupPassages = edges.filter((e) => e.type === 'DUPLICATE_OF');
    const duplicateClaims = (ids: Set<string>): [string, string][] => {
      const out: [string, string][] = [];
      for (const e of dupPassages) {
        for (const a of passageClaims.get(e.fromId) ?? []) for (const b of passageClaims.get(e.toId) ?? []) if (ids.has(a.id) && ids.has(b.id) && a.attribute === b.attribute) out.push([a.id, b.id]);
      }
      return out;
    };
    const factOfClaim = new Map<string, string>();
    for (const e of edges) if (e.type === 'MEMBER_OF' && e.fromKind === 'evidence_claim') factOfClaim.set(e.fromId, e.toId);
    const rejectedScopeClaims = new Set(edges.filter((e) => e.type === 'MEMBER_OF' && e.props.reason === 'SCOPE_MISMATCH').map((e) => e.fromId));

    // ---- recompute as a unit
    await brainRepo.deleteConflictsByRun(ctx.db, input.runId);
    await brainRepo.deleteAdjudicationByRun(ctx.db, input.runId);
    await edgeRepo.deleteEdgesByRun(ctx.db, input.runId, ['MEMBER_OF']);

    const statuses: Record<string, string> = {};
    const openConflictIds: string[] = [];
    const resolvedConflictIds: string[] = [];
    const needing: string[] = [];
    const memberEdges: Edge[] = [];
    const ruleFired: Record<string, number> = {};
    const memberEdge = (claimId: string, origin: 'evidence' | 'reference', factId: string, role: 'winner' | 'support' | 'rejected' | 'context', reason?: Parameters<typeof brainRepo.saveClaimScore>[1]['code']) =>
      memberEdges.push({
        id: EdgeIdSchema.parse(`mem-${sha1(`${input.runId}|${claimId}|${factId}`).slice(0, 16)}`), type: 'MEMBER_OF', fromId: claimId, fromKind: origin === 'evidence' ? 'evidence_claim' : 'reference_fact', toId: factId, toKind: 'fact',
        props: { role, ...(reason ? { reason } : {}) }, runId: input.runId,
      });
    const zeroBreakdown = { V: 0, A: 0, O: 0, C: 0, I: 0, U: 0, conflictPenalty: 0, gates: ['scope_mismatch'], total: 0 };

    for (const fact of facts) {
      const members = edges.filter((e) => e.type === 'MEMBER_OF' && e.toId === fact.id);

      // out-of-scope facts: nothing to adjudicate, the claims are excluded (score 0)
      if (fact.status === 'REJECTED') {
        for (const m of members) {
          const c = claims.get(m.fromId);
          if (!c) continue;
          await brainRepo.saveClaimScore(ctx.db, { runId: input.runId, claimId: ClaimIdSchema.parse(c.id), sourceKind: 'evidence', sourceId: c.sourceId, factId: fact.id, role: 'rejected', code: 'SCOPE_MISMATCH', score: 0, breakdown: zeroBreakdown, reasons: [{ code: 'SCOPE_MISMATCH', message: 'Applies to another scope than the question: excluded.' }] });
          memberEdge(c.id, 'evidence', fact.id, 'rejected', 'SCOPE_MISMATCH');
        }
        statuses[fact.id] = 'REJECTED';
        continue;
      }

      // candidates: the fact's rule claims (evidence), plus the reference facts that agree or disagree (independent, rule); the rest is context
      const candidates: Cand[] = [];
      const context: { cand: Cand; code: 'NOT_A_RULE' | 'DERIVED_COPY' }[] = [];
      for (const m of members) {
        if (m.type !== 'MEMBER_OF') continue;
        if (m.fromKind === 'evidence_claim') {
          const c = claims.get(m.fromId);
          if (!c) continue;
          const cand = await evidenceCand(c);
          if (m.props.role === 'context' || c.modality !== 'rule') context.push({ cand, code: 'NOT_A_RULE' });
          else candidates.push(cand);
        } else if (m.fromKind === 'reference_fact' && fact.referenceOnly) {
          const f = refFacts.get(m.fromId);
          if (f) candidates.push(await referenceCand(f)); // a referenceOnly fact's members are its candidates; for other facts the bridge edges below decide
        }
      }
      const linkedRefs = new Map<string, 'agree' | 'contradict' | 'context'>();
      const factClaimIds = new Set(candidates.map((c) => c.id).concat(context.map((x) => x.cand.id)));
      for (const e of edges) {
        if (e.fromKind !== 'reference_fact' || fact.referenceOnly) continue;
        if (e.type === 'CORROBORATES' && e.toId === fact.id) linkedRefs.set(e.fromId, 'agree');
        else if (e.type === 'CONTRADICTS' && factClaimIds.has(e.toId) && linkedRefs.get(e.fromId) !== 'agree') linkedRefs.set(e.fromId, 'contradict');
        else if (e.type === 'ADDS_CONTEXT' && e.toId === fact.id && !linkedRefs.has(e.fromId)) linkedRefs.set(e.fromId, 'context');
      }
      for (const [id] of [...linkedRefs].sort()) {
        const f = refFacts.get(id);
        if (!f || f.attribute !== fact.attribute) continue;
        const cand = await referenceCand(f);
        if (linkedRefs.get(id) === 'context') context.push({ cand, code: f.modality === 'rule' ? 'DERIVED_COPY' : 'NOT_A_RULE' });
        else if (f.modality === 'rule') candidates.push(cand);
        else context.push({ cand, code: 'NOT_A_RULE' });
      }

      const ids = new Set(candidates.map((c) => c.id));
      const scopeMismatched = new Set<string>();
      for (const e of edges) {
        if (e.type !== 'SCOPE_DISJOINT') continue;
        if (factClaimIds.has(e.fromId) && rejectedScopeClaims.has(e.toId)) scopeMismatched.add(e.toId);
        if (factClaimIds.has(e.toId) && rejectedScopeClaims.has(e.fromId)) scopeMismatched.add(e.fromId);
      }

      const result = adjudicateFact(
        { factId: fact.id, impact: fact.impact, halfLifeDays, query: run.intent.scope, candidates, context, scopeMismatched: scopeMismatched.size, duplicates: duplicateClaims(ids), agreeing } satisfies FactInput,
        { rules, scoring, now },
      );
      for (const f of result.fired) if (f.applies) ruleFired[f.id] = (ruleFired[f.id] ?? 0) + 1;

      // ---- persist the fact
      const updated: Fact = FactSchema.parse({
        ...fact,
        status: result.status,
        confidence: result.confidence,
        needsVerification: result.needsVerification,
        reasons: result.reasons,
        ...(result.winnerId ? { winnerClaimId: ClaimIdSchema.parse(result.winnerId), winningValue: result.winningValue as ClaimValue } : { winnerClaimId: undefined, winningValue: undefined }),
      });
      await brainRepo.saveFact(ctx.db, updated);
      statuses[fact.id] = result.status;
      if (result.needsVerification) needing.push(fact.id);

      for (const c of result.conflicts) {
        const id = ConflictIdSchema.parse(`conf-${sha1(`${input.runId}|${fact.id}|${c.resolution}|${[...c.claimIds].sort().join(',')}`).slice(0, 16)}`);
        await brainRepo.saveConflict(
          ctx.db,
          ConflictSchema.parse({ id, namespace: 'brain', createdAt: nowIso, runId: input.runId, factId: fact.id, type: c.type, severity: c.severity, claimIds: c.claimIds, resolution: c.resolution, ...(c.resolvedBy ? { resolvedBy: c.resolvedBy } : {}), status: c.status }),
        );
        (c.status === 'open' ? openConflictIds : resolvedConflictIds).push(id);
      }
      for (const cl of result.claims) {
        await brainRepo.saveClaimScore(ctx.db, {
          runId: input.runId, claimId: ClaimIdSchema.parse(cl.id), sourceKind: cl.origin, sourceId: SourceIdSchema.parse(cl.origin === 'evidence' ? claims.get(cl.id)?.sourceId : refFacts.get(cl.id)?.sourceId), factId: fact.id,
          role: cl.role, ...(cl.code ? { code: cl.code } : {}), score: cl.score, breakdown: cl.breakdown, reasons: cl.reasons,
        });
        memberEdge(cl.id, cl.origin, fact.id, cl.role, cl.code);
      }
      for (const s of result.supersedes) {
        const kind = (id: string) => (claims.has(id) ? ('evidence_claim' as const) : ('reference_fact' as const));
        memberEdges.push({
          id: EdgeIdSchema.parse(`rel-${sha1(`${input.runId}|SUPERSEDES|${s.newer}|${s.older}`).slice(0, 16)}`), type: 'SUPERSEDES', fromId: s.newer, fromKind: kind(s.newer), toId: s.older, toKind: kind(s.older),
          props: { basis: 'temporal', method: 'rule', explanation: 'confirmed by rule 4_temporal_supersession' }, runId: input.runId,
        });
      }
      await brainRepo.saveFactDecision(ctx.db, {
        runId: input.runId, factId: FactIdSchema.parse(fact.id), rulesVersion: rules.version, fired: result.fired, decidedBy: result.decidedBy, ...(result.cap ? { cap: result.cap } : {}),
        correctionFor: result.correctionFor.map((x) => ClaimIdSchema.parse(x)), escalateTo: result.escalateTo.map((x) => ClaimIdSchema.parse(x)), scopeFit: result.scopeFit, independentCorroborations: result.independentCorroborations,
      });
    }
    await edgeRepo.insertEdges(ctx.db, memberEdges);

    const byStatus: Record<string, number> = {};
    for (const s of Object.values(statuses)) byStatus[s] = (byStatus[s] ?? 0) + 1;
    return {
      output: { runId: input.runId, statuses, openConflictIds, resolvedConflictIds, factsNeedingVerification: needing },
      stats: { facts: facts.length, byStatus, rulesFired: ruleFired, openConflicts: openConflictIds.length, resolvedConflicts: resolvedConflictIds.length, factsNeedingVerification: needing.length, rulesVersion: rules.version, subject, llmCalls: 0 },
    };
  },
});
