import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { parse } from 'yaml';
import { loadDemo, type DemoData } from '../store/seed';
import { normalizeValue, mergeScope, type PartialScope } from '../domain';
import { inputHash } from './cache';
import { fixtureFileName, type Fixture } from './fake';
import type { CompleteOpts, LLMProvider, Message } from './types';
import type { ExtractedClaim } from './schemas';
import { extractEvidenceTask, extractReferenceTask, intakeTask, relationTask, runTask, type KnownSubject } from './tasks';

/** The demo question (SPEC §14): BE, PC 200, bediende. */
export const DEMO_QUESTION = 'Hoeveel dagen klein verlet krijg ik voor mijn eigen huwelijk en wanneer moet ik ze opnemen?';

export const SLOTS_DIR = path.resolve(import.meta.dirname, '..', '..', 'slots');

export function loadSubjects(dir = SLOTS_DIR): KnownSubject[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { subject: string; label: string })
    .map((y) => ({ subject: y.subject, label: y.label }));
}

/** Wraps a real provider: answers are written as fixtures, and an existing fixture is reused instead of calling the model again. */
export class RecordingProvider implements LLMProvider {
  readonly modelId: string;
  written = 0;
  reused = 0;

  constructor(
    private readonly inner: LLMProvider,
    private readonly outDir: string,
    private readonly force = false,
  ) {
    this.modelId = inner.modelId;
  }

  async completeJSON<T>(schema: z.ZodType<T>, messages: readonly Message[], opts: CompleteOpts<T>): Promise<T> {
    const hash = inputHash(messages);
    const file = path.join(this.outDir, fixtureFileName(opts.promptId, hash));
    if (!this.force && fs.existsSync(file)) {
      const existing = JSON.parse(fs.readFileSync(file, 'utf8')) as Fixture;
      const ok = schema.safeParse(existing.response);
      if (ok.success && !opts.check?.(ok.data)) {
        this.reused++;
        return ok.data;
      }
    }
    const response = await this.inner.completeJSON(schema, messages, opts);
    const fixture: Fixture = { promptId: opts.promptId, promptVersion: opts.promptVersion, inputHash: hash, model: this.inner.modelId, messages: [...messages], response };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
    this.written++;
    return response;
  }
}

export interface ClaimRef {
  sourceId: string;
  subject: string;
  attribute: string;
  valueRaw: string;
  scope: PartialScope;
  quote: string;
}

/**
 * Pairs of text-valued claims that the rules cannot compare on their own (numbers, dates, ranges and booleans are decided
 * by deterministic code): same subject + attribute, different sources, different normalized text. Sorted and capped so the
 * set of relation-classify calls (and therefore the fixtures) is stable. Pipeline stage 30 uses this same function.
 */
export function relationCandidates(claims: readonly ClaimRef[], max = 40): [ClaimRef, ClaimRef][] {
  const text = claims.filter((c) => normalizeValue(c.valueRaw).type === 'text');
  const pairs: [ClaimRef, ClaimRef][] = [];
  for (let i = 0; i < text.length; i++) {
    for (let j = i + 1; j < text.length; j++) {
      const a = text[i]!;
      const b = text[j]!;
      if (a.sourceId === b.sourceId || a.subject !== b.subject || a.attribute !== b.attribute) continue;
      if (normalizeValue(a.valueRaw).normalized === normalizeValue(b.valueRaw).normalized) continue;
      pairs.push(a.sourceId <= b.sourceId ? [a, b] : [b, a]);
    }
  }
  const key = (p: [ClaimRef, ClaimRef]) => `${p[0].sourceId}|${p[0].quote}|${p[1].sourceId}|${p[1].quote}`;
  return pairs.sort((x, y) => key(x).localeCompare(key(y))).slice(0, max);
}

export interface RecordOptions {
  provider: LLMProvider;
  outDir: string;
  demo?: DemoData;
  force?: boolean;
  maxRelationPairs?: number;
  log?: (line: string) => void;
}

export interface RecordReport {
  intake: number;
  extractions: number;
  claims: number;
  relations: number;
  written: number;
  reused: number;
}

/** Run every model call the demo scenario needs (intake, extraction of all passages/sections, relation classification) and store them as fixtures. */
export async function recordDemo(o: RecordOptions): Promise<RecordReport> {
  const log = o.log ?? (() => {});
  const demo = o.demo ?? loadDemo();
  const rec = new RecordingProvider(o.provider, o.outDir, o.force);

  await runTask(rec, intakeTask(DEMO_QUESTION, loadSubjects()));
  log('intake recorded');

  const refs: ClaimRef[] = [];
  const addClaims = (sourceId: string, declared: PartialScope, claims: ExtractedClaim[]) => {
    for (const c of claims) refs.push({ sourceId, subject: c.subject, attribute: c.attribute, valueRaw: c.valueRaw, scope: mergeScope(declared, c.qualifiers), quote: c.quote });
  };

  let extractions = 0;
  for (const e of demo.evidence) {
    for (const p of e.passages) {
      const out = await runTask(rec, extractEvidenceTask({ title: e.document.title, sourceSystem: e.document.sourceSystem, declaredScope: e.document.declaredScope, passage: p.text }, { verbatim: true }));
      addClaims(e.document.id, e.document.declaredScope, out.claims);
      extractions++;
      log(`extract-evidence ${e.document.id}#${p.ordinal}: ${out.claims.length} claims`);
    }
  }
  for (const r of demo.reference) {
    for (const s of r.sections) {
      const out = await runTask(rec, extractReferenceTask({ title: r.page.title, space: r.page.space, headingPath: s.headingPath, declaredScope: r.page.declaredScope, section: s.text }, { verbatim: true }));
      addClaims(r.page.id, r.page.declaredScope, out.claims);
      extractions++;
      log(`extract-reference ${r.page.id}#${s.ordinal}: ${out.claims.length} claims`);
    }
  }

  const pairs = relationCandidates(refs, o.maxRelationPairs);
  for (const [a, b] of pairs) {
    await runTask(rec, relationTask(a.subject, a.attribute, { scope: a.scope, valueRaw: a.valueRaw, quote: a.quote }, { scope: b.scope, valueRaw: b.valueRaw, quote: b.quote }));
    log(`relation-classify ${a.sourceId} vs ${b.sourceId} (${a.attribute})`);
  }

  return { intake: 1, extractions, claims: refs.length, relations: pairs.length, written: rec.written, reused: rec.reused };
}
