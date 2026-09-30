import type { Person, SourceVerdict, Task, Verdict } from '../../../../src/core/types';
import { fmtDate, scoreText } from '../../ui';
import type { Turn } from './types';
import EmailOwner from './EmailOwner';

const ORIGIN: Record<string, string> = { sharepoint: 'SharePoint', teams: 'Teams', outlook: 'Outlook', internal: 'TrustLayer wiki' };

export default function TurnView({
  turn,
  latest,
  tasks,
  people,
  onChange,
  onAskAgain,
}: {
  turn: Turn;
  latest: boolean;
  tasks: Task[];
  people: Person[];
  onChange: () => void;
  onAskAgain: () => void;
}) {
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
      {v && <VerdictView v={v} compact={!latest} tasks={tasks} people={people} onChange={onChange} onAskAgain={onAskAgain} />}
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

function VerdictView({
  v,
  compact,
  tasks,
  people,
  onChange,
  onAskAgain,
}: {
  v: Verdict;
  compact: boolean;
  tasks: Task[];
  people: Person[];
  onChange: () => void;
  onAskAgain: () => void;
}) {
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
          <EmailOwner v={v} tasks={tasks} people={people} onChange={onChange} onAskAgain={onAskAgain} />
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

