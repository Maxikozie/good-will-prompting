import type { Verdict } from '../../../../src/core/types';

type Step = 'assistant' | 'verify' | 'done' | 'error';

export interface Turn {
  id: number;
  question: string;
  step: Step;
  docs: number;
  verdict: Verdict | null;
  error: string | null;
}

