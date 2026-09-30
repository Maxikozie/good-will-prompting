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
  const kind = (env.BRAIN_LLM_PROVIDER || 'ollama') as ProviderKind;
  switch (kind) {
    case 'ollama':
      return new OllamaProvider({ cache });
    case 'anthropic':
      return new AnthropicProvider({ cache });
    case 'fake':
      return FakeProvider.fromDir(env.BRAIN_LLM_FIXTURES || DEFAULT_FIXTURE_DIR);
    default:
      throw new LLMError(`Unknown BRAIN_LLM_PROVIDER "${String(kind)}" (use ollama, anthropic or fake)`);
  }
}

/** BRAIN_EMBEDDER = ollama (default) | fake. */
export function createEmbedder(env: NodeJS.ProcessEnv = process.env): Embedder {
  const kind = env.BRAIN_EMBEDDER || (env.BRAIN_LLM_PROVIDER === 'fake' ? 'fake' : 'ollama');
  if (kind === 'fake') return new FakeEmbedder();
  if (kind === 'ollama') return new OllamaEmbedder();
  throw new LLMError(`Unknown BRAIN_EMBEDDER "${kind}" (use ollama or fake)`);
}
