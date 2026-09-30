import type { Db } from '../store/db';
import { json, upsert } from '../store/rows';
import type { CacheKey, LLMCache } from './cache';

/** LLMCache backed by brain.llm_cache (migration 002). */
export class DbCache implements LLMCache {
  constructor(private readonly db: Db) {}

  async get(key: CacheKey): Promise<unknown | undefined> {
    const r = await this.db.query<{ response: unknown }>(
      'SELECT response FROM brain.llm_cache WHERE prompt_id = $1 AND prompt_version = $2 AND model_id = $3 AND input_hash = $4',
      [key.promptId, key.promptVersion, key.modelId, key.inputHash],
    );
    return r.rows[0]?.response;
  }

  async set(key: CacheKey, response: unknown): Promise<void> {
    await upsert(
      this.db,
      'brain.llm_cache',
      { prompt_id: key.promptId, prompt_version: key.promptVersion, model_id: key.modelId, input_hash: key.inputHash, response: json(response) },
      ['prompt_id', 'prompt_version', 'model_id', 'input_hash'],
      'nothing',
    );
  }
}
