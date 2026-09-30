import type { LLMCache } from './cache';
import { LLMError } from './errors';
import { parseBaseUrl, postJson, type FetchFn } from './http';
import { JsonProvider } from './json';
import type { Message } from './types';

export interface AnthropicOptions {
  /** Falls back to ANTHROPIC_API_KEY. The provider refuses to exist without one. */
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxTokens?: number;
  cache?: LLMCache;
  fetch?: FetchFn;
}

export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';

/** Optional, env-gated provider (ANTHROPIC_API_KEY). Plain HTTPS to the Messages API, no SDK dependency. Temperature 0. */
export class AnthropicProvider extends JsonProvider {
  readonly modelId: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly fetchFn: FetchFn;

  constructor(opts: AnthropicOptions = {}) {
    super(opts.cache);
    const key = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) throw new LLMError('AnthropicProvider needs ANTHROPIC_API_KEY (set it in .env)');
    this.apiKey = key;
    this.modelId = `anthropic:${opts.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL}`;
    this.baseUrl = parseBaseUrl(opts.baseUrl ?? 'https://api.anthropic.com', 'Anthropic base URL');
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.BRAIN_LLM_TIMEOUT_MS || 120_000);
    this.maxTokens = opts.maxTokens ?? 4096;
    this.fetchFn = opts.fetch ?? fetch;
  }

  protected async raw(messages: readonly Message[]): Promise<string> {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const convo = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
    const data = (await postJson(
      this.fetchFn,
      `${this.baseUrl}/v1/messages`,
      { model: this.modelId.slice('anthropic:'.length), max_tokens: this.maxTokens, temperature: 0, system, messages: convo },
      { timeoutMs: this.timeoutMs, what: 'Anthropic messages', headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' } },
    )) as { content?: { type: string; text?: string }[] };
    const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    if (!text) throw new LLMError('Anthropic messages: response had no text content');
    return text;
  }
}
