import type { z } from 'zod';

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompleteOpts<T = unknown> {
  /** Which prompt produced these messages, e.g. "extract-evidence". Part of the cache/fixture key. */
  promptId: string;
  /** Version of that prompt file, e.g. "v1". */
  promptVersion: string;
  /** Extra semantic validation after the schema passes. Return an error sentence to trigger a retry with that feedback. */
  check?: (value: T) => string | null;
}

/**
 * The only way the Brain talks to a model (CLAUDE invariant 3: the LLM extracts and classifies, rules decide).
 * Always temperature 0, output validated by a zod schema, 2 retries with the validation error fed back, cached by content hash.
 */
export interface LLMProvider {
  /** Model id recorded in CaseRun.modelIds and used in the cache key. */
  readonly modelId: string;
  completeJSON<T>(schema: z.ZodType<T>, messages: readonly Message[], opts: CompleteOpts<T>): Promise<T>;
}

export interface Embedder {
  readonly modelId: string;
  readonly dimensions: number;
  /** One vector per input text, same order. */
  embed(texts: readonly string[]): Promise<number[][]>;
}
