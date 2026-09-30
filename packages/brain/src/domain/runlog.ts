import { z } from 'zod';
import { IsoStringSchema } from './enums';
import { RunIdSchema } from './ids';

/** One row per pipeline stage of a CaseRun: what ran, how long, and its counters (drops, ACL denials, duplicates…). */
export const StageLogSchema = z.object({
  runId: RunIdSchema,
  stage: z.string().min(1).max(60), // "00-intake", "10-snapshot", "20-extract", …
  status: z.enum(['completed', 'failed']),
  startedAt: IsoStringSchema,
  finishedAt: IsoStringSchema,
  stats: z.record(z.string(), z.unknown()),
  error: z.string().max(500).optional(),
}).strict();
export type StageLog = z.infer<typeof StageLogSchema>;
