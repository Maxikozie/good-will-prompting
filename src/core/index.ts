import { ingest } from './ingest';
import { lintVault } from './health';
import { vaultExists } from './vault';

export * from './types';
export { buildVerdict } from './trust';
export { knowledgeHealth, lintVault } from './health';
export { flagForOwner, resolveTask, TaskError } from './tasks';
export { findExpert } from './expert';
export { existingAssistant } from './assistant';
export { ingest } from './ingest';
export { listPages, getPage, getRaw, loadTasks, getTask } from './vault';
export { loadOrg } from './org';

/** Build the vault from data/mock on first run. */
export function ensureVault(): void {
  if (!vaultExists()) {
    const { pages } = ingest();
    lintVault();
    console.error(`[trustlayer] vault built from mock sources: ${pages} pages`);
  }
}

/** Demo reset: rebuild wiki + tasks + query log from the mock sources. */
export function resetVault(): { pages: number } {
  const r = ingest();
  lintVault();
  return r;
}
