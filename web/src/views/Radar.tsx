import { useState, type ReactNode } from 'react';
import type { HealthReport, IssueType, QueryContext, Task } from '../../../src/core/types';
import { api, CALL_AGENT, cleanContext } from '../api';
import { scoreText } from '../ui';

interface Item {
  key: string;
  title: string;
  detail: string;
  openTaskId: string | null;
  topic: string;
  issue: IssueType;
  context?: QueryContext;
}

export default function Radar({
  health,
  delta,
  tasks,
  name,
  onChange,
}: {
  health: HealthReport | null;
  delta: number | null;
  tasks: Task[];
  name: (id: string | null | undefined) => string;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (!health) return <div className="text-slate-400">Loading knowledge health…</div>;

  async function assign(it: Item) {
    setBusy(it.key);
    setErr(null);
    try {
      await api.flag(it.topic, it.issue, `Flagged from Knowledge radar: ${it.detail}`, it.context, CALL_AGENT);
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const lists: { title: string; items: Item[] }[] = [
    {
      title: 'Conflicts',
      items: health.conflicts.map((c) => ({
        key: c.id,
        title: `${c.topic_label}${c.client ? ` · ${c.client}` : ''}${c.country ? ` ${c.country}` : ''}`,
        detail: c.summary,
        openTaskId: c.open_task_id,
        topic: c.topic,
        issue: 'conflict',
        context: cleanContext({ country: c.country, client: c.client }),
      })),
    },
    {
      title: 'Orphaned docs',
      items: health.orphans.map((p) => ({ key: `o-${p.page_id}`, title: p.title, detail: p.detail, openTaskId: p.open_task_id, topic: p.page_id, issue: 'orphan' })),
    },
    {
      title: 'Stale docs',
      items: health.stale.map((p) => ({ key: `s-${p.page_id}`, title: p.title, detail: p.detail, openTaskId: p.open_task_id, topic: p.page_id, issue: 'stale' })),
    },
    {
      title: 'Knowledge gaps',
      items: health.gaps.map((g) => ({
        key: `g-${g.question}`,
        title: g.question,
        detail: `Asked ${g.times_asked}× · no trusted answer`,
        openTaskId: g.open_task_id,
        topic: g.topic ?? 'unknown',
        issue: 'gap',
        context: cleanContext({ country: g.country, client: g.client }),
      })),
    },
  ];

  return (
    <div className="space-y-5">
      <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 flex items-center gap-12">
        <div>
          <div className="text-sm font-semibold uppercase tracking-wide text-slate-500">Knowledge health</div>
          <div className="flex items-end gap-4 mt-1">
            <div className={`text-8xl font-bold leading-none ${scoreText(health.score)}`}>{health.score}</div>
            <div className="pb-2">
              <div className="text-slate-400 text-lg">/ 100</div>
              {delta !== null && delta !== 0 && (
                <div className={`text-lg font-semibold ${delta > 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {delta > 0 ? '▲ +' : '▼ '}
                  {delta} since last check
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="flex gap-10 ml-auto pr-4">
          <Stat label="Pages" value={health.pages} />
          <Stat label="Verified" value={health.verified} />
          <Stat label="Open tasks" value={health.open_tasks} />
        </div>
      </section>

      <section className="flex gap-3">
        {health.tiles.map((t) => (
          <div key={`${t.kind}-${t.key}`} className="flex-1 bg-white rounded-xl border border-slate-200 shadow-sm px-4 py-3">
            <div className="text-[13px] uppercase tracking-wide text-slate-400">{t.kind === 'team' ? 'Team' : 'Country'}</div>
            <div className="font-medium text-navy truncate">{t.key === 'All' ? 'All countries' : t.key}</div>
            <div className="flex items-baseline gap-2 mt-1">
              <span className={`text-3xl font-bold ${scoreText(t.score)}`}>{t.score}</span>
              <span className="text-[13px] text-slate-500">
                {t.pages} page{t.pages === 1 ? '' : 's'} · {t.issues} issue{t.issues === 1 ? '' : 's'}
              </span>
            </div>
          </div>
        ))}
      </section>

      {err && <p className="text-sm text-red-700">{err}</p>}

      <div className="grid grid-cols-2 gap-5">
        {lists.map((l) => (
          <Panel key={l.title} title={l.title} count={l.items.length} red={l.title === 'Conflicts' && l.items.length > 0}>
            {l.items.length === 0 && <div className="text-[15px] text-slate-400 py-2">Nothing here. ✓</div>}
            {l.items.map((it) => {
              const t = it.openTaskId ? tasks.find((x) => x.id === it.openTaskId) : null;
              return (
                <div key={it.key} className="flex items-center gap-4 py-3 border-t border-slate-100 first:border-t-0">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-navy">{it.title}</div>
                    <div className="text-sm text-slate-500">{it.detail}</div>
                  </div>
                  {it.openTaskId ? (
                    <span className="shrink-0 text-sm rounded-lg bg-brand-50 text-brand px-3 py-1.5 font-medium">Assigned to {t ? name(t.assignee) : 'owner'}</span>
                  ) : (
                    <button
                      onClick={() => assign(it)}
                      disabled={busy === it.key}
                      className="shrink-0 text-sm rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-navy hover:bg-slate-50 disabled:opacity-50"
                    >
                      {busy === it.key ? 'Assigning…' : 'Assign'}
                    </button>
                  )}
                </div>
              );
            })}
          </Panel>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-center">
      <div className="text-4xl font-bold text-navy">{value}</div>
      <div className="text-sm text-slate-500">{label}</div>
    </div>
  );
}

function Panel({ title, count, red, children }: { title: string; count: number; red?: boolean; children: ReactNode }) {
  return (
    <section className={`bg-white rounded-xl border border-slate-200 shadow-sm p-5 ${red ? 'border-l-4 border-l-accent' : ''}`}>
      <div className="flex items-center gap-2 mb-1">
        <h3 className={`font-semibold ${red ? 'text-accent' : 'text-navy'}`}>{title}</h3>
        <span className="text-sm text-slate-400">{count}</span>
      </div>
      {children}
    </section>
  );
}
