import { z } from 'zod';
import type { Principal } from './authorization';

const id = z.string().trim().min(1).max(200);
const principalSchema = z.object({
  id, personId: id,
  groups: z.array(id).max(100),
  roles: z.array(z.enum(['reader', 'contributor', 'verifier', 'admin'])).max(4),
}).strict();

export interface StdioSession {
  readonly principal: Principal;
  readonly legacyVaultReaders: readonly string[];
}

/**
 * A local stdio process inherits its OS-authenticated launcher's trusted environment.
 * This is NOT remote authentication: never reuse this process-wide identity for HTTP/SSE.
 * The host must launch a separate process/config per user. No identity fallback or mock login.
 */
export function authenticateStdio(env: NodeJS.ProcessEnv): StdioSession {
  try {
    const parsed = principalSchema.parse(JSON.parse(env.TRUSTLAYER_MCP_SESSION ?? ''));
    const readers = z.array(id).max(100).parse(JSON.parse(env.TRUSTLAYER_MCP_VAULT_READERS ?? '[]'));
    // Copy and freeze: changing process.env or client metadata cannot switch an established session.
    const principal = Object.freeze({ ...parsed, groups: Object.freeze(parsed.groups), roles: Object.freeze(parsed.roles) });
    return Object.freeze({ principal, legacyVaultReaders: Object.freeze(readers) });
  } catch {
    // Do not echo configuration or validation payloads; they may contain sensitive data.
    throw new Error('MCP stdio authentication requires valid TRUSTLAYER_MCP_SESSION and TRUSTLAYER_MCP_VAULT_READERS server configuration');
  }
}
