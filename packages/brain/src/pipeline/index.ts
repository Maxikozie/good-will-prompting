// Pipeline stages (SPEC §5). Each is `(ctx, input) → output`, zod-typed and logged to the CaseRun (brain.run_stage).
export * from './context';
export * from './stage';
export * from './types';
export { intake } from './00-intake';
export { snapshot } from './10-snapshot';
export { extract } from './20-extract';

import { orgRepo } from '../store';
import type { PipelineCtx } from './context';
import { intake } from './00-intake';
import { snapshot } from './10-snapshot';
import { extract } from './20-extract';
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
