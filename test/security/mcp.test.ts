import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pgliteDb, brainRepo, evidenceRepo, referenceRepo, edgeRepo, type Db } from '../../packages/brain/src/store';
import { seedDemo, loadDemo } from '../../packages/brain/src/store/seed';
import { ACTIONS, authorize, Forbidden, type Principal } from '../../src/security/authorization';
import { authenticateStdio } from '../../src/security/stdio-session';
import type { BrainOperations } from '../../src/mcp/brain-tools';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'trustlayer-authz-'));
process.env.TRUSTLAYER_VAULT_DIR = scratch;
process.env.TRUSTLAYER_NOW = '2026-09-30T19:00:00Z';
const { createMcpServer } = await import('../../src/mcp/server');
const core = await import('../../src/core/index');

const legacy: Principal = { id: 'user:lotte.peeters', personId: 'lotte.peeters', groups: ['group:demo'], roles: ['reader', 'contributor', 'verifier'] };
const owner: Principal = { id: 'user:sarah.peeters', personId: 'sarah.peeters', groups: ['group:payroll-be', 'group:all-staff'], roles: ['reader', 'contributor', 'verifier', 'admin'] };
const other: Principal = { id: 'user:daan.visser', personId: 'daan.visser', groups: ['group:payroll-nl'], roles: ['reader', 'contributor', 'verifier'] };
const forbidden = { isError: true, content: [{ type: 'text', text: '403 Forbidden' }] };
let db: Db;
const calls: string[] = [];
const demo = loadDemo();
const now = '2026-09-30T19:00:00Z';

const operations: BrainOperations = {
  async analyzeCase(_tx, _input, principal) { calls.push('analyze'); return { startedBy: principal.id }; },
  async getVerdict(tx, runId) { calls.push('verdict'); return { run: await brainRepo.getRun(tx, runId), facts: await brainRepo.listFacts(tx, runId) }; },
  async explainFact(tx, factId) { calls.push('fact'); return brainRepo.getFact(tx, factId); },
  // Test transport/service fixture only. No fake token verification is used by the executable server.
  async verifyToken(token) {
    if (token !== 'signed-owner-token') throw new Error('invalid token');
    return { jti: 'owner-jti', factId: 'fact-owner', verifierId: owner.personId, allowedActions: ['confirm'], expiresAt: Date.now() + 60_000 };
  },
  async submitVerification(tx, _input, principal, token) {
    calls.push('submit');
    if (!await brainRepo.burnToken(tx, token.jti)) throw new Forbidden();
    return { verifiedBy: principal.id };
  },
  async ingestReference(_tx, _input, principal) { calls.push('ingest'); return { ingestedBy: principal.id }; },
  async health() { calls.push('health'); return { score: 100 }; },
};

