import { createHash } from 'node:crypto';
import { EdgeIdSchema, FactIdSchema, FactSchema, RunIdSchema, evidenceClaimId, type Edge, type Fact, type ReasonCode } from '../domain';
import { alignClaims, type Relation } from '../evidence';
import { relationTask, runTask } from '../llm';
import { brainRepo, edgeRepo, evidenceRepo } from '../store';
import { defineStage } from './stage';
import { AlignInputSchema, AlignOutputSchema } from './types';

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

const RELATION_EDGE_TYPES = ['MEMBER_OF', 'AGREES', 'CONTRADICTS', 'REFINES', 'SUPERSEDES', 'SCOPE_DISJOINT'] as const;

function relationEdge(runId: string, r: Relation): Edge {
  const base = {
    id: EdgeIdSchema.parse(`rel-${sha1(`${runId}|${r.type}|${r.from}|${r.to}`).slice(0, 16)}`),
    fromId: r.from,
    fromKind: 'evidence_claim' as const,
    toId: r.to,
    toKind: 'evidence_claim' as const,
    runId: RunIdSchema.parse(runId),
  };
  const how = { method: r.method, explanation: r.explanation };
  switch (r.type) {
    case 'AGREES':
      return { ...base, type: 'AGREES', props: { similarity: r.similarity ?? 1, ...how } };
    case 'CONTRADICTS':
      return { ...base, type: 'CONTRADICTS', props: { type: r.contradiction!.type, severity: r.contradiction!.severity, explanation: r.explanation, method: r.method } };
    case 'REFINES':
      return { ...base, type: 'REFINES', props: { addedQualifiers: r.addedQualifiers ?? [], ...how } };
    case 'SUPERSEDES':
      return { ...base, type: 'SUPERSEDES', props: { basis: r.basis ?? 'temporal', ...how } };
    case 'SCOPE_DISJOINT':
      return { ...base, type: 'SCOPE_DISJOINT', props: { differingScopeKeys: r.differingScopeKeys!, ...how } };
  }
}

/**
 * 30 Align: claims of the run → Facts (exact claimKey, then embedding ≥ 0.82, then the LLM for 0.70–0.82), every claim pair inside a
 * fact labelled AGREES / CONTRADICTS / REFINES / SUPERSEDES(candidate) / SCOPE_DISJOINT as edges, and claims outside the query scope
 * kept in the graph as SCOPE_MISMATCH. Facts are created unadjudicated (status UNKNOWN, confidence 0): stage 60 decides.
 */
export const align = defineStage({
  name: '30-align',
  input: AlignInputSchema,
  output: AlignOutputSchema,
  async run(ctx, input) {
    const run = await brainRepo.getRun(ctx.db, input.runId);
    if (!run) throw new Error(`unknown run ${input.runId}`);
    const nowIso = ctx.now().toISOString();
    const query = run.intent.scope;

    const claims = [];
    for (const snapshotId of run.evidenceSnapshotIds) claims.push(...(await evidenceRepo.listClaimsBySnapshot(ctx.db, snapshotId)));

    const result = await alignClaims({
      claims,
      subject: run.intent.subject,
      query,
      embed: (texts) => ctx.embedder.embed(texts),
      classify: (a, b) =>
        runTask(
          ctx.llm,
          relationTask(a.subject, a.attribute, { scope: a.qualifiers, valueRaw: a.value.raw, quote: a.quote }, { scope: b.qualifiers, valueRaw: b.value.raw, quote: b.quote }),
        ),
    });

    // recompute as a unit: a rerun replaces this run's facts (and what hangs on them) and the edges this stage wrote
    await brainRepo.deleteFactsByRun(ctx.db, input.runId);
    await edgeRepo.deleteEdgesByRun(ctx.db, input.runId, RELATION_EDGE_TYPES);

    const factIds: string[] = [];
    const inScopeFactIds: string[] = [];
    const memberEdges: Edge[] = [];
    for (const f of result.facts) {
      const id = FactIdSchema.parse(`fact-${sha1(`${input.runId}|${f.attribute}|${f.inScope}|${f.members.map((m) => m.id).join(',')}`).slice(0, 16)}`);
      const slot = f.inScope ? input.slotTemplate.slots.find((s) => s.attribute === f.attribute) : undefined;
      const reasons = f.inScope ? [] : [{ code: 'SCOPE_MISMATCH' as ReasonCode, message: `Applies to ${f.members[0]!.qualifiers.country ?? 'another scope'}, not to the scope of the question.` }];
      const fact: Fact = FactSchema.parse({
        id,
        namespace: 'brain',
        createdAt: nowIso,
        runId: input.runId,
        claimKey: f.key,
        subject: f.subject,
        attribute: f.attribute,
        scope: f.inScope ? query : { country: f.members[0]!.qualifiers.country ?? null, ...stripConditions(f.members[0]!.qualifiers) },
        ...(slot ? { slotId: slot.id } : {}),
        status: f.inScope ? 'UNKNOWN' : 'REJECTED',
        confidence: 0,
        reasons,
        needsVerification: false,
        impact: slot ? input.slotTemplate.impact : 'low',
      });
      await brainRepo.saveFact(ctx.db, fact);
      factIds.push(id);
      if (f.inScope) inScopeFactIds.push(id);
      for (const m of f.members) {
        const role = result.roles.get(m.id)!;
        memberEdges.push({
          id: EdgeIdSchema.parse(`mem-${sha1(`${input.runId}|${m.id}|${id}`).slice(0, 16)}`),
          type: 'MEMBER_OF',
          fromId: m.id,
          fromKind: 'evidence_claim',
          toId: id,
          toKind: 'fact',
          props: { role: role.role, ...(role.reason ? { reason: role.reason } : {}) },
          runId: input.runId,
        });
      }
    }
    await edgeRepo.insertEdges(ctx.db, memberEdges);
    await edgeRepo.insertEdges(ctx.db, result.relations.map((r) => relationEdge(input.runId, r)));

    const scopeMismatchClaimIds = [...result.roles].filter(([, r]) => r.reason === 'SCOPE_MISMATCH').map(([id]) => evidenceClaimId(id)).sort();
    return {
      output: { runId: input.runId, factIds, inScopeFactIds, scopeMismatchClaimIds, relations: result.stats.relations },
      stats: { ...result.stats, facts: factIds.length, inScopeFacts: inScopeFactIds.length, scopeMismatchClaims: scopeMismatchClaimIds.length },
    };
  },
});

function stripConditions(q: { conditions: string[]; [k: string]: unknown }) {
  const { conditions: _conditions, country: _country, ...rest } = q;
  return rest;
}
