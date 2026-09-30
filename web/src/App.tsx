import { useCallback, useEffect, useRef, useState } from 'react';
import type { HealthReport, Person, Task } from '../../src/core/types';
import { api } from './api';
import LiveCall from './views/LiveCall';
import Radar from './views/Radar';
import Inbox from './views/Inbox';
import Ask from './views/Ask';

type View = 'ask' | 'live' | 'radar' | 'inbox';
const VIEWS: View[] = ['ask', 'live', 'radar', 'inbox'];
const initialView = (): View => (VIEWS.find((v) => `#${v}` === window.location.hash) ?? 'ask');
const storedScore = () => {
  const n = Number(sessionStorage.getItem('tl.lastScore'));
  return sessionStorage.getItem('tl.lastScore') !== null && Number.isFinite(n) ? n : null;
};

export default function App() {
  const [view, setView] = useState<View>(initialView);
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
    const t = setInterval(refresh, 3000); // live updates from MCP actions
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const onHash = () => setView(initialView());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    window.history.replaceState(null, '', `#${view}`);
    refresh();
  }, [view, refresh]);

  const name = (id: string | null | undefined) => people.find((p) => p.id === id)?.name ?? id ?? 'unknown';
  const openCount = tasks.filter((t) => t.status === 'open').length;

  async function resetDemo() {
    await api.reset().catch(() => {});
    lastScore.current = null;
    sessionStorage.removeItem('tl.lastScore');
    setDelta(null);
    setResetKey((k) => k + 1);
    setView('ask');
    refresh();
  }

  const tabs: { id: View; label: string; badge?: number }[] = [
    { id: 'ask', label: 'Ask' },
    { id: 'live', label: 'Live call' },
    { id: 'radar', label: 'Knowledge radar' },
    { id: 'inbox', label: 'Owner inbox', badge: openCount },
  ];

  // Semi-headless default: an empty canvas with one composer, like a Claude plugin. Everything else sits behind a faint menu.
  const ask = (
    <div className={view === 'ask' ? 'h-full' : 'hidden'}>
      <Ask key={resetKey} rerun={rerun} tasks={tasks} onChange={refresh} />
      <nav className="fixed top-5 right-6 flex gap-4 text-[13px] text-slate-300">
        <button onClick={() => setView('radar')} className="hover:text-slate-600">Radar</button>
        <button onClick={() => setView('inbox')} className="hover:text-slate-600">
          Inbox{openCount ? ` (${openCount})` : ''}
        </button>
        <button onClick={resetDemo} className="hover:text-slate-600">Reset</button>
      </nav>
    </div>
  );
  return (
    <div className="h-full">
      {ask}
      <div className={view === 'ask' ? 'hidden' : 'min-h-full flex flex-col'}>
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-[1680px] mx-auto px-8 h-16 flex items-center gap-10">
          <div className="flex items-center gap-3">
            <div className="relative w-9 h-9 rounded-lg bg-navy flex items-center justify-center text-white font-bold text-lg">
              T<span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-accent ring-2 ring-white" />
            </div>
            <div className="leading-tight">
              <div className="font-semibold text-navy text-lg">TrustLayer</div>
              <div className="text-[13px] text-slate-500">MCP trust layer for SD Worx knowledge</div>
            </div>
          </div>
          <nav className="flex gap-1 h-full">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setView(t.id)}
                className={`px-4 h-full border-b-2 text-[15px] font-medium flex items-center gap-2 ${
                  view === t.id ? 'border-navy text-navy' : 'border-transparent text-slate-500 hover:text-navy'
                }`}
              >
                {t.label}
                {t.badge ? <span className="min-w-6 h-6 px-1.5 rounded-full bg-accent text-white text-[13px] flex items-center justify-center">{t.badge}</span> : null}
              </button>
            ))}
          </nav>
          {/* MOCK: fake signed-in user */}
          <div className="ml-auto flex items-center gap-3">
            <div className="text-right leading-tight">
              <div className="text-sm font-medium text-navy">Nina Maes</div>
              <div className="text-[13px] text-slate-500">Customer Service BE</div>
            </div>
            <div className="w-9 h-9 rounded-full bg-brand-50 text-brand font-semibold text-sm flex items-center justify-center">NM</div>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-[1680px] w-full mx-auto px-8 py-6">
        <div className={view === 'live' ? '' : 'hidden'}>
          <LiveCall key={resetKey} rerun={rerun} people={people} tasks={tasks} onChange={refresh} />
        </div>
        {view === 'radar' && <Radar health={health} delta={delta} tasks={tasks} name={name} onChange={refresh} />}
        {view === 'inbox' && (
          <Inbox
            key={resetKey}
            tasks={tasks}
            people={people}
            name={name}
            onChange={refresh}
            onBackToLive={() => {
              setView('ask');
              setRerun((n) => n + 1);
            }}
          />
        )}
      </main>

      <footer className="max-w-[1680px] w-full mx-auto px-8 pb-4 flex justify-between text-[13px] text-slate-400">
        <span>Mock data · demo build</span>
        <button onClick={resetDemo} className="hover:text-slate-600 underline-offset-2 hover:underline">
          Reset demo
        </button>
      </footer>
      </div>
    </div>
  );
}
