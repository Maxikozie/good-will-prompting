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
    this.host = parseBaseUrl(opts.host ?? process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST, 'OLLAMA_HOST');
    this.modelId = `ollama:${opts.model ?? process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL}`;
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.BRAIN_LLM_TIMEOUT_MS || 120_000);
    this.fetchFn = opts.fetch ?? fetch;
  }

  protected async raw(messages: readonly Message[], schema: z.ZodType): Promise<string> {
    let format: unknown = 'json';
    try {
      format = z.toJSONSchema(schema);
    } catch {
      /* schema not expressible as JSON schema: plain JSON mode */
    }
    const data = (await postJson(
      this.fetchFn,
      `${this.host}/api/chat`,
      { model: this.modelId.slice('ollama:'.length), messages, stream: false, format, options: { temperature: 0, seed: 0 } },
      { timeoutMs: this.timeoutMs, what: 'Ollama chat' },
    )) as { message?: { content?: string } };
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
  readonly modelId: string;
  readonly dimensions = 768;
  private readonly host: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;

  constructor(opts: OllamaEmbedderOptions = {}) {
    this.host = parseBaseUrl(opts.host ?? process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST, 'OLLAMA_HOST');
    this.modelId = `ollama:${opts.model ?? process.env.OLLAMA_EMBED_MODEL ?? DEFAULT_EMBED_MODEL}`;
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.BRAIN_LLM_TIMEOUT_MS || 120_000);
    this.fetchFn = opts.fetch ?? fetch;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const data = (await postJson(
      this.fetchFn,
      `${this.host}/api/embed`,
      { model: this.modelId.slice('ollama:'.length), input: texts },
      { timeoutMs: this.timeoutMs, what: 'Ollama embed' },
    )) as { embeddings?: number[][] };
    const out = data.embeddings;
    if (!Array.isArray(out) || out.length !== texts.length) throw new LLMError('Ollama embed: unexpected number of embeddings');
    for (const v of out) if (!Array.isArray(v) || v.length !== this.dimensions) throw new LLMError(`Ollama embed: expected ${this.dimensions} dimensions`);
    return out;
  }
}
