import type { z } from 'zod';
import { inputHash, type LLMCache } from './cache';
import { LLMValidationError } from './errors';
import type { CompleteOpts, LLMProvider, Message } from './types';

/** Pull a JSON value out of model text: plain JSON, ```json fences, or JSON surrounded by prose. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1]! : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.search(/[{[]/);
    const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new SyntaxError('no JSON found in the output');
  }
}

export function describeIssues(err: z.ZodError): string {
  return err.issues
    .slice(0, 8)
    .map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('; ');
}

export const MAX_RETRIES = 2;

/** Raw text completion. Real providers implement this and inherit validation, retries and caching. */
export abstract class JsonProvider implements LLMProvider {
  abstract readonly modelId: string;

  constructor(protected readonly cache?: LLMCache) {}

  /** Must use temperature 0. `schema` is offered so providers can request structured output. */
  protected abstract raw(messages: readonly Message[], schema: z.ZodType): Promise<string>;

  async completeJSON<T>(schema: z.ZodType<T>, messages: readonly Message[], opts: CompleteOpts<T>): Promise<T> {
    const key = { promptId: opts.promptId, promptVersion: opts.promptVersion, modelId: this.modelId, inputHash: inputHash(messages) };

    const cached = await this.cache?.get(key);
    if (cached !== undefined) {
      const ok = schema.safeParse(cached);
      if (ok.success && !opts.check?.(ok.data)) return ok.data; // a stale or corrupt cache entry is ignored, then recomputed
    }

    const convo: Message[] = [...messages];
    let lastOutput = '';
    let lastError = '';
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      lastOutput = await this.raw(convo, schema);
      try {
        const parsed = schema.safeParse(extractJson(lastOutput));
        if (parsed.success) {
          const problem = opts.check?.(parsed.data);
          if (!problem) {
            await this.cache?.set(key, parsed.data);
            return parsed.data;
          }
          lastError = problem;
        } else {
          lastError = describeIssues(parsed.error);
        }
      } catch (e) {
        lastError = e instanceof Error ? e.message : 'unparseable output';
      }
      convo.push(
        { role: 'assistant', content: lastOutput },
        { role: 'user', content: `Your previous answer was rejected: ${lastError}\nReturn ONLY the corrected JSON object, nothing else.` },
      );
    }
    throw new LLMValidationError(`"${opts.promptId}" ${opts.promptVersion}: output still invalid after ${MAX_RETRIES} retries (${lastError})`, opts.promptId, MAX_RETRIES + 1, lastOutput);
  }
}
