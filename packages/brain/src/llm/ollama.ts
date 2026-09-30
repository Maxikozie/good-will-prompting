import { LIMITS } from '../security/limits';
import { parseEnv } from '../security/env';
import { EmbeddingInputSchema } from '../security/model';
import { reserveModelCall } from '../security/budget';
import { z } from 'zod';
import type { LLMCache } from './cache';
import { LLMError } from './errors';
import { parseBaseUrl, postJson, type FetchFn } from './http';
import { JsonProvider } from './json';
import type { Embedder, Message } from './types';

export interface OllamaOptions {
  host?: string;
  /** LLM model, e.g. "llama3.1:8b". Falls back to OLLAMA_MODEL. */
  model?: string;
  timeoutMs?: number;
  cache?: LLMCache;
  fetch?: FetchFn;
}

export const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
export const DEFAULT_OLLAMA_MODEL = 'llama3.1:8b';
export const DEFAULT_EMBED_MODEL = 'nomic-embed-text';

/** Self-hosted default provider (SPEC: Ollama). Temperature 0, fixed seed, structured output via the zod JSON schema. */
export class OllamaProvider extends JsonProvider {
  readonly modelId: string;
  private readonly host: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;

  constructor(opts: OllamaOptions = {}) {
    super(opts.cache);
    const env = parseEnv();
    this.host = parseBaseUrl(opts.host ?? env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST, 'OLLAMA_HOST');
    this.modelId = `ollama:${opts.model ?? env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL}`;
    this.timeoutMs = z.number().int().positive().max(LIMITS.llmTimeoutMs).parse(opts.timeoutMs ?? env.BRAIN_LLM_TIMEOUT_MS ?? LIMITS.llmTimeoutMs);
    this.fetchFn = opts.fetch ?? fetch;
  }

  protected async raw(messages: readonly Message[], schema: z.ZodType): Promise<string> {
    let format: unknown = 'json';
    try {
      format = z.toJSONSchema(schema);
    } catch {
      /* schema not expressible as JSON schema: plain JSON mode */
    }
    const data = OllamaChatSchema.parse(await postJson(
      this.fetchFn,
      `${this.host}/api/chat`,
      { model: this.modelId.slice('ollama:'.length), messages, stream: false, format, options: { temperature: 0, seed: 0, num_predict: LIMITS.outputTokens } },
      { timeoutMs: this.timeoutMs, what: 'Ollama chat' },
    ));
    const content = data.message?.content;
    if (typeof content !== 'string') throw new LLMError('Ollama chat: response had no message content');
    return content;
  }
}

export interface OllamaEmbedderOptions {
  host?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: FetchFn;
}

/** nomic-embed-text via Ollama (768 dimensions, matches the vector(768) columns). */
export class OllamaEmbedder implements Embedder {
  readonly budgetsManaged = true as const;
  readonly modelId: string;
  readonly dimensions = 768;
  private readonly host: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;

  constructor(opts: OllamaEmbedderOptions = {}) {
    const env = parseEnv();
    this.host = parseBaseUrl(opts.host ?? env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST, 'OLLAMA_HOST');
    this.modelId = `ollama:${opts.model ?? env.OLLAMA_EMBED_MODEL ?? DEFAULT_EMBED_MODEL}`;
    this.timeoutMs = z.number().int().positive().max(LIMITS.llmTimeoutMs).parse(opts.timeoutMs ?? env.BRAIN_LLM_TIMEOUT_MS ?? LIMITS.llmTimeoutMs);
    this.fetchFn = opts.fetch ?? fetch;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    EmbeddingInputSchema.max(LIMITS.embeddingBatch).parse(texts);
    if (texts.length === 0) return [];
    await reserveModelCall(texts, 0);
    const data = OllamaEmbedSchema.parse(await postJson(
      this.fetchFn,
      `${this.host}/api/embed`,
      { model: this.modelId.slice('ollama:'.length), input: texts },
      { timeoutMs: Math.min(this.timeoutMs, LIMITS.embeddingTimeoutMs), what: 'Ollama embed' },
    ));
    const out = data.embeddings;
    if (!Array.isArray(out) || out.length !== texts.length) throw new LLMError('Ollama embed: unexpected number of embeddings');
    for (const v of out) if (!Array.isArray(v) || v.length !== this.dimensions) throw new LLMError(`Ollama embed: expected ${this.dimensions} dimensions`);
    return out;
  }
}

const timing = { model: z.string().optional(), created_at: z.string().optional(), total_duration: z.number().optional(), load_duration: z.number().optional(), prompt_eval_count: z.number().optional(), prompt_eval_duration: z.number().optional(), eval_count: z.number().optional(), eval_duration: z.number().optional() };
const OllamaChatSchema = z.object({ ...timing, done: z.boolean().optional(), done_reason: z.string().optional(), message: z.object({ role: z.string().optional(), content: z.string().max(LIMITS.modelResponseBytes), thinking: z.string().max(LIMITS.modelResponseBytes).optional() }).strict() }).strict();
const OllamaEmbedSchema = z.object({ ...timing, embeddings: z.array(z.array(z.number().finite()).length(768)).max(LIMITS.embeddingBatch) }).strict();
