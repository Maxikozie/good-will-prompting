import { useEffect, useRef, useState } from 'react';
import type { HealthReport, Person, Task } from '../../../src/core/types';
import { scoreText } from '../ui';
import RadarPanel from './RadarPanel';
import TurnView from '../features/ask/TurnView';
import { useConversation } from '../features/ask/useConversation';
import { useVoiceInput } from '../features/ask/useVoiceInput';
import { RadarIcon, MailIcon, ResetIcon, MicIcon, ArrowIcon, Spinner } from '../features/ask/icons';

export default function Ask({
  rerun,
  tasks,
  people,
  health,
  delta,
  onChange,
  onOpenMail,
  onReset,
}: {
  rerun: number;
  tasks: Task[];
  people: Person[];
  health: HealthReport | null;
  delta: number | null;
  onChange: () => void;
  onOpenMail: () => void;
  onReset: () => void;
}) {
  const [radar, setRadar] = useState(false);
  const waiting = tasks.filter((t) => t.status === 'open').length;
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const { turns, busy, ask } = useConversation(rerun, () => setText(''));
  const { mic, micError, toggleMic } = useVoiceInput({ busy, onTranscript: setText, onQuestion: ask, onError: () => inputRef.current?.focus() });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

  const empty = turns.length === 0;

  return (
    <div className="h-full flex flex-col bg-white">
      {/* quiet corner: radar (with live health score), mail, reset */}
      <nav className="fixed top-5 right-6 z-10 flex items-center gap-1">
        <button onClick={() => setRadar(true)} title="Knowledge health radar" className="h-10 px-3 rounded-full flex items-center gap-2 text-slate-400 hover:bg-slate-50 hover:text-slate-700">
          <RadarIcon />
          {health && <span className={`text-[14px] font-medium tabular-nums ${scoreText(health.score)}`}>{health.score}</span>}
          {delta ? <span className="text-[12px] text-emerald-600">▲{delta}</span> : null}
        </button>
        <button onClick={onOpenMail} title="Mail" className="relative w-10 h-10 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-50 hover:text-slate-700">
          <MailIcon />
          {waiting ? <span className="absolute top-1 right-1 min-w-4 h-4 px-1 rounded-full bg-accent text-white text-[10px] leading-4 text-center">{waiting}</span> : null}
        </button>
        <button onClick={onReset} title="Reset demo" className="w-10 h-10 rounded-full flex items-center justify-center text-slate-300 hover:bg-slate-50 hover:text-slate-600">
          <ResetIcon />
        </button>
      </nav>
      {radar && <RadarPanel health={health} delta={delta} tasks={tasks} people={people} onChange={onChange} onClose={() => setRadar(false)} />}

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 pt-16 pb-48 space-y-12">
          {turns.map((t, i) => (
            <TurnView key={t.id} turn={t} latest={i === turns.length - 1} tasks={tasks} people={people} onChange={onChange} onAskAgain={() => ask(t.question)} />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* composer */}
      <div className="fixed inset-x-0 bottom-0 pointer-events-none">
        <div className="h-24 bg-gradient-to-t from-white to-white/0" />
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
