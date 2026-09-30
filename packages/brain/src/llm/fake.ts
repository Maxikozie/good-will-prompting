import { readJson, assertAllowedDir, isSafeFileName, resolveInside, safeFileName } from '../security/input';
import { MessagesSchema } from '../security/model';
import { reserveModelCall } from '../security/budget';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { inputHash } from './cache';
import { LLMError, MissingFixtureError } from './errors';
import { describeIssues } from './json';
import type { CompleteOpts, LLMProvider, Message } from './types';

export interface Fixture {
  promptId: string;
  promptVersion: string;
  inputHash: string;
  /** Model that produced the response (informational). */
  model: string;
  /** The exact rendered prompt, kept so fixture diffs are reviewable. */
  messages: Message[];
  response: unknown;
}

export const FixtureSchema = z.object({ promptId: z.string().max(100), promptVersion: z.string().max(100), inputHash: z.string().length(64), model: z.string().max(200), messages: MessagesSchema, response: z.unknown() }).strict();

export const fixtureFileName = (promptId: string, hash: string) => path.join(safeFileName(promptId), safeFileName(`${hash.slice(0, 16)}.json`, '.json'));

/**
 * Replays recorded answers keyed by (promptId, inputHash). No network, no model, fully deterministic.
 * A call without a fixture throws MissingFixtureError (it never guesses, never returns a default), and a fixture that
 * no longer satisfies the schema throws too: stale fixtures are loud, not silent.
 */
export class FakeProvider implements LLMProvider {
  readonly budgetsManaged = true as const;
  readonly modelId = 'fake';
  private readonly byKey = new Map<string, Fixture>();
  /** Every call made, in order (assert on it in tests). */
  readonly calls: { promptId: string; inputHash: string }[] = [];

  constructor(fixtures: readonly Fixture[] = []) {
    for (const f of fixtures) this.add(f);
  }

  static fromDir(dir: string): FakeProvider {
    const fixtures: Fixture[] = [];
    if (fs.existsSync(dir)) {
      const base = assertAllowedDir(dir);
      for (const sub of fs.readdirSync(base, { withFileTypes: true })) {
        if (!sub.isDirectory() || !isSafeFileName(sub.name)) continue;
        for (const f of fs.readdirSync(resolveInside(base, sub.name)).filter((x) => isSafeFileName(x, '.json')).sort()) {
          fixtures.push(readJson(resolveInside(base, sub.name, f), FixtureSchema));
        }
      }
    }
    return new FakeProvider(fixtures);
  }

  private static key(promptId: string, hash: string) {
    return `${promptId}\u0000${hash}`;
  }

  add(f: Fixture): void {
    this.byKey.set(FakeProvider.key(f.promptId, f.inputHash), f);
  }

  /** Convenience for unit tests: register an answer for exactly these messages. */
  register(promptId: string, messages: readonly Message[], response: unknown, promptVersion = 'test'): void {
    this.add({ promptId, promptVersion, inputHash: inputHash(messages), model: 'fake', messages: [...messages], response });
  }

  get size(): number {
    return this.byKey.size;
  }

  async completeJSON<T>(schema: z.ZodType<T>, messages: readonly Message[], opts: CompleteOpts<T>): Promise<T> {
    MessagesSchema.parse(messages);
    await reserveModelCall(messages.map((m) => m.content));
    const hash = inputHash(messages);
    this.calls.push({ promptId: opts.promptId, inputHash: hash });
    const f = this.byKey.get(FakeProvider.key(opts.promptId, hash));
    if (!f) throw new MissingFixtureError(opts.promptId, hash);
    const parsed = schema.safeParse(f.response);
    if (!parsed.success) throw new LLMError(`Fixture for "${opts.promptId}" (${hash.slice(0, 12)}) no longer matches the schema: ${describeIssues(parsed.error)}. Re-record it.`);
    const problem = opts.check?.(parsed.data);
    if (problem) throw new LLMError(`Fixture for "${opts.promptId}" (${hash.slice(0, 12)}) fails its check: ${problem}. Re-record it.`);
    return parsed.data;
  }
}
