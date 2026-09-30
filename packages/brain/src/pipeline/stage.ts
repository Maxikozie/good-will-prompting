import type { z } from 'zod';
import { RunIdSchema, type RunId } from '../domain';
import { brainRepo } from '../store';
import type { PipelineCtx } from './context';

export type StageStats = Record<string, unknown>;

export interface StageDef<I extends z.ZodType, O extends z.ZodType> {
  /** e.g. "10-snapshot": also the key in brain.run_stage. */
  name: string;
  input: I;
  output: O;
  run: (ctx: PipelineCtx, input: z.infer<I>) => Promise<{ output: z.infer<O>; stats: StageStats }>;
}

/**
 * Wraps a stage as an async `(ctx, input) → output`: zod-validates the input and the output, and writes one row to
 * brain.run_stage (timing, counters, or the failure) for the CaseRun. The stage itself persists its domain data.
 */
export function defineStage<I extends z.ZodType, O extends z.ZodType>(def: StageDef<I, O>): (ctx: PipelineCtx, input: z.input<I>) => Promise<z.infer<O>> {
  return async (ctx, rawInput) => {
    const input = def.input.parse(rawInput) as z.infer<I>;
    const startedAt = ctx.now().toISOString();
    const inputRun = (input as { runId?: unknown }).runId;
    const known: RunId | undefined = typeof inputRun === 'string' ? RunIdSchema.parse(inputRun) : undefined;
    try {
      const { output, stats } = await def.run(ctx, input);
      const parsed = def.output.parse(output) as z.infer<O>;
      const runId = known ?? RunIdSchema.parse((parsed as { runId?: unknown }).runId);
      await brainRepo.saveStageLog(ctx.db, { runId, stage: def.name, status: 'completed', startedAt, finishedAt: ctx.now().toISOString(), stats });
      ctx.log(`${def.name} ${JSON.stringify(stats)}`);
      return parsed;
    } catch (e) {
      if (known) {
        const message = (e instanceof Error ? e.message : 'error').slice(0, 500);
        await brainRepo.saveStageLog(ctx.db, { runId: known, stage: def.name, status: 'failed', startedAt, finishedAt: ctx.now().toISOString(), stats: {}, error: message });
      }
      throw e;
    }
  };
}
