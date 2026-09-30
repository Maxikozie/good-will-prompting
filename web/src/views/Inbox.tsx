import { useEffect, useState } from 'react';
import type { Person, Task } from '../../../src/core/types';
import { api } from '../api';
import { ago } from '../ui';

interface Done {
  pageTitle: string;
  superseded: number;
}

const ISSUE_STYLE: Record<string, string> = {
  conflict: 'bg-red-50 text-accent border-red-200',
  gap: 'bg-brand-50 text-brand border-blue-200',
};

export default function Inbox({
  tasks,
  people,
  name,
  onChange,
  onBackToLive,
}: {
  tasks: Task[];
  people: Person[];
  name: (id: string | null | undefined) => string;
  onChange: () => void;
  onBackToLive: () => void;
}) {
  const [viewAs, setViewAs] = useState<string | null>(null); // MOCK login
  const [done, setDone] = useState<Done | null>(null);
  const me = viewAs ?? tasks.find((t) => t.status === 'open')?.assignee ?? 'lotte.peeters';
  // Freeze the default viewer once tasks load, so resolving a task doesn't switch the person.
  useEffect(() => {
    if (!viewAs && tasks.length) setViewAs(me);
  }, [viewAs, tasks.length, me]);
  const sorted = [...tasks].sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open'));
  const mine = sorted.filter((t) => t.status === 'open' && t.assignee === me).length;

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div className="flex items-end gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-navy">Owner inbox</h1>
          <p className="text-[15px] text-slate-500">
            {mine} open task{mine === 1 ? '' : 's'} for {name(me)}. Fix it once, and every agent gets the trusted answer.
          </p>
        </div>
        <label className="ml-auto flex items-center gap-2 text-sm text-slate-500">
          Viewing as
          <select
            value={me}
            onChange={(e) => setViewAs(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-[15px] text-navy"
          >
            {people
              .filter((p) => p.active)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.role}
                </option>
              ))}
          </select>
        </label>
      </div>

      {done && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-5 flex items-center gap-4">
          <div className="flex-1">
            <div className="text-lg font-semibold text-emerald-800">✓ Verified. {done.superseded} source{done.superseded === 1 ? '' : 's'} superseded.</div>
            <div className="text-[15px] text-emerald-700">Page: {done.pageTitle}</div>
          </div>
          <button onClick={onBackToLive} className="rounded-lg bg-navy text-white px-5 py-2.5 font-medium hover:bg-brand">
            Ask the question again →
          </button>
        </div>
      )}

      {sorted.length === 0 && (
        <div className="bg-white rounded-xl border border-dashed border-slate-300 p-10 text-center text-slate-400">No tasks yet. Flag a conflict from the Live call.</div>
      )}
      {sorted.map((t) => (
        <TaskCard key={t.id} t={t} me={me} name={name} onResolved={(d) => { setDone(d); onChange(); }} />
      ))}
    </div>
  );
}

function TaskCard({ t, me, name, onResolved }: { t: Task; me: string; name: (id: string | null | undefined) => string; onResolved: (d: Done) => void }) {
  const [claim, setClaim] = useState(t.suggested_claim ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const open = t.status === 'open';

  async function resolve() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.resolve(t.id, claim.trim(), me);
      onResolved({ pageTitle: r.page.title, superseded: r.superseded.length });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`bg-white rounded-xl border border-slate-200 shadow-sm p-5 ${open ? '' : 'opacity-70'}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-[13px] font-semibold uppercase tracking-wide border rounded-md px-2 py-0.5 ${ISSUE_STYLE[t.issue] ?? 'bg-amber-50 text-amber-700 border-amber-200'}`}>
          {t.issue}
        </span>
        <span className="text-lg font-semibold text-navy">{t.topic_label}</span>
        {(t.client || t.country) && !(t.client && t.topic_label.includes(t.client)) && <span className="text-[15px] text-slate-500">· {[t.client, t.country].filter(Boolean).join(' ')}</span>}
        <span className="ml-auto text-sm text-slate-500">
          {open ? (t.assignee === me ? 'Assigned to you' : `Assigned to ${name(t.assignee)}`) : `Resolved by ${name(t.resolved_by)}`}
        </span>
      </div>
      <p className="mt-2 text-[15px] text-slate-700">“{t.note}”</p>
      <p className="mt-1 text-sm text-slate-500">
        Flagged by {name(t.created_by)} · {ago(t.created_at)} · {t.assignee_reason}
      </p>
      {t.page_ids.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {t.page_ids.map((p) => (
            <span key={p} className="text-[13px] bg-slate-100 text-slate-600 rounded-md px-2 py-0.5">
              {p}
            </span>
          ))}
        </div>
      )}

      {open ? (
        <div className="mt-4">
          <label className="text-sm font-medium text-navy">Verified answer</label>
          <textarea
            value={claim}
            onChange={(e) => setClaim(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-[15px] text-navy focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand"
          />
          <div className="mt-2 flex items-center gap-3">
            <button
              onClick={resolve}
              disabled={busy || claim.trim().length < 5}
              className="rounded-lg bg-emerald-600 text-white px-5 py-2.5 font-medium hover:bg-emerald-700 disabled:opacity-50"
            >
              {busy ? 'Verifying…' : 'Resolve & verify'}
            </button>
            {err && <span className="text-sm text-red-700">{err}</span>}
          </div>
        </div>
      ) : (
        t.verified_claim && <p className="mt-3 text-[15px] text-emerald-800 bg-emerald-50 rounded-lg px-3 py-2">✓ {t.verified_claim}</p>
      )}
    </div>
  );
}