async function clientFor(principal: Principal, withBrain = false, database = db) {
  const server = createMcpServer({ principal, legacyVaultReaders: ['group:demo'] }, withBrain ? { db: database, operations } : undefined);
  const client = new Client({ name: 'security-regression', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
async function invoke(principal: Principal, name: string, args: Record<string, unknown>, withBrain = false, database = db) {
  const c = await clientFor(principal, withBrain, database);
  try { return await c.client.callTool({ name, arguments: args }); } finally { await c.close(); }
}
const text = (r: unknown) => JSON.stringify(r);

before(async () => {
  core.ensureVault();
  db = await pgliteDb();
  await seedDemo(db);
  await brainRepo.saveRun(db, {
    id: 'run-owner' as never, namespace: 'brain', createdAt: now, question: 'Private owner question', principalId: owner.id as never,
    intent: { subject: 'leave', scope: { country: 'BE' }, questionType: 'rule', slotTemplateId: 'leave', generatedSlots: false },
    status: 'completed', rulesVersion: '1', promptVersions: {}, modelIds: {},
    evidenceSnapshotIds: [demo.evidence[0]!.snapshot.id], referenceSnapshotIds: [], startedAt: now,
  });
  await brainRepo.saveFact(db, {
    id: 'fact-owner' as never, namespace: 'brain', createdAt: now, runId: 'run-owner' as never,
    claimKey: 'a'.repeat(40), subject: 'leave', attribute: 'duration', scope: { country: 'BE' }, status: 'LIKELY', confidence: 80,
    reasons: [], needsVerification: true, impact: 'high',
  });
  await brainRepo.saveVerificationRequest(db, {
    id: 'request-owner' as never, namespace: 'brain', createdAt: now, factId: 'fact-owner' as never, requestedFromId: owner.personId as never,
    reason: 'Private verification reason', status: 'pending', tokenJti: 'owner-jti', expiresAt: '2099-01-01T00:00:00Z',
  });
});
after(async () => { await db?.close(); fs.rmSync(scratch, { recursive: true, force: true }); });

test('stdio identity fails closed, is strict and is frozen for the session', () => {
  assert.throws(() => authenticateStdio({}));
  assert.throws(() => authenticateStdio({ TRUSTLAYER_MCP_SESSION: '{"secret":"sentinel"}' }), (err: Error) => !err.message.includes('sentinel'));
  const env = { TRUSTLAYER_MCP_SESSION: JSON.stringify(legacy), TRUSTLAYER_MCP_VAULT_READERS: '["group:demo"]' };
  const session = authenticateStdio(env);
  env.TRUSTLAYER_MCP_SESSION = JSON.stringify(other);
  assert.equal(session.principal.personId, legacy.personId);
  assert.throws(() => (session.principal.groups as string[]).push('group:admin'));
  assert.throws(() => authorize(null, 'trusted_answer', { kind: 'service' }), Forbidden);
  assert.throws(() => authorize(owner, 'made_up' as never, { kind: 'service' }), Forbidden);
  assert.throws(() => authorize(owner, 'toString' as never, { kind: 'service' }), Forbidden);
  assert.throws(() => authorize(owner, 'trusted_answer', null), Forbidden);
});

const legacyInputs: Record<string, Record<string, unknown>> = {
  verify_sources: { question: 'Sunday overtime in Belgium?', sources: [{ id: 'sp-cs-be-kb-overtime' }] },
  trusted_answer: { question: 'Sunday overtime in Belgium?' },
  knowledge_health: {},
  flag_for_owner: { topic: 'sunday-overtime-premium', issue: 'conflict', note: 'Check owner', context: { country: 'BE', client: 'Nordwind Retail' } },
  resolve: {},
  find_expert: { topic: 'Sunday overtime Belgium' },
};
for (const [name, args] of Object.entries(legacyInputs)) {
  test(`${name}: authorized session allowed; another principal gets generic 403`, async () => {
    const input = name === 'resolve' ? {
      task_id: core.flagForOwner({ topic: 'sunday-overtime-premium', issue: 'conflict', note: 'Verify', context: { country: 'BE', client: 'Nordwind Retail' } }).task.id,
      verified_claim: 'Sunday overtime is paid with a 120% premium.',
    } : args;
    assert.deepEqual(await invoke(other, name, input), forbidden);
    const result = await invoke(legacy, name, input);
    assert.notEqual(result.isError, true, text(result));
    if (name === 'resolve') {
      assert.match(text(result), /lotte.peeters/);
      const task = core.loadTasks().find((t) => t.id === input.task_id)!;
      assert.equal(task.resolved_by, legacy.personId);
    }
  });
}

test('resolve checks owner even for a principal allowed to read the vault, conceals task existence', async () => {
  const notOwner = { ...legacy, id: 'user:nina.maes', personId: 'nina.maes' };
  const task = core.flagForOwner({ topic: 'night-work-premium', issue: 'conflict', note: 'Check', context: { country: 'BE', client: 'Nordwind Retail' } }).task;
  for (const task_id of [task.id, 'task-unknown']) {
    assert.deepEqual(await invoke(notOwner, 'resolve', { task_id, verified_claim: '25% night premium' }), forbidden);
  }
  const result = await invoke(legacy, 'resolve', { task_id: task.id, verified_claim: '25% night premium', resolved_by: legacy.personId });
  assert.equal(result.isError, true); // removed identity input is rejected, not silently stripped
  assert.equal(core.getTask(task.id)!.status, 'open');
});

const brainInputs: Record<string, Record<string, unknown>> = {
  brain_analyze_case: { question: 'How many days?', documents: [{ id: 'ev-A' }] },
  brain_get_verdict: { runId: 'run-owner' },
  brain_explain_fact: { factId: 'fact-owner' },
  brain_list_verifications: {},
  brain_submit_verification: { token: 'signed-owner-token', action: 'confirm' },
  brain_ingest_reference: { pages: [{ id: 'wiki-test', text: 'Synthetic wiki content' }] },
  brain_health: {},
};
for (const [name, input] of Object.entries(brainInputs)) {
  test(`${name}: authorized session allowed; another principal gets generic 403`, async () => {
    const outsider = name === 'brain_list_verifications' ? { ...other, roles: ['reader'] as const } : other;
    const beforeCalls = calls.length;
    assert.deepEqual(await invoke(outsider, name, input, true), forbidden);
    assert.equal(calls.length, beforeCalls, 'denied call never reaches business handler');
    const result = await invoke(owner, name, input, true);
    assert.notEqual(result.isError, true, text(result));
    if (name === 'brain_list_verifications') {
      assert.match(text(result), /request-owner/);
      assert.doesNotMatch(text(result), /owner-jti|token_jti/);
    }
  });
}

test('every Brain handler denies before any database operation if its session has no role', async () => {
  let reads = 0;
  const forbiddenDb: Db = {
    query: async () => { reads++; throw new Error('unexpected query'); },
    transaction: async () => { reads++; throw new Error('unexpected transaction'); },
    exec: async () => { reads++; }, close: async () => {},
  };
  for (const [name, input] of Object.entries(brainInputs)) {
    assert.deepEqual(await invoke({ ...owner, roles: [] }, name, input, true, forbiddenDb), forbidden);
  }
  assert.equal(reads, 0);
});

test('every MCP tool rejects principalId/personId impersonation arguments', async () => {
  const c = await clientFor({ ...owner, groups: [...owner.groups, 'group:demo'] }, true);
  try {
    const listed = await c.client.listTools();
    assert.deepEqual(listed.tools.map((t) => t.name).sort(), [...ACTIONS].sort());
    for (const [name, args] of Object.entries({ ...legacyInputs, ...brainInputs })) {
      for (const field of ['principalId', 'personId']) {
        const result = await c.client.callTool({ name, arguments: { ...args, [field]: owner.id } });
        assert.equal(result.isError, true, `${name} accepted ${field}`);
      }
      const schema = listed.tools.find((t) => t.name === name)!.inputSchema;
      assert.equal(schema.additionalProperties, false, `${name} schema is not strict`);
      assert.ok(!('principalId' in (schema.properties ?? {})) && !('personId' in (schema.properties ?? {})));
    }
  } finally { await c.close(); }
});

test('request metadata cannot replace the established session', async () => {
  const c = await clientFor(other, true);
  try {
    const result = await c.client.callTool({ name: 'brain_health', arguments: {}, _meta: { principalId: owner.id, roles: ['admin'] } });
    assert.deepEqual(result, forbidden);
  } finally { await c.close(); }
});

test('IDOR denials are identical for inaccessible and nonexistent runs/facts/documents', async () => {
  for (const [name, key, existing] of [['brain_get_verdict', 'runId', 'run-owner'], ['brain_explain_fact', 'factId', 'fact-owner']]) {
    for (const value of [existing!, 'missing']) assert.deepEqual(await invoke(other, name!, { [key!]: value }, true), forbidden);
  }
  assert.deepEqual(await invoke(other, 'brain_analyze_case', { question: 'How many days?', documents: [{ id: 'missing' }] }, true), forbidden);
});

test('another verifier sees only their own requests; a creator loses access when a source ACL is revoked', async () => {
  assert.equal(text(await invoke(other, 'brain_list_verifications', {}, true)), text({ content: [{ type: 'text', text: '[]' }] }));
  const doc = demo.evidence[0]!.document;
  await evidenceRepo.upsertDocument(db, { ...doc, allowedPrincipals: [] });
  try {
    assert.deepEqual(await invoke(owner, 'brain_get_verdict', { runId: 'run-owner' }, true), forbidden);
    assert.deepEqual(await invoke(owner, 'brain_explain_fact', { factId: 'fact-owner' }, true), forbidden);
    assert.equal(text(await invoke(owner, 'brain_list_verifications', {}, true)), text({ content: [{ type: 'text', text: '[]' }] }));
  } finally { await evidenceRepo.upsertDocument(db, doc); }
});

test('all underlying sources are checked, including reference sources added through attribution', async () => {
  const page = demo.reference[0]!.page;
  await referenceRepo.upsertPage(db, { ...page, allowedPrincipals: [] });
  await brainRepo.replaceAttribution(db, 'run-owner', [{ runId: 'run-owner' as never, sourceKind: 'reference', sourceId: page.id, contributionPct: 100, acceptedClaims: [], rejectedClaims: [], reliabilityPct: 100 }]);
  try { assert.deepEqual(await invoke(owner, 'brain_get_verdict', { runId: 'run-owner' }, true), forbidden); }
  finally { await referenceRepo.upsertPage(db, page); await brainRepo.replaceAttribution(db, 'run-owner', []); }
});

test('run sharing requires every source ACL, not merely being a different run creator', async () => {
  const colleague = { ...owner, id: 'user:eva.jacobs', personId: 'eva.jacobs' };
  assert.notEqual((await invoke(colleague, 'brain_get_verdict', { runId: 'run-owner' }, true)).isError, true);
  const run = (await brainRepo.getRun(db, 'run-owner'))!;
  await brainRepo.saveRun(db, { ...run, id: 'run-empty' as never, evidenceSnapshotIds: [] });
  assert.deepEqual(await invoke(colleague, 'brain_get_verdict', { runId: 'run-empty' }, true), forbidden);
  assert.notEqual((await invoke(owner, 'brain_get_verdict', { runId: 'run-empty' }, true)).isError, true);
  await brainRepo.saveRun(db, { ...run, id: 'run-missing-source' as never, evidenceSnapshotIds: ['missing-snapshot' as never] });
  assert.deepEqual(await invoke(owner, 'brain_get_verdict', { runId: 'run-missing-source' }, true), forbidden);
});

test('cross-run graph edges cannot smuggle another run into an explanation', async () => {
  await edgeRepo.insertEdge(db, { id: 'cross-edge', type: 'MEMBER_OF', fromId: 'claim-any', fromKind: 'evidence_claim', toId: 'foreign-fact', toKind: 'fact', props: { role: 'support' }, runId: 'run-owner' } as never);
  try { assert.deepEqual(await invoke(owner, 'brain_explain_fact', { factId: 'fact-owner' }, true), forbidden); }
  finally { await edgeRepo.deleteEdgesByRun(db, 'run-owner'); }
});

test('verification rejects a spent token, wrong action and invalid token with the same denial', async () => {
  for (const input of [{ token: 'signed-owner-token', action: 'confirm' }, { token: 'signed-owner-token', action: 'reject' }, { token: 'invalid-token', action: 'confirm' }]) {
    assert.deepEqual(await invoke(owner, 'brain_submit_verification', input, true), forbidden);
  }
});
