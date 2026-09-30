import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db } from '../store/db';
import { LIMITS } from './limits';
import { ResourceError } from './errors';

interface BudgetContext { db: Db; runId: string; principal: string }
const budgetContext = new AsyncLocalStorage<BudgetContext>();
export function withBudget<T>(context: BudgetContext, operation: () => Promise<T>): Promise<T> { return budgetContext.run(context, operation); }
const local = new Map<string, { calls: number; tokens: number }>();
/** Token reservation is conservative: one UTF-8 byte per input token + configured maximum output.
 * It never trusts model-reported usage. Charge BEFORE sending, also for failures and each retry. */
export async function reserveModelCall(input: readonly string[], outputTokens = LIMITS.outputTokens): Promise<void> {
  const tokens = input.reduce((n, s) => n + Buffer.byteLength(s), 0) + outputTokens;
  const context = budgetContext.getStore();
  const hour = Math.floor(Date.now() / 3_600_000);
  if (!context) {
    // Operator-only CLI/provider calls have no application caller/run; retain a bounded local hourly ceiling.
    const key = String(hour);
    for (const previous of local.keys()) if (previous !== key) local.delete(previous);
    const usage = local.get(key) ?? { calls: 0, tokens: 0 };
    if (usage.calls + 1 > LIMITS.modelCallsPerPrincipalHour || usage.tokens + tokens > LIMITS.modelTokensPerPrincipalHour) throw new ResourceError(429, 'Model budget exceeded');
    usage.calls++; usage.tokens += tokens; local.set(key, usage);
    return;
  }
  await context.db.transaction(async (tx) => {
    for (const [scope, key, maxCalls, maxTokens] of [
      ['principal_hour', JSON.stringify([context.principal, hour]), LIMITS.modelCallsPerPrincipalHour, LIMITS.modelTokensPerPrincipalHour],
      ['run', context.runId, LIMITS.modelCallsPerRun, LIMITS.modelTokensPerRun],
    ] as const) {
      if (tokens > maxTokens) throw new ResourceError(429, 'Model budget exceeded');
      const result = await tx.query(`INSERT INTO brain.resource_usage (scope,key,calls,tokens) VALUES ($1,$2,1,$3)
        ON CONFLICT (scope,key) DO UPDATE SET calls = brain.resource_usage.calls + 1, tokens = brain.resource_usage.tokens + $3
        WHERE brain.resource_usage.calls + 1 <= $4 AND brain.resource_usage.tokens + $3 <= $5 RETURNING calls`, [scope, key, tokens, maxCalls, maxTokens]);
      if (!result.rows.length) throw new ResourceError(429, 'Model budget exceeded');
    }
  });
}
