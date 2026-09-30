import { useEffect, useState } from 'react';
import type { Badge, Person, SourceVerdict, Task, Verdict } from '../../../src/core/types';
import { api, CALL_AGENT, cleanContext, type AssistantResult } from '../api';
import { ago, fmtDate, scoreText } from '../ui';

const QUESTION = 'What is the Sunday overtime premium for Nordwind Retail employees in Belgium?';

const ORIGIN: Record<string, string> = { sharepoint: 'SharePoint', teams: 'Teams', outlook: 'Outlook', internal: 'TrustLayer wiki' };

const BADGE: Record<Badge, string> = {
  good: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  warn: 'bg-amber-50 text-amber-700 border-amber-200',
  bad: 'bg-red-50 text-red-700 border-red-200',
};

const LEVEL_BAR: Record<SourceVerdict['level'], string> = { high: 'bg-emerald-500', medium: 'bg-amber-400', low: 'bg-red-400' };

export default function LiveCall({ rerun, people, tasks, onChange }: { rerun: number; people: Person[]; tasks: Task[]; onChange: () => void }) {
  const [q, setQ] = useState(QUESTION);
  const [results, setResults] = useState<AssistantResult[] | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState<Task | null>(null);
  const [sending, setSending] = useState(false);

  async function ask() {
    setLoading(true);
    setErr(null);
    setSent(null);
    try {
      const a = await api.assistant(q);
      setResults(a.results);
      setVerdict(await api.verify(q, a.results));
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (rerun > 0) ask();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rerun]);

  async function askOwner() {
    if (!verdict?.topic) return;
    setSending(true);
    setErr(null);
    try {
      const r = await api.flag(verdict.topic.id, 'conflict', `Customer on the line: ${verdict.question}`, cleanContext(verdict.context), CALL_AGENT);
      setSent(r.task);
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  // Open task for this topic + scope: just sent, already on the verdict, or created elsewhere (e.g. by Claude via MCP).
  const candidate =
    sent ??
    verdict?.open_task ??
    tasks.find(
      (t) => t.status === 'open' && t.issue === 'conflict' && verdict?.topic && t.topic === verdict.topic.id && t.country === (verdict.context.country ?? null),
    ) ??
    null;
  const task = candidate ? (tasks.find((t) => t.id === candidate.id) ?? candidate) : null;
  const name = (id: string) => people.find((p) => p.id === id)?.name ?? id;
  const possessive = (n: string) => (n.endsWith('s') ? `${n}'` : `${n}'s`);

  return (
    <div className="space-y-5">
      <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
        <div className="flex items-center gap-2 text-sm text-slate-500 mb-3">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
          <span>
            <b className="text-navy font-medium">Nina Maes</b> is on a call with a customer
          </span>
        </div>
        <form
          className="flex gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            ask();
          }}
        >
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="flex-1 rounded-lg border border-slate-300 px-4 py-3 text-lg text-navy focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand"
          />
          <button disabled={loading || q.trim().length < 3} className="px-7 rounded-lg bg-navy text-white text-lg font-medium hover:bg-brand disabled:opacity-50">
            {loading ? 'Asking…' : 'Ask'}
          </button>
        </form>
        {err && <p className="mt-3 text-sm text-red-700">{err}</p>}
      </section>

      <div className="grid grid-cols-[35%_1fr] gap-6 items-start">
        {/* LEFT: what the existing assistant returns today */}
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 mb-1">SD Worx Assistant · today</h2>
          <p className="text-[15px] text-slate-500 mb-3">
            {results ? `${results.length} documents. Which one do you trust?` : 'Bare search results, no trust information.'}
          </p>
          <div className="space-y-3">
            {results?.map((r) => (
              <div key={r.id} className="bg-slate-100/70 border border-slate-200 rounded-xl p-4">
                <div className="font-medium text-slate-700">{r.title}</div>
                <p className="mt-1 text-[15px] text-slate-500">{r.snippet}</p>
              </div>
            ))}
            {!results && <div className="border border-dashed border-slate-300 rounded-xl p-8 text-center text-slate-400">Press Ask</div>}
          </div>
        </section>

        {/* RIGHT: TrustLayer verdict */}
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-navy mb-1">TrustLayer verdict</h2>
          <p className="text-[15px] text-slate-500 mb-3">Same question, checked for owner, freshness, country and conflicts.</p>
          {!verdict && <div className="border border-dashed border-slate-300 rounded-xl p-8 text-center text-slate-400">The trusted answer appears here</div>}
          {verdict && (
            <div className="space-y-4">
              {/* Answer card */}
              <div className={`bg-white rounded-xl border shadow-sm p-5 ${verdict.verified ? 'border-emerald-300 ring-2 ring-emerald-100' : 'border-slate-200'}`}>
                <div className="flex items-start gap-6">
                  <div className="flex-1">
                    {verdict.verified ? (
                      <span className="inline-flex items-center gap-2 rounded-full bg-emerald-600 text-white px-3.5 py-1.5 text-[15px] font-semibold">
                        ✓ Verified by {verdict.recommended?.owner?.name ?? 'owner'}
                        {verdict.recommended?.last_verified ? ` · ${fmtDate(verdict.recommended.last_verified)}` : ''}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-2 rounded-full bg-amber-100 text-amber-800 border border-amber-200 px-3.5 py-1.5 text-[15px] font-semibold">
                        Not verified yet
                      </span>
                    )}
                    <p className="mt-3 text-xl leading-snug text-navy font-medium">{verdict.answer}</p>
                    <p className="mt-2 text-[15px] text-slate-500">{verdict.answer_basis}</p>
                  </div>
                  {verdict.recommended && (
                    <div className="text-center shrink-0">
                      <div className={`text-5xl font-bold ${scoreText(verdict.recommended.score)}`}>{verdict.recommended.score}</div>
                      <div className="text-[13px] text-slate-500 mt-1">trust score</div>
                    </div>
                  )}
                </div>
              </div>

              {/* Conflict callout */}
              {verdict.conflicts.map((c) => (
                <div key={c.id} className="bg-white rounded-xl border border-slate-200 border-l-4 border-l-accent shadow-sm p-5">
                  <div className="font-semibold text-accent">Conflict · {c.sides.length} sources disagree</div>
                  <p className="mt-1 text-[15px] text-slate-600">{c.summary}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {c.sides.map((s) => (
                      <div key={s.page_id} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                        <span className="text-lg font-bold text-navy">{s.value}</span>
                        <span className="text-sm text-slate-500"> · {s.owner_name ?? 'no owner'} · {s.source_type}</span>
                        <span className={`text-sm font-semibold ${scoreText(s.score)}`}> · {s.score}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 pt-3 border-t border-slate-100 flex items-center gap-4">
                    <div className="flex-1 text-[15px] text-slate-600">
                      {verdict.owner_to_ask && (
                        <>
                          Owner: <b className="text-navy font-medium">{verdict.owner_to_ask.name}</b> · {verdict.owner_reason}
                        </>
                      )}
                    </div>
                    {task && task.status === 'open' ? (
                      <span className="rounded-lg bg-brand-50 text-brand px-4 py-2 text-[15px] font-medium">
                        {sent ? `✓ Sent to ${possessive(name(task.assignee))} inbox` : `Task open · waiting for ${name(task.assignee)}`}
                      </span>
                    ) : (
                      <button onClick={askOwner} disabled={sending} className="rounded-lg bg-navy text-white px-5 py-2.5 font-medium hover:bg-brand disabled:opacity-50">
                        {sending ? 'Sending…' : 'Ask owner'}
                      </button>
                    )}
                  </div>
                </div>
              ))}

              {/* Source cards */}
              <div className="space-y-2.5">
                {verdict.sources.map((s, i) => (
                  <SourceCard key={s.page_id ?? i} s={s} askedCountry={verdict.context.country ?? null} />
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function SourceCard({ s, askedCountry }: { s: SourceVerdict; askedCountry: string | null }) {
  const superseded = s.status === 'superseded';
  const badges: { tone: Badge; label: string }[] = [
    { tone: s.badges.owner, label: s.owner ? `${s.owner.name}${s.owner.active ? '' : ' (left)'}` : 'No owner' },
    { tone: s.badges.freshness, label: s.last_verified ? `Verified ${ago(s.last_verified)}` : s.last_edited ? `Edited ${ago(s.last_edited)}` : 'No date' },
    { tone: s.badges.scope, label: s.country && askedCountry && s.country !== askedCountry ? `${s.country} ≠ ${askedCountry}` : (s.country ?? 'All countries') },
    { tone: s.badges.verified, label: s.badges.verified === 'good' ? 'Verified' : 'Unverified' },
  ];
  return (
    <div className={`bg-white rounded-xl border border-slate-200 shadow-sm p-4 ${superseded ? 'opacity-50' : ''}`}>
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px] font-semibold uppercase tracking-wide text-slate-400">{ORIGIN[s.origin ?? ''] ?? 'Unknown'}</span>
            {!s.from_assistant && <span className="text-[13px] rounded-full bg-brand-50 text-brand px-2 py-0.5 font-medium">Found by TrustLayer</span>}
            {superseded && <span className="text-[13px] rounded-full bg-slate-200 text-slate-600 px-2 py-0.5 font-medium">Superseded</span>}
          </div>
          <div className={`mt-0.5 font-medium text-navy ${superseded ? 'line-through decoration-slate-400' : ''}`}>{s.title}</div>
        </div>
        <div className="w-28 shrink-0 text-right">
          <div className={`text-2xl font-bold ${scoreText(s.score)}`}>{s.score}</div>
          <div className="h-1.5 rounded-full bg-slate-100 mt-1">
            <div className={`h-1.5 rounded-full ${LEVEL_BAR[s.level]}`} style={{ width: `${s.score}%` }} />
          </div>
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {s.claim && <span className="text-sm font-bold text-navy bg-slate-100 rounded-md px-2 py-0.5 mr-1">{s.claim.value}</span>}
        {badges.map((b, i) => (
          <span key={i} className={`text-[13px] border rounded-md px-2 py-0.5 ${BADGE[b.tone]}`}>
            {b.label}
          </span>
        ))}
      </div>
      <ul className="mt-2 space-y-0.5 text-sm text-slate-600">
        {s.reasons.slice(0, 2).map((r, i) => (
          <li key={i}>· {r}</li>
        ))}
      </ul>
    </div>
  );
}
