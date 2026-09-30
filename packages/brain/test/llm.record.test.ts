import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  FakeProvider,
  JsonProvider,
  LLMValidationError,
  MissingFixtureError,
  RecordingProvider,
  extractEvidenceTask,
  extractReferenceTask,
  fixtureFileName,
  inputHash,
  intakeTask,
  relationCandidates,
  runTask,
  type ClaimRef,
  type CompleteOpts,
  type Fixture,
  type LLMProvider,
  type Message,
} from '../src/llm';
import { DEMO_QUESTION, loadSubjects, recordDemo } from '../src/llm/record';
import { loadDemo } from '../src/store/seed';

const demo = loadDemo();

/** Stands in for a real model: a fixed, schema-valid answer per prompt, quotes copied verbatim from the passage. */
class StubModel implements LLMProvider {
  readonly modelId = 'stub-model';
  calls = 0;
  async completeJSON<T>(schema: z.ZodType<T>, messages: readonly Message[], opts: CompleteOpts<T>): Promise<T> {
    this.calls++;
    const user = messages.at(-1)!.content;
    let answer: unknown;
    if (opts.promptId === 'intake') {
      answer = { subject: 'leave.small_leave.own_marriage', matchesKnownSubject: true, scope: { country: 'BE', jointCommittee: 'PC 200', employeeCategory: 'bediende' }, questionType: 'rule', proposedSlots: [] };
    } else if (opts.promptId === 'relation-classify') {
      answer = { relation: 'contradict', explanation: 'De waarden verschillen.' };
    } else {
      const body = user.slice(user.indexOf('---\n') + 4, user.indexOf('</document>')).trim();
      const heading = body.match(/^#+ (.+)$/m)?.[1] ?? 'intro';
      const line = body.split('\n').find((l) => l.trim() && !l.startsWith('#'))!.trim().slice(0, 100);
      answer = { claims: [{ quote: line, subject: 'demo.leave', attribute: heading.toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_|_$/g, '') || 'intro', valueRaw: line, qualifiers: { country: 'BE', conditions: [] }, temporal: {}, polarity: 'affirms', modality: 'rule', confidence: 0.9 }] };
    }
    const parsed = schema.parse(answer);
    const problem = opts.check?.(parsed);
    if (problem) throw new Error(`stub produced an invalid answer: ${problem}`);
    return parsed;
  }
}

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-fixtures-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const listFixtures = () => fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) => fs.readdirSync(path.join(dir, d.name)).map((f) => path.join(d.name, f)));

