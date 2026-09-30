import { parseEnv } from '../security/env';
import type { Db } from '../store/db';
import type { Embedder, LLMProvider } from '../llm';
import type { SlotTemplate } from '../domain';
import { rulesVersion } from '../rules/ladder-config';
import { loadSlotTemplates } from '../rules/slots';

/** Everything a stage needs. Stages are `(ctx, input) → output`; nothing is global. */
export interface PipelineCtx {
  db: Db;
  llm: LLMProvider;
  embedder: Embedder;
  /** Known slot templates (slots/*.yaml). */
  templates: readonly SlotTemplate[];
  /** Pinned in tests; honours TRUSTLAYER_NOW like the rest of the repo. */
  now: () => Date;
  /** Stored on every CaseRun: a hash of rules/rules.yaml + rules/scoring.yaml, validated at load time. */
  rulesVersion: string;
  log: (line: string) => void;
}

export function defaultNow(): Date {
  const pinned = parseEnv().TRUSTLAYER_NOW;
  if (pinned) {
    const d = new Date(pinned);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

export function createContext(parts: Pick<PipelineCtx, 'db' | 'llm' | 'embedder'> & Partial<PipelineCtx>): PipelineCtx {
  return { templates: loadSlotTemplates(), now: defaultNow, rulesVersion: rulesVersion(), log: () => {}, ...parts };
}
