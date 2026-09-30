import path from 'node:path';
import { readYaml, allowedFile } from '../security/input';
import { z } from 'zod';

export const EnrichmentConfigSchema = z.object({
  version: z.number().int(),
  budgets: z.object({
    maxQueriesPerGap: z.number().int().min(1).max(10),
    maxQueriesPerRun: z.number().int().min(1).max(100),
    topK: z.number().int().min(1).max(50),
    overFetch: z.number().int().min(1).max(20),
    maxLinkHops: z.number().int().min(0).max(3),
  }).strict(),
  subjects: z.record(z.string(), z.object({ terms: z.array(z.string()).min(1) }).strict()),
  attributes: z.record(z.string(), z.array(z.string()).min(1)),
  countries: z.record(z.string(), z.array(z.string()).min(1)),
}).strict();
export type EnrichmentConfig = z.infer<typeof EnrichmentConfigSchema>;

export const ENRICHMENT_FILE = path.resolve(import.meta.dirname, '..', '..', 'rules', 'enrichment.yaml');

let cached: EnrichmentConfig | undefined;
export function loadEnrichmentConfig(file = ENRICHMENT_FILE): EnrichmentConfig {
  if (file === ENRICHMENT_FILE && cached) return cached;
  const cfg = readYaml(allowedFile(file, '.yaml'), EnrichmentConfigSchema);
  if (file === ENRICHMENT_FILE) cached = cfg;
  return cfg;
}
