import { useState } from 'react';
import type { HealthReport, IssueType, Person, QueryContext, Task } from '../../../src/core/types';
import { api, CALL_AGENT, cleanContext } from '../api';
import { emailFromRadar } from '../mail';
import { scoreText } from '../ui';

// The knowledge health radar as a quiet slide-over on the Ask screen.

interface Item {
  key: string;
  text: string;
  detail: string;
  topic: string;
  issue: IssueType;
  context?: QueryContext;
  openTaskId: string | null;
}

export default function RadarPanel({
  health,
  delta,
  tasks,
  people,
  onChange,
  onClose,
}: {
  health: HealthReport | null;
  delta: number | null;
  tasks: Task[];
  people: Person[];
  onChange: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const me = people.find((p) => p.id === CALL_AGENT) ?? null;
  const name = (id: string) => people.find((p) => p.id === id)?.name ?? id;

  async function email(it: Item) {
    setBusy(it.key);
    setErr(null);
    try {
      await api.flag(it.topic, it.issue, emailFromRadar(it.detail, me), it.context, CALL_AGENT);
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not send');
    } finally {
      setBusy(null);
    }
  }

  const groups: { title: string; items: Item[] }[] = health
    ? [
        {
          title: 'Conflicts',
          items: health.conflicts.map((c) => ({
            key: c.id,
            text: `${c.topic_label} · ${[c.client, c.country].filter(Boolean).join(' ')}`,
            detail: c.summary,
            topic: c.topic,
            issue: 'conflict' as const,
            context: cleanContext({ country: c.country, client: c.client }),
            openTaskId: c.open_task_id,
          })),
        },
        {
          title: 'No owner',
          items: health.orphans.map((o) => ({ key: o.page_id, text: o.title, detail: `"${o.title}": ${o.detail}`, topic: o.page_id, issue: 'orphan' as const, openTaskId: o.open_task_id })),
        },
        {
          title: 'Stale',
          items: health.stale.map((o) => ({ key: o.page_id, text: o.title, detail: `"${o.title}": ${o.detail}`, topic: o.page_id, issue: 'stale' as const, openTaskId: o.open_task_id })),
        },
        {
          title: 'Unanswered questions',
          items: health.gaps
            .filter((g) => g.topic)
            .map((g) => ({
              key: g.question,
              text: `${g.question} · asked ${g.times_asked}×`,
              detail: `"${g.question}" was asked ${g.times_asked} times and nobody could answer it with a trusted source`,
              topic: g.topic!,
              issue: 'gap' as const,
              context: cleanContext({ country: g.country, client: g.client }),
              openTaskId: g.open_task_id,
            })),
        },
      ]
    : [];

  return (
    <div className="fixed inset-0 z-20">
      <div className="absolute inset-0 bg-slate-900/10" onClick={onClose} />
      <aside className="absolute right-0 top-0 h-full w-[460px] bg-white shadow-[-8px_0_32px_rgba(15,23,42,0.08)] px-8 py-8 overflow-y-auto animate-[fadein_.25s_ease-out]">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-medium text-slate-500">Knowledge health</h2>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-700 text-xl leading-none">
            ×
          </button>
        </div>

        {!health ? (
          <p className="mt-10 text-slate-400">Loading…</p>
        ) : (
          <>
            <div className="mt-6 flex items-end gap-4">
              <span className={`text-7xl font-semibold tabular-nums leading-none ${scoreText(health.score)}`}>{health.score}</span>
              {delta ? <span className="mb-1 text-emerald-600 font-medium">▲ +{delta}</span> : null}
            </div>
            <p className="mt-3 text-[14px] text-slate-400">
              {health.pages} pages · {health.verified} verified · {health.open_tasks} emails waiting for a reply
            </p>

            {err && <p className="mt-4 text-[13px] text-accent">{err}</p>}

            <div className="mt-8 space-y-7">
              {groups.map((g) => (
                <section key={g.title}>
                  <h3 className="text-[13px] font-medium text-slate-400">
                    {g.title} <span className="text-slate-300">{g.items.length}</span>
                  </h3>
                  {g.items.length === 0 ? (
                    <p className="mt-2 text-[14px] text-emerald-600">✓ None</p>
                  ) : (
                    <ul className="mt-2 space-y-2.5">
                      {g.items.map((it) => {
                        const task = it.openTaskId ? tasks.find((t) => t.id === it.openTaskId) : null;
                        return (
                          <li key={it.key} className="flex items-start gap-3 text-[14px]">
                            <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${g.title === 'Conflicts' ? 'bg-accent' : 'bg-amber-400'}`} />
                            <span className="flex-1 text-slate-700">{it.text}</span>
                            {task ? (
                              <span className="shrink-0 text-[13px] text-slate-400">Emailed {name(task.assignee).split(' ')[0]}</span>
                            ) : (
                              <button
                                onClick={() => email(it)}
                                disabled={busy === it.key}
                                className="shrink-0 text-[13px] text-brand hover:underline disabled:text-slate-300"
                              >
                                Email owner
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              ))}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
