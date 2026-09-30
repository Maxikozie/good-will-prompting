import { useEffect, useRef, useState } from 'react';
import type { SourceVerdict, Task, Verdict } from '../../../src/core/types';
import { api, cleanContext, CALL_AGENT } from '../api';
import { fmtDate, scoreText } from '../ui';

// Semi-headless "Claude + TrustLayer plugin" view: an empty canvas with one composer at the bottom.
// The question goes to the existing assistant, then through trustlayer › verify_sources, shown as a tool call.

type Step = 'assistant' | 'verify' | 'done' | 'error';

interface Turn {
  id: number;
  question: string;
  step: Step;
  docs: number;
  verdict: Verdict | null;
  error: string | null;
}

type Mic = 'idle' | 'recording' | 'transcribing';

const ORIGIN: Record<string, string> = { sharepoint: 'SharePoint', teams: 'Teams', outlook: 'Outlook', internal: 'TrustLayer wiki' };
const MIN_STEP_MS = 650; // MOCK pacing: the local API answers in ~20 ms, too fast to read the tool calls on video
const MAX_RECORDING_MS = 15_000;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function Ask({ rerun, tasks, onChange }: { rerun: number; tasks: Task[]; onChange: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [mic, setMic] = useState<Mic>('idle');
  const [micError, setMicError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stopTimer = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);
  const busy = turns.some((t) => t.step === 'assistant' || t.step === 'verify');

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

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
    setText('');
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

  async function toggleMic() {
    setMicError(null);
    if (mic === 'recording') {
      recorder.current?.stop();
      return;
    }
    if (mic !== 'idle' || busy) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported(m));
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = async () => {
        if (stopTimer.current) window.clearTimeout(stopTimer.current);
        stream.getTracks().forEach((t) => t.stop());
        setMic('transcribing');
        try {
          const q = await api.transcribe(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
          setMic('idle');
          setText(q);
          await wait(450); // let the transcript land in the box before it is sent
          ask(q);
        } catch (e) {
          setMic('idle');
          setMicError(e instanceof Error ? e.message : 'Voice input failed');
          inputRef.current?.focus();
        }
      };
      recorder.current = rec;
      rec.start();
      setMic('recording');
      stopTimer.current = window.setTimeout(() => rec.state === 'recording' && rec.stop(), MAX_RECORDING_MS);
    } catch {
      setMicError('No microphone access. Type your question instead.');
      inputRef.current?.focus();
    }
  }

  const empty = turns.length === 0;

  return (
    <div className="h-full flex flex-col bg-white">
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 pt-16 pb-48 space-y-12">
          {turns.map((t, i) => (
            <TurnView key={t.id} turn={t} latest={i === turns.length - 1} tasks={tasks} onChange={onChange} />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* composer */}
      <div className="fixed inset-x-0 bottom-0 pointer-events-none">
        <div className="h-24 bg-gradient-to-t from-white to-transparent" />
        <div className="bg-white pb-10 pointer-events-auto">
          <div className="max-w-3xl mx-auto px-6">
            {empty && <p className="text-center text-slate-400 text-[15px] mb-4">Ask anything about SD Worx knowledge. TrustLayer checks every source.</p>}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                ask(text);
              }}
              className={`flex items-center gap-2 rounded-3xl border bg-white pl-6 pr-2 py-2 shadow-[0_4px_24px_rgba(15,23,42,0.08)] transition ${
                mic === 'recording' ? 'border-accent/60' : 'border-slate-200 focus-within:border-slate-300'
              }`}
            >
              <input
                ref={inputRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={500}
                disabled={mic !== 'idle'}
                placeholder={mic === 'recording' ? 'Listening…' : mic === 'transcribing' ? 'Transcribing…' : 'Ask a question'}
                className="flex-1 bg-transparent outline-none text-[17px] text-slate-800 placeholder:text-slate-400 py-2"
                autoFocus
              />
              <button
                type="button"
                onClick={toggleMic}
                aria-label={mic === 'recording' ? 'Stop recording' : 'Ask with your voice'}
                className={`relative w-11 h-11 rounded-full flex items-center justify-center transition ${
                  mic === 'recording' ? 'bg-accent text-white' : 'text-slate-500 hover:bg-slate-100'
                }`}
              >
                {mic === 'recording' && <span className="absolute inset-0 rounded-full bg-accent/40 animate-ping" />}
                {mic === 'transcribing' ? <Spinner /> : <MicIcon />}
              </button>
              <button
                type="submit"
                disabled={!text.trim() || busy || mic !== 'idle'}
                aria-label="Send"
                className="w-11 h-11 rounded-full bg-navy text-white flex items-center justify-center disabled:bg-slate-200 disabled:text-slate-400 transition"
              >
                <ArrowIcon />
              </button>
            </form>
            <div className="mt-3 h-5 text-center text-[13px]">
              {micError ? (
                <span className="text-amber-600">{micError}</span>
              ) : (
                <span className="text-slate-400">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1.5 align-middle" />
                  TrustLayer MCP connected
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TurnView({ turn, latest, tasks, onChange }: { turn: Turn; latest: boolean; tasks: Task[]; onChange: () => void }) {
  const v = turn.verdict;
  return (
    <div className="space-y-5 animate-[fadein_.35s_ease-out]">
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl bg-slate-100 px-5 py-3 text-[16px] text-slate-800">{turn.question}</div>
      </div>

      <div className="space-y-1.5">
        <ToolLine pending={turn.step === 'assistant'} label="SD Worx Assistant" detail={turn.step === 'assistant' ? 'searching documents…' : `returned ${turn.docs} documents`} />
        {turn.step !== 'assistant' && (
          <ToolLine
            pending={turn.step === 'verify'}
            label="trustlayer › verify_sources"
            detail={turn.step === 'verify' ? 'checking owner, freshness, scope…' : v ? `${v.sources.length} sources scored` : 'failed'}
          />
        )}
      </div>

      {turn.error && <p className="text-[15px] text-accent">{turn.error}</p>}
      {v && <VerdictView v={v} compact={!latest} tasks={tasks} onChange={onChange} />}
    </div>
  );
}

function ToolLine({ pending, label, detail }: { pending: boolean; label: string; detail: string }) {
  return (
    <div className={`flex items-center gap-2 text-[14px] ${pending ? 'text-slate-500 animate-pulse' : 'text-slate-400'}`}>
      <span className="w-4 text-center">{pending ? '◌' : '✓'}</span>
      <span className="font-mono text-[13px] text-slate-500">{label}</span>
      <span>· {detail}</span>
    </div>
  );
}

function VerdictView({ v, compact, tasks, onChange }: { v: Verdict; compact: boolean; tasks: Task[]; onChange: () => void }) {
  const rec = v.recommended;
  const conflict = v.conflicts[0];
  return (
    <div className="space-y-5">
      <div className="flex items-start gap-6">
        <p className={`flex-1 leading-relaxed text-slate-900 ${compact ? 'text-[16px]' : 'text-[20px]'}`}>{v.answer}</p>
        {rec && (
          <div className="text-right shrink-0">
            <div className={`font-semibold tabular-nums leading-none ${compact ? 'text-2xl' : 'text-4xl'} ${scoreText(rec.score)}`}>{rec.score}</div>
            <div className="text-[12px] text-slate-400 mt-1">trust</div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-[14px]">
        {v.verified ? (
          <span className="rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 px-3 py-1 font-medium">
            ✓ Verified by {rec?.owner?.name ?? 'owner'} · {fmtDate(rec?.last_verified ?? v.generated_at)}
          </span>
        ) : (
          <span className="rounded-full bg-amber-50 text-amber-700 border border-amber-200 px-3 py-1 font-medium">Not verified yet</span>
        )}
        <span className="text-slate-400">{v.answer_basis}</span>
      </div>

      {conflict && (
        <div className="flex items-center gap-3 text-[15px]">
          <span className="w-1 self-stretch rounded bg-accent" />
          <span className="text-accent font-medium">Conflict</span>
          <span className="text-slate-600">
            {conflict.sides.length} sources disagree: {conflict.values.join(' vs ')}
          </span>
        </div>
      )}

      {!compact && (
        <>
          <div className="divide-y divide-slate-100 border-y border-slate-100">
            {v.sources.map((s) => (
              <SourceRow key={s.page_id ?? s.title} s={s} askedCountry={v.context.country} />
            ))}
          </div>
          <OwnerAction v={v} tasks={tasks} onChange={onChange} />
        </>
      )}
    </div>
  );
}

function SourceRow({ s, askedCountry }: { s: SourceVerdict; askedCountry?: string }) {
  const superseded = s.flags.includes('superseded');
  const tags: { label: string; tone: 'good' | 'warn' | 'bad' | 'info' }[] = [];
  if (!s.from_assistant) tags.push({ label: 'Found by TrustLayer', tone: 'info' });
  if (superseded) tags.push({ label: 'Superseded', tone: 'bad' });
  else if (s.flags.includes('verified')) tags.push({ label: 'Verified', tone: 'good' });
  if (s.flags.includes('scope mismatch')) tags.push({ label: `${s.country ?? '?'} ≠ ${askedCountry ?? '?'}`, tone: 'bad' });
  if (s.flags.includes('orphan') && !superseded) tags.push({ label: 'No owner', tone: 'bad' });
  if (s.flags.includes('unverified change') && !superseded) tags.push({ label: 'Unverified change', tone: 'warn' });
  const tone = { good: 'text-emerald-700 bg-emerald-50', warn: 'text-amber-700 bg-amber-50', bad: 'text-red-700 bg-red-50', info: 'text-brand bg-brand-50' };
  return (
    <div className={`flex items-start gap-5 py-3.5 ${superseded ? 'opacity-50' : ''}`}>
      <div className={`w-10 text-right text-[18px] font-semibold tabular-nums ${scoreText(s.score)}`}>{s.score}</div>
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] text-slate-800 font-medium truncate">{s.title}</span>
          {s.claim && <span className="text-[14px] text-slate-500">· {s.claim.value}</span>}
          {tags.map((t) => (
            <span key={t.label} className={`rounded-full px-2 py-0.5 text-[12px] font-medium ${tone[t.tone]}`}>
              {t.label}
            </span>
          ))}
        </div>
        <div className="text-[13px] text-slate-400 mt-0.5 truncate">
          {s.origin ? ORIGIN[s.origin] : 'Unknown'} · {s.reasons[0]}
        </div>
      </div>
    </div>
  );
}

function OwnerAction({ v, tasks, onChange }: { v: Verdict; tasks: Task[]; onChange: () => void }) {
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const owner = v.owner_to_ask;
  if (!owner || !v.topic || (v.verified && !v.conflicts.length)) return null;
  const open =
    v.open_task ??
    tasks.find((t) => t.status === 'open' && t.topic === v.topic!.id && (t.country ?? undefined) === v.context.country) ??
    null;

  if (sent || open)
    return (
      <p className="text-[14px] text-slate-500">
        ✓ Sent to {owner.name}
        {owner.name.endsWith('s') ? "'" : "'s"} inbox · you'll get the verified answer once they confirm
      </p>
    );

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={async () => {
          setErr(null);
          try {
            const note = `Customer on the line: ${v.question}`;
            await api.flag(v.topic!.id, v.conflicts.length ? 'conflict' : 'capture', note, cleanContext(v.context), CALL_AGENT);
            setSent(true);
            onChange();
          } catch (e) {
            setErr(e instanceof Error ? e.message : 'Could not send');
          }
        }}
        className="rounded-full border border-slate-300 px-4 py-1.5 text-[14px] text-slate-700 hover:border-navy hover:text-navy transition"
      >
        Ask {owner.name}
      </button>
      <span className="text-[13px] text-slate-400">{v.owner_reason}</span>
      {err && <span className="text-[13px] text-accent">{err}</span>}
    </div>
  );
}

function MicIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="relative">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 17v4" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  );
}

function Spinner() {
  return <span className="w-5 h-5 rounded-full border-2 border-slate-300 border-t-slate-600 animate-spin" />;
}
