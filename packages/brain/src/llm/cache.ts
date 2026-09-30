import { createHash } from 'node:crypto';
import type { Message } from './types';

/** Content hash of a rendered prompt: the "input hash" in cache keys and fixture names. */
export function inputHash(messages: readonly Message[]): string {
  return createHash('sha256').update(JSON.stringify(messages.map((m) => ({ role: m.role, content: m.content })))).digest('hex');
}

export interface CacheKey {
  promptId: string;
  promptVersion: string;
  modelId: string;
  inputHash: string;
}

/** Content-hash cache (SPEC §5 stage 20: "cache by (passageHash, promptVersion, modelId)"). Only validated responses are stored. */
export interface LLMCache {
  get(key: CacheKey): Promise<unknown | undefined>;
  set(key: CacheKey, response: unknown): Promise<void>;
}

const k = (key: CacheKey) => `${key.promptId}\u0000${key.promptVersion}\u0000${key.modelId}\u0000${key.inputHash}`;

export class MemoryCache implements LLMCache {
  readonly entries = new Map<string, unknown>();
  async get(key: CacheKey) {
    return this.entries.get(k(key));
  }
  async set(key: CacheKey, response: unknown) {
    if (!this.entries.has(k(key))) this.entries.set(k(key), response); // first answer wins: same input, same output
  }
}
