import { useEffect, useMemo, useState } from 'react';
import type { Person, Task } from '../../../src/core/types';
import { api } from '../api';
import { initials, subjectFor } from '../mail';
import { ago, fmtDate } from '../ui';

// MOCK mailbox of the knowledge owner. Emails are TrustLayer fix tasks; replying resolves the task and
// verifies the answer in the vault. No real mail is sent or received.

export default function Mail({
  tasks,
  people,
  onChange,
  onBack,
}: {
  tasks: Task[];
  people: Person[];
  onChange: () => void;
  onBack: (reask: boolean) => void;
}) {
  const person = (id: string | null | undefined) => people.find((p) => p.id === id) ?? null;
  const [owner, setOwner] = useState<string | null>(null); // MOCK login: whose mailbox we're looking at
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<{ id: string; superseded: number } | null>(null);

  // Default mailbox: the assignee of the newest open task (Lotte in the demo). Frozen once chosen.
  const me = owner ?? tasks.find((t) => t.status === 'open')?.assignee ?? 'lotte.peeters';
  useEffect(() => {
    if (!owner && tasks.length) setOwner(me);
  }, [owner, tasks.length, me]);

  const mine = useMemo(
    () => tasks.filter((t) => t.assignee === me).sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open') || b.created_at.localeCompare(a.created_at)),
    [tasks, me],
  );
  const open = mine.find((t) => t.id === selected) ?? mine[0] ?? null;
  const meP = person(me);
  const assignees = [...new Set([me, ...tasks.map((t) => t.assignee)])];

  async function reply(t: Task) {
    const text = (draft[t.id] ?? t.suggested_claim ?? '').trim();
    setErr(null);
    setSending(true);
    try {
      const r = await api.resolve(t.id, text, me);
      setSent({ id: t.id, superseded: r.superseded.length });
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not send');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="h-full flex flex-col bg-white">
      <header className="h-16 shrink-0 border-b border-slate-100 px-8 flex items-center gap-6">
        <button onClick={() => onBack(false)} className="text-[14px] text-slate-400 hover:text-slate-700">
          ← Ask
        </button>
        <span className="text-[15px] font-medium text-slate-800">Mail</span>
        <div className="ml-auto flex items-center gap-3">
          <span className="w-8 h-8 rounded-full bg-brand-50 text-brand text-[13px] font-semibold flex items-center justify-center">{initials(meP?.name ?? me)}</span>
          {/* MOCK login: switch mailbox */}
          <select
            value={me}
            onChange={(e) => {
              setOwner(e.target.value);
              setSelected(null);
              setSent(null);
            }}
            className="text-[14px] text-slate-600 bg-transparent outline-none cursor-pointer"
          >
            {assignees.map((id) => (
              <option key={id} value={id}>
                {person(id)?.email ?? id}
              </option>
            ))}
          </select>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        {/* message list */}
        <ul className="w-[380px] shrink-0 border-r border-slate-100 overflow-y-auto">
          {mine.length === 0 && <li className="px-8 py-10 text-[14px] text-slate-400">No mail.</li>}
          {mine.map((t) => {
            const from = person(t.created_by);
            const active = open?.id === t.id;
            return (
              <li key={t.id}>
                <button
                  onClick={() => {
                    setSelected(t.id);
                    setErr(null);
                  }}
                  className={`w-full text-left px-8 py-4 border-b border-slate-50 ${active ? 'bg-slate-50' : 'hover:bg-slate-50/60'}`}
                >
                  <div className="flex items-center gap-2">
                    {t.status === 'open' ? <span className="w-2 h-2 rounded-full bg-brand" /> : <span className="text-[12px] text-slate-400">↩</span>}
                    <span className={`flex-1 truncate text-[14px] ${t.status === 'open' ? 'font-semibold text-slate-900' : 'text-slate-600'}`}>{from?.name ?? 'TrustLayer'}</span>
                    <span className="text-[12px] text-slate-400">{ago(t.created_at)}</span>
                  </div>
                  <div className={`mt-1 truncate text-[14px] ${t.status === 'open' ? 'text-slate-800' : 'text-slate-500'}`}>{subjectFor(t)}</div>
                  <div className="mt-0.5 truncate text-[13px] text-slate-400">{t.note.replace(/\s+/g, ' ')}</div>
                </button>
              </li>
            );
          })}
        </ul>

        {/* reading pane */}
        <div className="flex-1 overflow-y-auto">
          {open && (
            <article className="max-w-3xl px-12 py-10 space-y-8">
              <div>
                <h1 className="text-[22px] font-medium text-slate-900">{subjectFor(open)}</h1>
                <div className="mt-4 flex items-center gap-3">
                  <span className="w-10 h-10 rounded-full bg-slate-100 text-slate-600 text-[14px] font-semibold flex items-center justify-center">
                    {initials(person(open.created_by)?.name ?? 'TrustLayer')}
                  </span>
                  <div className="text-[14px] leading-tight">
                    <div className="text-slate-800">
                      {person(open.created_by)?.name ?? 'TrustLayer'}{' '}
                      <span className="text-slate-400">&lt;{person(open.created_by)?.email ?? 'radar@trustlayer.example'}&gt;</span>
                    </div>
                    <div className="text-slate-400">
                      to {meP?.name ?? me} · {fmtDate(open.created_at)}
                    </div>
                  </div>
                </div>
              </div>

              <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-slate-700">{open.note}</p>

              {open.status === 'open' ? (
                <div className="rounded-2xl border border-slate-200 focus-within:border-slate-300 shadow-[0_4px_24px_rgba(15,23,42,0.05)]">
                  <div className="px-5 pt-4 text-[13px] text-slate-400">
                    Reply to {person(open.created_by)?.name ?? 'TrustLayer'} · your answer becomes the verified answer in TrustLayer
                  </div>
                  <textarea
                    value={draft[open.id] ?? open.suggested_claim ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, [open.id]: e.target.value }))}
                    maxLength={1000}
                    rows={4}
                    placeholder="Write the correct answer…"
                    className="w-full resize-none bg-transparent outline-none px-5 py-3 text-[15px] leading-relaxed text-slate-800"
                  />
                  <div className="px-4 pb-4 flex items-center gap-3">
                    <button
                      onClick={() => reply(open)}
                      disabled={sending || (draft[open.id] ?? open.suggested_claim ?? '').trim().length < 5}
                      className="rounded-full bg-navy text-white px-5 py-2 text-[14px] font-medium disabled:bg-slate-200 disabled:text-slate-400"
                    >
                      {sending ? 'Sending…' : 'Send reply'}
                    </button>
                    {err && <span className="text-[13px] text-accent">{err}</span>}
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="border-l-2 border-slate-200 pl-5">
                    <div className="text-[13px] text-slate-400">
                      {person(open.resolved_by)?.name ?? open.resolved_by} replied · {fmtDate(open.resolved_at ?? open.created_at)}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-[15px] leading-relaxed text-slate-800">{open.verified_claim}</p>
                  </div>
                  <p className="text-[14px] text-emerald-700">
                    ✓ Verified in TrustLayer
                    {sent?.id === open.id && sent.superseded ? ` · ${sent.superseded} outdated source${sent.superseded > 1 ? 's' : ''} superseded` : ''}
                  </p>
                  {sent?.id === open.id && (
                    <button onClick={() => onBack(true)} className="text-[14px] text-brand hover:underline">
                      Ask the question again →
                    </button>
                  )}
                </div>
              )}
            </article>
          )}
        </div>
      </div>
    </div>
  );
}
