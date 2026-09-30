import type { z } from 'zod';
import type { PartialScope, Scope } from '../domain';
import { loadPrompt, renderPrompt, type PromptId } from './prompts';
import {
  ComposeOutputSchema,
  ExtractOutputSchema,
  IntakeOutputSchema,
  RelationOutputSchema,
  type ComposeOutput,
  type ExtractOutput,
  type IntakeOutput,
  type RelationOutput,
} from './schemas';
import type { CompleteOpts, LLMProvider, Message } from './types';

/**
 * A fully rendered model call. Pipeline stages and the fixture recorder both build calls through these functions,
 * so they produce byte-identical messages (and therefore the same input hash and the same fixture).
 */
export interface Task<T> {
  promptId: PromptId;
  schema: z.ZodType<T>;
  messages: Message[];
  opts: CompleteOpts<T>;
}

export const runTask = <T>(provider: LLMProvider, task: Task<T>): Promise<T> => provider.completeJSON(task.schema, task.messages, task.opts);

function task<T>(promptId: PromptId, schema: z.ZodType<T>, vars: Record<string, string>, check?: (v: T) => string | null): Task<T> {
  const tpl = loadPrompt(promptId);
  return { promptId, schema, messages: renderPrompt(tpl, vars), opts: { promptId, promptVersion: tpl.version, ...(check ? { check } : {}) } };
}

const json = (v: unknown) => JSON.stringify(v ?? {});

export interface KnownSubject {
  subject: string;
  label: string;
}

export function intakeTask(question: string, subjects: readonly KnownSubject[]): Task<IntakeOutput> {
  const list = subjects.length ? subjects.map((s) => `- ${s.subject}: ${s.label}`).join('\n') : '(none)';
  return task('intake', IntakeOutputSchema, { question, subjects: list });
}

export interface EvidenceExtractInput {
  title: string;
  sourceSystem: string;
  declaredScope: PartialScope;
  passage: string;
}
export interface ReferenceExtractInput {
  title: string;
  space: string;
  headingPath: readonly string[];
  declaredScope: PartialScope;
  section: string;
}

/** Whitespace-insensitive check that every quote really occurs in the source text (anti-hallucination, SPEC §5 stage 20). */
export function verbatimQuotes(sourceText: string): (o: ExtractOutput) => string | null {
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
  const hay = squash(sourceText);
  return (o) => {
    const bad = o.claims.filter((c) => !hay.includes(squash(c.quote)));
    return bad.length ? `These quotes are not verbatim in the text: ${bad.map((c) => JSON.stringify(c.quote.slice(0, 80))).join(', ')}. Copy quotes character for character.` : null;
  };
}

export function extractEvidenceTask(i: EvidenceExtractInput, opts: { verbatim?: boolean } = {}): Task<ExtractOutput> {
  return task('extract-evidence', ExtractOutputSchema, { title: i.title, source: i.sourceSystem, declared_scope: json(i.declaredScope), passage: i.passage }, opts.verbatim ? verbatimQuotes(i.passage) : undefined);
}

export function extractReferenceTask(i: ReferenceExtractInput, opts: { verbatim?: boolean } = {}): Task<ExtractOutput> {
  return task('extract-reference', ExtractOutputSchema, { title: i.title, source: i.space, headings: i.headingPath.join(' > '), declared_scope: json(i.declaredScope), passage: i.section }, opts.verbatim ? verbatimQuotes(i.section) : undefined);
}

export interface RelationSide {
  scope: PartialScope | Scope;
  valueRaw: string;
  quote: string;
}

export function relationTask(subject: string, attribute: string, a: RelationSide, b: RelationSide): Task<RelationOutput> {
  return task('relation-classify', RelationOutputSchema, {
    subject, attribute, scope_a: json(a.scope), value_a: a.valueRaw, quote_a: a.quote, scope_b: json(b.scope), value_b: b.valueRaw, quote_b: b.quote,
  });
}

export interface ComposeFact {
  factId: string;
  slot?: string;
  status: string;
  value: string;
  quote: string;
}

export function composeTask(question: string, facts: readonly ComposeFact[]): Task<ComposeOutput> {
  return task('compose', ComposeOutputSchema, { question, facts: facts.map((f) => JSON.stringify(f)).join('\n') });
}
