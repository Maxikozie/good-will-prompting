import { createHash } from 'node:crypto';
import { GapIdSchema, GapSchema, type EvidenceClaim, type EvidenceDocument } from '../domain';
import { independenceGroups } from '../evidence';
import { detectGaps, type GapClaim, type GapFact } from '../rules/gaps';
import { evidenceAuthority, knownComponentScore, loadScoringConfig, ownershipWeight, verificationWeight } from '../scoring';
import { brainRepo, edgeRepo, evidenceRepo, orgRepo } from '../store';
import { defineStage } from './stage';
import { GapsInputSchema, GapsOutputSchema } from './types';

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

/**
 * 40 Gaps: compare the run's facts with the slot template and record MISSING_SLOT, UNRESOLVED_CONFLICT, WEAK_SUPPORT, MISSING_SCOPE
 * and MISSING_TEMPORAL gaps (linked to slot and/or fact). Claim strength here is the score from the components known before
 * adjudication (verification, authority, ownership); the final ClaimScore comes in stage 60.
 */
export const gaps = defineStage({
  name: '40-gaps',
  input: GapsInputSchema,
  output: GapsOutputSchema,
  async run(ctx, input) {
    const run = await brainRepo.getRun(ctx.db, input.runId);
    if (!run) throw new Error(`unknown run ${input.runId}`);
    const cfg = loadScoringConfig();
    const now = ctx.now();
    const nowIso = now.toISOString();

    const facts = await brainRepo.listFacts(ctx.db, input.runId);
    const runEdges = await edgeRepo.edgesByRun(ctx.db, input.runId);

    // documents, owners and independence groups (copies / duplicate passages are not independent evidence)
    const docs = new Map<string, EvidenceDocument>();
    const passageDoc = new Map<string, string>();
    for (const snapshotId of run.evidenceSnapshotIds) {
      const snap = await evidenceRepo.getSnapshot(ctx.db, snapshotId);
      if (!snap) continue;
      const doc = await evidenceRepo.getDocument(ctx.db, snap.documentId);
      if (doc) docs.set(doc.id, doc);
      for (const p of await evidenceRepo.listPassages(ctx.db, snap.id)) passageDoc.set(p.id, snap.documentId);
    }
    const dupPairs = runEdges.filter((e) => e.type === 'DUPLICATE_OF').map((e) => [e.fromId, e.toId] as const);
    const groupOf = independenceGroups([...docs.keys()], dupPairs, (p) => passageDoc.get(p));
    const owners = new Map<string, { active: boolean } | null>();
    for (const d of docs.values()) owners.set(d.id, d.ownerId ? await orgRepo.getPerson(ctx.db, d.ownerId) : null);

    const claimCache = new Map<string, EvidenceClaim>();
    const loadClaim = async (id: string) => {
      if (!claimCache.has(id)) {
        const c = await evidenceRepo.getClaim(ctx.db, id);
        if (c) claimCache.set(id, c);
      }
      return claimCache.get(id);
    };

    const gapFacts: GapFact[] = [];
    for (const fact of facts) {
      const members = (await edgeRepo.edgesTo(ctx.db, fact.id, 'MEMBER_OF')).filter((e) => e.type === 'MEMBER_OF');
      const claims: GapClaim[] = [];
      for (const e of members) {
        if (e.type !== 'MEMBER_OF' || e.props.role === 'rejected') continue;
        const c = await loadClaim(e.fromId);
        const doc = c && docs.get(c.sourceId);
        if (!c || !doc) continue;
        const owner = owners.get(doc.id) ?? null;
        const authority = evidenceAuthority(doc, !!owner?.active, cfg);
        const score = knownComponentScore({ V: verificationWeight(doc, now, input.slotTemplate.halfLifeDays, cfg), A: authority, O: ownershipWeight(owner, cfg) }, cfg);
        claims.push({ id: c.id, modality: c.modality, scope: c.qualifiers, effectiveFrom: c.temporal.effectiveFrom, score, authority, group: groupOf.get(doc.id) ?? doc.id });
      }
      const ids = new Set(claims.map((c) => c.id));
      gapFacts.push({
        factId: fact.id,
        attribute: fact.attribute,
        slotId: fact.slotId,
        inScope: fact.status !== 'REJECTED',
        claims,
        hasContradiction: runEdges.some((e) => e.type === 'CONTRADICTS' && e.props.severity === 'high' && ids.has(e.fromId) && ids.has(e.toId)),
      });
    }

    const drafts = detectGaps(input.slotTemplate, run.intent.scope, gapFacts, cfg.weakSupport);
    await brainRepo.deleteGapsByRun(ctx.db, input.runId);
    const gapIds: string[] = [];
    const gapsByType: Record<string, number> = {};
    for (const d of drafts) {
      const id = GapIdSchema.parse(`gap-${sha1(`${input.runId}|${d.type}|${d.slotId ?? ''}|${d.factId ?? ''}`).slice(0, 16)}`);
      await brainRepo.saveGap(ctx.db, GapSchema.parse({ id, namespace: 'brain', createdAt: nowIso, runId: input.runId, type: d.type, ...(d.slotId ? { slotId: d.slotId } : {}), ...(d.factId ? { factId: d.factId } : {}), description: d.description, status: 'open' }));
      gapIds.push(id);
      gapsByType[d.type] = (gapsByType[d.type] ?? 0) + 1;
    }
    return { output: { runId: input.runId, gapIds, gapsByType }, stats: { gaps: gapIds.length, ...gapsByType, facts: facts.length } };
  },
});
