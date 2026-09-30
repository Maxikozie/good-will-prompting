import { z } from 'zod';

/** One reviewed set of resource ceilings. Environment options may LOWER timeouts, never disable limits. */
export const LimitsSchema = z.object({
  documentsPerCase: z.number().int().positive(), documentChars: z.number().int().positive(),
  questionChars: z.number().int().positive(), wikiPagesPerIngest: z.number().int().positive(),
  jsonBodyBytes: z.number().int().positive(), configBytes: z.number().int().positive(), jsonDepth: z.number().int().positive(),
  claimChars: z.number().int().positive(), audioBodyBytes: z.number().int().positive(), speechTimeoutMs: z.number().int().positive(),
  normalizerChars: z.number().int().positive(), modelInputChars: z.number().int().positive(), modelResponseBytes: z.number().int().positive(),
  outputTokens: z.number().int().positive(), llmRetries: z.number().int().nonnegative(),
  modelCallsPerRun: z.number().int().positive(), modelTokensPerRun: z.number().int().positive(),
  modelCallsPerPrincipalHour: z.number().int().positive(), modelTokensPerPrincipalHour: z.number().int().positive(),
  embeddingBatch: z.number().int().positive(), embeddingTexts: z.number().int().positive(),
  toolBurst: z.number().int().positive(), toolRefillPerSecond: z.number().positive(), bucketEntries: z.number().int().positive(),
  llmTimeoutMs: z.number().int().positive(), embeddingTimeoutMs: z.number().int().positive(),
  dbTimeoutMs: z.number().int().positive(), transactionTimeoutMs: z.number().int().positive(),
}).strict();
export const LIMITS = Object.freeze(LimitsSchema.parse({
  documentsPerCase: 10, documentChars: 200_000, questionChars: 500, wikiPagesPerIngest: 10,
  jsonBodyBytes: 2 * 1024 * 1024, configBytes: 1024 * 1024, jsonDepth: 32,
  claimChars: 1000, audioBodyBytes: 10 * 1024 * 1024, speechTimeoutMs: 20_000,
  normalizerChars: 500, modelInputChars: 200_000, modelResponseBytes: 256 * 1024,
  outputTokens: 4096, llmRetries: 2,
  modelCallsPerRun: 200, modelTokensPerRun: 2_000_000,
  modelCallsPerPrincipalHour: 1000, modelTokensPerPrincipalHour: 10_000_000,
  embeddingBatch: 32, embeddingTexts: 1024,
  toolBurst: 60, toolRefillPerSecond: 1, bucketEntries: 10_000,
  llmTimeoutMs: 120_000, embeddingTimeoutMs: 60_000, dbTimeoutMs: 15_000, transactionTimeoutMs: 60_000,
}));
