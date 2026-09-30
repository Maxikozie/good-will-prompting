import type { Db } from '../store/db';
import type { Embedder, LLMProvider } from '../llm';
import type { SlotTemplate } from '../domain';
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
  /** Version stamp stored on every CaseRun (rules/rules.yaml arrives in a later step). */
  rulesVersion: string;
  log: (line: string) => void;
}

export function defaultNow(): Date {
  const pinned = process.env.TRUSTLAYER_NOW;
  if (pinned) {
    const d = new Date(pinned);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

export function createContext(parts: Pick<PipelineCtx, 'db' | 'llm' | 'embedder'> & Partial<PipelineCtx>): PipelineCtx {
  return { templates: loadSlotTemplates(), now: defaultNow, rulesVersion: '0-dev', log: () => {}, ...parts };
}
