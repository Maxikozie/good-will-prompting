import { z } from 'zod';
import { LIMITS } from './limits';
const text = z.string().min(1).max(4096);
const secret = z.string().min(1).max(32_768);
const integer = (max: number) => z.string().max(12).regex(/^\d+$/).transform(Number).pipe(z.number().int().positive().max(max));
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).optional(), PORT: integer(65535).optional(), HOST: text.optional(),
  TRUSTLAYER_NOW: z.string().max(40).datetime({ offset: true }).optional(), TRUSTLAYER_VAULT_DIR: text.optional(),
  TRUSTLAYER_MCP_SESSION: secret.optional(), TRUSTLAYER_MCP_VAULT_READERS: secret.optional(),
  DATABASE_URL: text.url().optional(), BRAIN_PGLITE_DIR: text.optional(), BRAIN_PARSE_ROWS: z.enum(['0', '1']).optional(),
  BRAIN_LLM_PROVIDER: z.enum(['ollama', 'anthropic', 'fake']).optional(), BRAIN_EMBEDDER: z.enum(['ollama', 'fake']).optional(),
  BRAIN_LLM_FIXTURES: text.optional(), BRAIN_LLM_TIMEOUT_MS: integer(LIMITS.llmTimeoutMs).optional(),
  OLLAMA_HOST: text.url().optional(), OLLAMA_MODEL: text.optional(), OLLAMA_EMBED_MODEL: text.optional(),
  ANTHROPIC_API_KEY: secret.optional(), ANTHROPIC_MODEL: text.optional(), ELEVENLABS_API_KEY: secret.optional(), GOOGLE_CLOUD_PROJECT: text.optional(),
  BRAIN_JWT_KEYS: secret.optional(), BRAIN_JWT_ACTIVE_KID: text.optional(), BRAIN_JWT_ISSUER: text.optional(), BRAIN_JWT_AUDIENCE: text.optional(),
  BRAIN_MOCK_OIDC_KEYS: secret.optional(), BRAIN_MOCK_OIDC_ACTIVE_KID: text.optional(), BRAIN_MOCK_OIDC_ISSUER: text.optional(), BRAIN_MOCK_OIDC_AUDIENCE: text.optional(),
}).strict();
/** Process environments include OS/tool variables. Validate ALL application-owned names,
 * including unknown names, rather than silently projecting them away. Empty optional placeholders mean unset. */
export function parseEnv(env: NodeJS.ProcessEnv = process.env) {
  const relevant = Object.fromEntries(Object.entries(env).filter(([k]) =>
    k in EnvSchema.shape || ['BRAIN_', 'TRUSTLAYER_', 'OLLAMA_', 'ANTHROPIC_', 'ELEVENLABS_'].some((prefix) => k.startsWith(prefix)))
    .map(([k, v]) => [k, v === '' ? undefined : v]));
  const parsed = EnvSchema.safeParse(relevant);
  if (!parsed.success) throw new Error(`Invalid environment configuration (${parsed.error.issues.map((i) => i.path.join('.') || 'unknown variable').join(', ')})`);
  return parsed.data;
}
