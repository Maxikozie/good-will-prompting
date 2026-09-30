import { AssistantFixtureSchema } from './input-schemas';
import { readJson } from '../../packages/brain/src/security/input';
import fs from 'node:fs';
import path from 'node:path';
import type { InputSource } from './types';
import { detectCountry, detectTopic } from './org';
import { MOCK_DIR, tokens } from './util';
import { listPages } from './vault';

// MOCK: "the existing SD Worx assistant". Returns bare documents with a relevance score and no trust metadata,
// exactly like today. Canned answer for the demo question, naive keyword search for everything else.

export interface AssistantResult extends InputSource {
  title: string;
  snippet: string;
  relevance: number;
}

interface Fixture {
  assistant: string;
  topic: string;
  country?: string;
  results: AssistantResult[];
}

function fixtures(): Fixture[] {
  const dir = path.join(MOCK_DIR, 'existing-assistant');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(dir, f), AssistantFixtureSchema));
}

export function existingAssistant(question: string): { assistant: string; results: AssistantResult[] } {
  const topic = detectTopic(question)?.id;
  const country = detectCountry(question);
  const hit = fixtures().find((f) => f.topic === topic && (!f.country || !country || f.country === country));
  if (hit) return { assistant: hit.assistant, results: hit.results };

  const q = new Set(tokens(question).filter((t) => t.length > 3));
  const results = listPages()
    .filter((p) => p.origin === 'sharepoint') // it only indexes SharePoint, not Teams or mail
    .map((p) => ({ p, s: tokens(`${p.title} ${p.body}`).filter((t) => q.has(t)).length }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map(({ p, s }) => ({
      id: p.id,
      title: p.title,
      location: p.location,
      snippet: p.claims[0]?.text ?? p.body.split('\n').find((l) => l && !l.startsWith('#') && !l.startsWith('>')) ?? '',
      relevance: Math.min(0.95, 0.5 + s * 0.05),
    }));
  return { assistant: 'SD Worx Knowledge Assistant', results };
}
