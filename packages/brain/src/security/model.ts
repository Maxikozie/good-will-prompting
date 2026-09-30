import { z } from 'zod';
import type { Embedder } from '../llm/types';
import { LIMITS } from './limits';
import { reserveModelCall } from './budget';
import { deadline } from './runtime';
export const MessagesSchema = z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string().max(LIMITS.modelInputChars) }).strict()).max(20)
  .refine((items) => items.reduce((n, m) => n + m.content.length, 0) <= LIMITS.modelInputChars, 'Model input too large');
export const EmbeddingInputSchema = z.array(z.string().max(LIMITS.documentChars)).max(LIMITS.embeddingTexts);
/** Chunk before providers; direct provider calls also validate and cap a single batch. */
export async function embedWithLimits(embedder: Embedder, texts: readonly string[]): Promise<number[][]> {
  const input = EmbeddingInputSchema.parse(texts);
  const out: number[][] = [];
  for (let i = 0; i < input.length; i += LIMITS.embeddingBatch) {
    const batch = input.slice(i, i + LIMITS.embeddingBatch);
    if (!embedder.budgetsManaged) await reserveModelCall(batch, 0);
    const vectors = await deadline(() => embedder.embed(batch), LIMITS.embeddingTimeoutMs);
    out.push(...z.array(z.array(z.number().finite()).length(embedder.dimensions)).length(batch.length).parse(vectors));
  }
  return out;
}