describe('fixture recorder', () => {
  const totalExtractions = demo.evidence.reduce((n, e) => n + e.passages.length, 0) + demo.reference.reduce((n, r) => n + r.sections.length, 0);

  it('records intake, every passage/section extraction and the relation pairs to disk', async () => {
    const model = new StubModel();
    const report = await recordDemo({ provider: model, outDir: dir });
    expect(report.intake).toBe(1);
    expect(report.extractions).toBe(totalExtractions);
    expect(totalExtractions).toBe(35);
    expect(report.relations).toBeGreaterThan(0);
    expect(report.written).toBe(1 + totalExtractions + report.relations);
    expect(report.reused).toBe(0);
    expect(model.calls).toBe(report.written);
    expect(listFixtures()).toHaveLength(report.written);

    const sample = JSON.parse(fs.readFileSync(path.join(dir, listFixtures().find((f) => f.startsWith('intake'))!), 'utf8')) as Fixture;
    expect(sample).toMatchObject({ promptId: 'intake', promptVersion: 'v1', model: 'stub-model' });
    expect(sample.inputHash).toHaveLength(64);
    expect(sample.messages[1]!.content).toContain(DEMO_QUESTION);
  });

  it('is idempotent: a second run reuses every fixture and never calls the model', async () => {
    const before = listFixtures();
    const mtimes = before.map((f) => fs.statSync(path.join(dir, f)).mtimeMs);
    const model = new StubModel();
    const report = await recordDemo({ provider: model, outDir: dir });
    expect(model.calls).toBe(0);
    expect(report.written).toBe(0);
    expect(report.reused).toBe(before.length);
    expect(before.map((f) => fs.statSync(path.join(dir, f)).mtimeMs)).toEqual(mtimes);
  });

  it('--force re-records everything', async () => {
    const model = new StubModel();
    const report = await recordDemo({ provider: model, outDir: dir, force: true });
    expect(report.written).toBe(listFixtures().length);
    expect(model.calls).toBe(report.written);
  });

  it('what was recorded replays through the FakeProvider, byte for byte', async () => {
    const fake = FakeProvider.fromDir(dir);
    expect(fake.size).toBe(listFixtures().length);
    const intake = await runTask(fake, intakeTask(DEMO_QUESTION, loadSubjects()));
    expect(intake).toMatchObject({ subject: 'leave.small_leave.own_marriage', scope: { country: 'BE' } });
    for (const e of demo.evidence) {
      for (const p of e.passages) {
        const out = await runTask(fake, extractEvidenceTask({ title: e.document.title, sourceSystem: e.document.sourceSystem, declaredScope: e.document.declaredScope, passage: p.text }, { verbatim: true }));
        expect(out.claims).toHaveLength(1);
        expect(p.text).toContain(out.claims[0]!.quote);
      }
    }
    for (const r of demo.reference) {
      for (const s of r.sections) {
        const out = await runTask(fake, extractReferenceTask({ title: r.page.title, space: r.page.space, headingPath: s.headingPath, declaredScope: r.page.declaredScope, section: s.text }, { verbatim: true }));
        expect(s.text).toContain(out.claims[0]!.quote);
      }
    }
  });

  it('a changed prompt input is a MissingFixtureError, not a silent default', async () => {
    const fake = FakeProvider.fromDir(dir);
    const e = demo.evidence[0]!;
    const task = extractEvidenceTask({ title: e.document.title, sourceSystem: e.document.sourceSystem, declaredScope: e.document.declaredScope, passage: `${e.passages[0]!.text} (edited)` }, { verbatim: true });
    await expect(runTask(fake, task)).rejects.toThrow(MissingFixtureError);
  });

  it('refuses to record an answer that fails the verbatim check (real providers retry, then fail; nothing is written)', async () => {
    const hallucinating = new (class extends JsonProvider {
      readonly modelId = 'hallucinator';
      protected async raw(): Promise<string> {
        return JSON.stringify({ claims: [{ quote: 'iets dat er niet staat', subject: 'a.b', attribute: 'x', valueRaw: '1', qualifiers: { conditions: [] }, temporal: {}, polarity: 'affirms', modality: 'rule', confidence: 1 }] });
      }
    })();
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-fixtures-bad-'));
    try {
      const rec = new RecordingProvider(hallucinating, otherDir);
      const e = demo.evidence[0]!;
      const task = extractEvidenceTask({ title: e.document.title, sourceSystem: e.document.sourceSystem, declaredScope: e.document.declaredScope, passage: e.passages[0]!.text }, { verbatim: true });
      await expect(runTask(rec, task)).rejects.toThrow(LLMValidationError);
      expect(rec.written).toBe(0);
      expect(fs.readdirSync(otherDir)).toEqual([]);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('fixture file names derive from prompt id + input hash', () => {
    const msgs: Message[] = [{ role: 'user', content: 'x' }];
    expect(fixtureFileName('intake', inputHash(msgs))).toBe(path.join('intake', `${inputHash(msgs).slice(0, 16)}.json`));
  });
});

describe('relationCandidates', () => {
  const c = (sourceId: string, valueRaw: string, over: Partial<ClaimRef> = {}): ClaimRef => ({ sourceId, subject: 's', attribute: 'timing_window', valueRaw, scope: { country: 'BE' }, quote: valueRaw, ...over });

  it('pairs only text values that differ, across sources, same subject and attribute', () => {
    const pairs = relationCandidates([
      c('ev-A', 'tussen 1 week voor en 4 weken na het huwelijk'),
      c('ev-B', 'binnen de maand na het huwelijk'),
      c('ev-A', 'nog een tekst'), // same source as the first: never paired with it
      c('ev-C', '2 dagen'), // number: decided by code, not the LLM
      c('ev-D', '3 dagen'),
      c('ev-E', 'iets', { attribute: 'other' }), // other attribute
      c('ev-F', 'tussen 1 week voor en 4 weken na het huwelijk'), // identical text to A
    ]);
    expect(pairs.map(([a, b]) => `${a.sourceId}-${b.sourceId}`)).toEqual([
      'ev-A-ev-B', // A's 2nd claim vs B
      'ev-A-ev-F', // A's 2nd claim vs F
      'ev-A-ev-B', // A's 1st claim vs B
      'ev-B-ev-F',
    ]); // A's 1st claim vs F is skipped (identical text), A vs A never pairs
  });

  it('is stable (sorted, A < B) and capped', () => {
    const many = Array.from({ length: 12 }, (_, i) => c(`ev-${String.fromCharCode(65 + i)}`, `tekst ${'x'.repeat(i + 1)} woord`));
    const a = relationCandidates(many, 10);
    const b = relationCandidates([...many].reverse(), 10);
    expect(a).toHaveLength(10);
    expect(b.map(([x, y]) => `${x.sourceId}|${y.sourceId}`)).toEqual(a.map(([x, y]) => `${x.sourceId}|${y.sourceId}`));
    for (const [x, y] of a) expect(x.sourceId <= y.sourceId).toBe(true);
  });
});
