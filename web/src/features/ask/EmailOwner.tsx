import { useEffect, useRef, useState } from 'react';
import type { Person, Task, Verdict } from '../../../../src/core/types';
import { api, cleanContext, CALL_AGENT } from '../../api';
import { emailFromVerdict, subjectFor } from '../../mail';

// "Ask the owner" = an email (MOCK: stored as a TrustLayer fix task, nothing is really sent).
export default function EmailOwner({
  v,
  tasks,
  people,
  onChange,
  onAskAgain,
}: {
  v: Verdict;
  tasks: Task[];
  people: Person[];
  onChange: () => void;
  onAskAgain: () => void;
}) {
  const owner = v.owner_to_ask;
  const me = people.find((p) => p.id === CALL_AGENT) ?? null;
  const [composing, setComposing] = useState(false);
  const [body, setBody] = useState(() => (owner ? emailFromVerdict(v, owner, me) : ''));
  const [taskId, setTaskId] = useState<string | null>(v.open_task?.id ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (composing) card.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [composing]);
  if (!owner || !v.topic || (v.verified && !v.conflicts.length)) return null;

  const issue = v.conflicts.length ? 'conflict' : 'capture';
  const scope = [v.context.client, v.context.country].filter(Boolean).join(' ');
  const subject = subjectFor({ issue, topic_label: `${v.topic.label}${scope ? ` – ${scope}` : ''}` });
  const task =
    (taskId && tasks.find((t) => t.id === taskId)) ||
    tasks.find((t) => t.status === 'open' && t.topic === v.topic!.id && (t.country ?? undefined) === v.context.country) ||
    null;

  if (task?.status === 'resolved')
    return (
      <div className="space-y-2">
        <div className="text-[13px] text-slate-400">↩ {people.find((p) => p.id === task.resolved_by)?.name ?? owner.name} replied</div>
        <p className="border-l-2 border-emerald-300 pl-4 text-[15px] text-slate-700">{task.verified_claim}</p>
        <button onClick={onAskAgain} className="text-[14px] text-brand hover:underline">
          Ask again →
        </button>
      </div>
    );

  if (task || taskId) return <p className="text-[14px] text-slate-500">✉ Email sent to {owner.name} · waiting for a reply</p>;

  if (!composing)
    return (
      <div className="flex items-center gap-3">
        <button
          onClick={() => setComposing(true)}
          className="rounded-full border border-slate-300 px-4 py-1.5 text-[14px] text-slate-700 hover:border-navy hover:text-navy transition"
        >
          ✉ Email {owner.name}
        </button>
        <span className="text-[13px] text-slate-400">{v.owner_reason}</span>
      </div>
    );

  return (
    <div ref={card} className="rounded-2xl border border-slate-200 shadow-[0_4px_24px_rgba(15,23,42,0.06)] animate-[fadein_.25s_ease-out]">
      <div className="px-5 pt-4 space-y-1 text-[14px]">
        <div className="text-slate-400">
          To <span className="text-slate-700">{owner.name}</span> &lt;{owner.email}&gt;
        </div>
        <div className="text-slate-800 font-medium">{subject}</div>
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        maxLength={1000}
        rows={15}
        className="w-full resize-none bg-transparent outline-none px-5 py-3 text-[14px] leading-relaxed text-slate-700"
      />
      <div className="px-4 pb-4 flex items-center gap-3">
        <button
          disabled={sending || body.trim().length < 5}
          onClick={async () => {
            setErr(null);
            setSending(true);
            try {
              const r = await api.flag(v.topic!.id, issue, body, cleanContext(v.context), CALL_AGENT);
              setTaskId(r.task.id);
              onChange();
            } catch (e) {
              setErr(e instanceof Error ? e.message : 'Could not send');
            } finally {
              setSending(false);
            }
          }}
          className="rounded-full bg-navy text-white px-5 py-2 text-[14px] font-medium disabled:bg-slate-200 disabled:text-slate-400"
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
        <button onClick={() => setComposing(false)} className="text-[14px] text-slate-400 hover:text-slate-700">
          Cancel
        </button>
        {err && <span className="text-[13px] text-accent">{err}</span>}
      </div>
    </div>
  );
}

