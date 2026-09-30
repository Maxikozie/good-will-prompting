import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import type { Turn } from './types';

const MIN_STEP_MS = 650; // MOCK pacing: the local API answers in ~20 ms, too fast to read the tool calls on video
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function useConversation(rerun: number, onSend: () => void) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const nextId = useRef(1);
  const busy = turns.some((t) => t.step === 'assistant' || t.step === 'verify');

  // "Back" from the owner inbox asks the last question again, so the verified answer shows up.
  const lastQuestion = turns[turns.length - 1]?.question;
  useEffect(() => {
    if (rerun > 0 && lastQuestion) ask(lastQuestion);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rerun]);

  function patch(id: number, p: Partial<Turn>) {
    setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t)));
  }

  async function ask(q: string) {
    const question = q.trim();
    if (question.length < 3 || busy) return;
    const id = nextId.current++;
    onSend();
    setTurns((ts) => [...ts, { id, question, step: 'assistant', docs: 0, verdict: null, error: null }]);
    try {
      const [a] = await Promise.all([api.assistant(question), wait(MIN_STEP_MS)]);
      patch(id, { step: 'verify', docs: a.results.length });
      const [v] = await Promise.all([api.verify(question, a.results), wait(MIN_STEP_MS)]);
      patch(id, { step: 'done', verdict: v });
    } catch (e) {
      patch(id, { step: 'error', error: e instanceof Error ? e.message : 'Something went wrong' });
    }
  }

  return { turns, busy, ask };
}
