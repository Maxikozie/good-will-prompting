import { parseEnv } from '../security/env';
import path from 'node:path';
import { AnthropicProvider } from './anthropic';
import type { LLMCache } from './cache';
import { FakeEmbedder } from './embedder';
import { LLMError } from './errors';
import { FakeProvider } from './fake';
import { OllamaEmbedder, OllamaProvider } from './ollama';
import type { Embedder, LLMProvider } from './types';

export type ProviderKind = 'ollama' | 'anthropic' | 'fake';

/** Fixtures recorded by `npm run brain:record`, replayed by the FakeProvider. */
export const DEFAULT_FIXTURE_DIR = path.resolve(import.meta.dirname, '..', '..', 'test', 'fixtures', 'llm');

/** BRAIN_LLM_PROVIDER = ollama (default) | anthropic | fake. `anthropic` only exists when ANTHROPIC_API_KEY is set. */
export function createProvider(env: NodeJS.ProcessEnv = process.env, cache?: LLMCache): LLMProvider {
  const config = parseEnv(env);
  const kind = config.BRAIN_LLM_PROVIDER ?? 'ollama';
  switch (kind) {
    case 'ollama':
      return new OllamaProvider({ cache, host: config.OLLAMA_HOST, model: config.OLLAMA_MODEL, timeoutMs: config.BRAIN_LLM_TIMEOUT_MS });
    case 'anthropic':
      return new AnthropicProvider({ cache, apiKey: config.ANTHROPIC_API_KEY, model: config.ANTHROPIC_MODEL, timeoutMs: config.BRAIN_LLM_TIMEOUT_MS });
    case 'fake':
      return FakeProvider.fromDir(config.BRAIN_LLM_FIXTURES || DEFAULT_FIXTURE_DIR);
    default:
      throw new LLMError(`Unknown BRAIN_LLM_PROVIDER "${String(kind)}" (use ollama, anthropic or fake)`);
  }
}

/** BRAIN_EMBEDDER = ollama (default) | fake. */
export function createEmbedder(env: NodeJS.ProcessEnv = process.env): Embedder {
  const config = parseEnv(env);
  const kind = config.BRAIN_EMBEDDER ?? (config.BRAIN_LLM_PROVIDER === 'fake' ? 'fake' : 'ollama');
  if (kind === 'fake') return new FakeEmbedder();
  if (kind === 'ollama') return new OllamaEmbedder({ host: config.OLLAMA_HOST, model: config.OLLAMA_EMBED_MODEL, timeoutMs: config.BRAIN_LLM_TIMEOUT_MS });
  throw new LLMError(`Unknown BRAIN_EMBEDDER "${kind}" (use ollama or fake)`);
}
