import { useCallback, useEffect, useRef, useState } from 'react';
import type { HealthReport, Person, Task } from '../../src/core/types';
import { api } from './api';
import Ask from './views/Ask';
import Mail from './views/Mail';

// Two screens: Ask (the spotlight: a Claude-plugin-like canvas with the radar inside it) and Mail (the owner's mailbox).
type View = 'ask' | 'mail';
const viewFromHash = (): View => (window.location.hash === '#mail' ? 'mail' : 'ask');
const storedScore = () => {
  const raw = sessionStorage.getItem('tl.lastScore');
  const n = Number(raw);
  return raw !== null && Number.isFinite(n) ? n : null;
};

export default function App() {
  const [view, setView] = useState<View>(viewFromHash);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [delta, setDelta] = useState<number | null>(null);
  const [rerun, setRerun] = useState(0);
  const [resetKey, setResetKey] = useState(0);
  const lastScore = useRef<number | null>(storedScore());

  const refresh = useCallback(async () => {
    try {
      const [h, t] = await Promise.all([api.health(), api.tasks()]);
      // Only celebrate gains; a drop (e.g. demo reset from outside) clears the delta.
      if (lastScore.current !== null && h.score !== lastScore.current) setDelta(h.score > lastScore.current ? h.score - lastScore.current : null);
      lastScore.current = h.score;
      sessionStorage.setItem('tl.lastScore', String(h.score));
      setHealth(h);
      setTasks(t);
    } catch {
      // keep last good data; polling retries
    }
  }, []);

  useEffect(() => {
    api.people().then(setPeople).catch(() => {});
    refresh();
    const t = setInterval(refresh, 3000); // live updates, also from MCP actions in Claude
    const onHash = () => setView(viewFromHash());
    window.addEventListener('hashchange', onHash);
    return () => {
      clearInterval(t);
      window.removeEventListener('hashchange', onHash);
    };
  }, [refresh]);

  useEffect(() => {
    window.history.replaceState(null, '', view === 'mail' ? '#mail' : '#');
    refresh();
  }, [view, refresh]);

  async function resetDemo() {
    await api.reset().catch(() => {});
    lastScore.current = null;
    sessionStorage.removeItem('tl.lastScore');
    setDelta(null);
    setResetKey((k) => k + 1);
    setView('ask');
    refresh();
  }

  return (
    <div className="h-full bg-white">
      {/* Ask stays mounted so the conversation survives a trip to the mailbox */}
      <div className={view === 'ask' ? 'h-full' : 'hidden'}>
        <Ask
          key={resetKey}
          rerun={rerun}
          tasks={tasks}
          people={people}
          health={health}
          delta={delta}
          onChange={refresh}
          onOpenMail={() => setView('mail')}
          onReset={resetDemo}
        />
      </div>
      {view === 'mail' && (
        <Mail
          key={resetKey}
          tasks={tasks}
          people={people}
          onChange={refresh}
          onBack={(reask) => {
            setView('ask');
            if (reask) setRerun((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}
