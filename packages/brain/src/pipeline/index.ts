// Pipeline stages (SPEC §5). Each is `(ctx, input) → output`, zod-typed and logged to the CaseRun (brain.run_stage).
export * from './context';
export * from './stage';
export * from './types';
export { intake } from './00-intake';
export { snapshot } from './10-snapshot';
export { extract } from './20-extract';
export { align } from './30-align';
export { gaps } from './40-gaps';
export { enrich } from './50-enrich';
export { adjudicate } from './60-adjudicate';
export * from './bridge';

import { orgRepo } from '../store';
import type { PipelineCtx } from './context';
import { intake } from './00-intake';
import { snapshot } from './10-snapshot';
import { extract } from './20-extract';
import { align } from './30-align';
import { gaps } from './40-gaps';
import { enrich } from './50-enrich';
import { adjudicate } from './60-adjudicate';
import type { AgentDocument } from '../evidence';
import type { PartialScope, RunId } from '../domain';

export interface EvidencePhaseInput {
  question: string;
  principalId: string;
  /** The caller's principals (user + groups) for the ACL filter; defaults to the org directory entry of `principalId`. */
  principals?: string[];
  scopeHint?: PartialScope;
  documents: AgentDocument[];
  runId?: RunId;
}

/** Stages 00 → 10 → 20 in one call. */
export async function runEvidencePhase(ctx: PipelineCtx, input: EvidencePhaseInput) {
  const principals = input.principals ?? (await orgRepo.principalSetFor(ctx.db, input.principalId));
  const i = await intake(ctx, { question: input.question, principalId: input.principalId, scopeHint: input.scopeHint, runId: input.runId as RunId | undefined });
  const s = await snapshot(ctx, { runId: i.runId, principals, documents: input.documents });
  const x = await extract(ctx, { runId: i.runId, snapshotIds: s.documents.map((d) => d.snapshotId), slotTemplate: i.slotTemplate });
  return { intake: i, snapshot: s, extract: x };
}

/** Stages 00 → 10 → 20 → 30 → 40: everything up to gap detection. */
export async function runThroughGaps(ctx: PipelineCtx, input: EvidencePhaseInput) {
  const phase = await runEvidencePhase(ctx, input);
  const slotTemplate = phase.intake.slotTemplate;
  const a = await align(ctx, { runId: phase.intake.runId, slotTemplate });
  const g = await gaps(ctx, { runId: phase.intake.runId, slotTemplate });
  return { ...phase, align: a, gaps: g };
}

/** Stages 00 → 50: evidence, alignment, gaps, then gap-targeted enrichment from the wiki. */
export async function runThroughEnrich(ctx: PipelineCtx, input: EvidencePhaseInput) {
  const through = await runThroughGaps(ctx, input);
  const principals = input.principals ?? (await orgRepo.principalSetFor(ctx.db, input.principalId));
  const e = await enrich(ctx, { runId: through.intake.runId, slotTemplate: through.intake.slotTemplate, principals });
  return { ...through, enrich: e };
}

/** Stages 00 → 60: everything up to the deterministic verdict on every fact. */
export async function runThroughAdjudicate(ctx: PipelineCtx, input: EvidencePhaseInput) {
  const through = await runThroughEnrich(ctx, input);
  const a = await adjudicate(ctx, { runId: through.intake.runId, slotTemplate: through.intake.slotTemplate });
  return { ...through, adjudicate: a };
}
