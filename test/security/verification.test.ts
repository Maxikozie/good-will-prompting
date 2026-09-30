import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { SignJWT } from 'jose';
import { pgliteDb, brainRepo, evidenceRepo, edgeRepo, type Db } from '../../packages/brain/src/store';
import { seedDemo, loadDemo } from '../../packages/brain/src/store/seed';
import { VerificationTokens, MAX_LIFETIME_SECONDS } from '../../src/verification/tokens';
import { VerificationService, type ApplyVerification } from '../../src/verification/service';
import { createMockOidcIssuer } from '../../src/auth/mock-oidc';
import { Forbidden, type Principal } from '../../src/security/authorization';

const key = randomBytes(32);
const oldKey = randomBytes(32);
const env = {
  BRAIN_JWT_KEYS: JSON.stringify({ current: key.toString('base64'), old: oldKey.toString('base64') }),
  BRAIN_JWT_ACTIVE_KID: 'current', BRAIN_JWT_ISSUER: 'test-issuer', BRAIN_JWT_AUDIENCE: 'verification',
};
const tokens = new VerificationTokens(env);
const service = new VerificationService(env);
const binding = { factId: 'fact-crypto', verifierId: 'sarah.peeters', allowedActions: ['confirm'] as ['confirm'] };
const owner: Principal = { id: 'user:sarah.peeters', personId: binding.verifierId, groups: ['group:payroll-be', 'group:all-staff'], roles: ['verifier'] };
const epoch = () => Math.floor(Date.now() / 1000);
async function custom(payload: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const now = epoch();
  return new SignJWT({ ...binding, iss: env.BRAIN_JWT_ISSUER, aud: env.BRAIN_JWT_AUDIENCE, iat: now, nbf: now, exp: now + 3600, jti: randomUUID(), ...payload })
    .setProtectedHeader({ alg: 'HS256', typ: 'verification+jwt', kid: 'current', ...header }).sign(key);
}

test('startup refuses missing keys, short keys, unknown active kid and missing trust configuration', () => {
  for (const config of [{}, { ...env, BRAIN_JWT_KEYS: JSON.stringify({ current: randomBytes(31).toString('base64') }) },
    { ...env, BRAIN_JWT_ACTIVE_KID: 'missing' }, { ...env, BRAIN_JWT_ISSUER: '' }, { ...env, BRAIN_JWT_AUDIENCE: '' },
    { ...env, BRAIN_JWT_KEYS: '{"current":"invalid base64"}' }]) {
    assert.throws(() => new VerificationService(config), /Invalid BRAIN_JWT configuration/);
  }
});

test('valid JWT and kid rotation: old verification key accepted until retired; signing uses current kid', async () => {
  const token = await tokens.issue(binding);
  assert.deepEqual((await tokens.verify(token)).allowedActions, ['confirm']);
  assert.equal(JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()).kid, 'current');
  const previous = new VerificationTokens({ ...env, BRAIN_JWT_ACTIVE_KID: 'old' });
  const oldToken = await previous.issue(binding);
  await tokens.verify(oldToken);
  const retired = new VerificationTokens({ ...env, BRAIN_JWT_KEYS: JSON.stringify({ current: key.toString('base64') }) });
  await assert.rejects(retired.verify(oldToken), Forbidden);
  await assert.rejects(tokens.verify(await custom({}, { kid: 'unknown' })), Forbidden);
});

test('rejects expired, future nbf/iat, missing required claims, wrong issuer/audience and lifetime over 72h', async () => {
  const now = epoch();
  for (const claims of [
    { iat: now - 100, nbf: now - 100, exp: now }, { nbf: now + 120 }, { iat: now + 120, nbf: now + 120 },
    { iss: 'attacker' }, { aud: 'other-service' }, { aud: ['verification', 'other-service'] },
    { exp: now + MAX_LIFETIME_SECONDS + 1 }, { nbf: now - 1 }, { exp: now },
    ...['iss', 'aud', 'iat', 'nbf', 'exp', 'jti'].map((name) => ({ [name]: undefined })),
  ]) await assert.rejects(tokens.verify(await custom(claims)), Forbidden);
  await assert.rejects(tokens.issue(binding, MAX_LIFETIME_SECONDS + 1));
  await tokens.verify(await tokens.issue(binding, MAX_LIFETIME_SECONDS));
});

test('rejects wrong alg, alg none, changed signature, tampered payload and key headers', async () => {
  await assert.rejects(tokens.verify(await custom({}, { alg: 'HS384' })), Forbidden);
  const valid = await tokens.issue(binding);
  const [header, payload, signature] = valid.split('.');
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  await assert.rejects(tokens.verify(`${encode({ alg: 'none', kid: 'current', typ: 'verification+jwt' })}.${payload}.`), Forbidden);
  const altered = { ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), verifierId: 'attacker' };
  await assert.rejects(tokens.verify(`${header}.${encode(altered)}.${signature}`), Forbidden);
  await assert.rejects(tokens.verify(`${header}.${payload}.${randomBytes(32).toString('base64url')}`), Forbidden);
  for (const h of [{ jku: 'https://attacker.invalid/key' }, { kid: undefined }, { typ: 'JWT' }]) {
    await assert.rejects(tokens.verify(await custom({}, h)), Forbidden);
  }
});

test('mock OIDC refuses production before reading keys; mock and verification tokens cannot cross audiences/types', async () => {
  assert.throws(() => createMockOidcIssuer({ NODE_ENV: 'production' }), /disabled in production/);
  const mock = createMockOidcIssuer({ NODE_ENV: 'test', BRAIN_MOCK_OIDC_KEYS: env.BRAIN_JWT_KEYS,
    BRAIN_MOCK_OIDC_ACTIVE_KID: 'current', BRAIN_MOCK_OIDC_ISSUER: 'mock', BRAIN_MOCK_OIDC_AUDIENCE: 'demo-session' });
  const token = await mock.issue(owner.id);
  assert.deepEqual(await mock.verify(token), { sub: owner.id });
  await assert.rejects(tokens.verify(token), Forbidden);
  await assert.rejects(mock.verify(await tokens.issue(binding)), Forbidden);
});

let db: Db;
const demo = loadDemo();
before(async () => {
  db = await pgliteDb(); await seedDemo(db);
  const now = new Date().toISOString();
  await brainRepo.saveRun(db, { id: 'run-crypto' as never, namespace: 'brain', createdAt: now, question: 'Verification regression', principalId: owner.id as never,
    intent: { subject: 'leave', scope: { country: 'BE' }, questionType: 'rule', slotTemplateId: 'leave', generatedSlots: false },
    status: 'completed', rulesVersion: '1', promptVersions: {}, modelIds: {}, evidenceSnapshotIds: [demo.evidence[0]!.snapshot.id], referenceSnapshotIds: [], startedAt: now });
  await brainRepo.saveFact(db, { id: binding.factId as never, namespace: 'brain', createdAt: now, runId: 'run-crypto' as never,
    claimKey: 'c'.repeat(40), subject: 'leave', attribute: 'duration', scope: { country: 'BE' }, status: 'LIKELY', confidence: 80, reasons: [], needsVerification: true, referenceOnly: false, impact: 'low' });
  await db.query('INSERT INTO org.expertise (person_id, subject, country, weight) VALUES ($1,$2,$3,$4)', [owner.personId, 'leave', 'BE', 0.9]);
});
after(async () => db?.close());
async function issue() {
  const token = await tokens.issue(binding);
  const verified = await tokens.verify(token);
  const request = { id: randomUUID() as never, namespace: 'brain' as const, createdAt: new Date().toISOString(), factId: binding.factId as never,
    requestedFromId: binding.verifierId as never, reason: 'test', status: 'pending' as const, tokenJti: verified.jti, expiresAt: new Date(verified.expiresAt).toISOString() };
  await brainRepo.saveVerificationRequest(db, request);
  return { token, request };
}
const apply: ApplyVerification = async (tx, input, principal, token) => {
  const now = new Date().toISOString();
  await brainRepo.appendVerificationEvent(tx, { id: randomUUID() as never, namespace: 'brain', createdAt: now, factId: token.factId as never,
    verifierId: principal.personId as never, action: input.action, tier: 'T1', payload: {}, at: now });
  return { recorded: true };
};
const submit = (token: string, action: 'confirm' | 'reject' = 'confirm', principal = owner, fn = apply) => service.submit(db, { token, action }, principal, fn);

test('single use persists used_at; reuse and reopening the original request fail', async () => {
  const { token, request } = await issue();
  await submit(token);
  const row = await db.query<{ used_at: unknown }>('SELECT used_at FROM brain.verification_request WHERE id = $1', [request.id]);
  assert.ok(row.rows[0]!.used_at);
  await assert.rejects(submit(token), Forbidden);
  await assert.rejects(brainRepo.saveVerificationRequest(db, request));
  await assert.rejects(db.query("UPDATE brain.verification_request SET status = 'pending', used_at = NULL WHERE id = $1", [request.id]), /immutable/);
  await assert.rejects(submit(token), Forbidden);
});

test('parallel double-submit: exactly one action/audit succeeds', async () => {
  const { token } = await issue();
  const before = (await brainRepo.listVerificationEvents(db, binding.factId)).length;
  let actions = 0;
  const callback: ApplyVerification = async (...args) => { actions++; return apply(...args); };
  const results = await Promise.allSettled([submit(token, 'confirm', owner, callback), submit(token, 'confirm', owner, callback)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && r.reason instanceof Forbidden).length, 1);
  assert.equal(actions, 1);
  assert.equal((await brainRepo.listVerificationEvents(db, binding.factId)).length, before + 1);
});

test('action failure rolls back the burn AND audit, allowing a legitimate retry', async () => {
  const { token, request } = await issue();
  const before = (await brainRepo.listVerificationEvents(db, binding.factId)).length;
  await assert.rejects(submit(token, 'confirm', owner, async (...args) => { await apply(...args); throw new Error('action failed'); }), /action failed/);
  assert.equal((await brainRepo.listVerificationEvents(db, binding.factId)).length, before);
  assert.equal((await brainRepo.getVerificationRequest(db, request.id))!.status, 'pending');
  await submit(token);
});

test('wrong verifier, fact or action cannot consume a legitimate request', async () => {
  const { token, request } = await issue();
  await assert.rejects(submit(token, 'confirm', { ...owner, personId: 'tom.willems' }), Forbidden);
  await assert.rejects(submit(token, 'reject'), Forbidden);
  await assert.rejects(submit(await custom({ jti: request.tokenJti, factId: 'other-fact' })), Forbidden);
  assert.equal((await brainRepo.getVerificationRequest(db, request.id))!.status, 'pending');
  await submit(token);
});

test('can_verify is rechecked after issuance: inactive person, revoked expertise, wrong principal and source ACL fail', async () => {
  const { token } = await issue();
  await db.query('UPDATE org.person SET active = false WHERE id = $1', [owner.personId]);
  try { await assert.rejects(submit(token), Forbidden); }
  finally { await db.query('UPDATE org.person SET active = true WHERE id = $1', [owner.personId]); }
  await db.query('UPDATE org.expertise SET weight = 0.5 WHERE person_id = $1 AND subject = $2', [owner.personId, 'leave']);
  try { await assert.rejects(submit(token), Forbidden); }
  finally { await db.query('UPDATE org.expertise SET weight = 0.9 WHERE person_id = $1 AND subject = $2', [owner.personId, 'leave']); }
  await assert.rejects(submit(token, 'confirm', { ...owner, id: 'user:other' }), Forbidden);
  const doc = demo.evidence[0]!.document;
  await db.query('UPDATE evidence.document SET allowed_principals = $1 WHERE id = $2', [[], doc.id]);
  try { await assert.rejects(submit(token), Forbidden); }
  finally { await db.query('UPDATE evidence.document SET allowed_principals = $1 WHERE id = $2', [doc.allowedPrincipals, doc.id]); }
  await submit(token);
});


test('member ownership grants verification; detached membership still requires source ACL and valid lineage', async () => {
  const source = demo.evidence[0]!;
  const passage = source.passages[0]!;
  await evidenceRepo.saveClaims(db, [{
    id: 'claim-crypto' as never, namespace: 'evidence', origin: 'evidence', sourceId: source.document.id,
    snapshotId: source.snapshot.id, passageId: passage.id, span: { start: passage.start, end: passage.start + 5 }, quote: passage.text.slice(0, 5),
    subject: 'leave', attribute: 'duration', value: { type: 'number', raw: '2', normalized: 2, unit: 'days' },
    qualifiers: { country: 'BE', conditions: [] }, temporal: {}, polarity: 'affirms', modality: 'rule',
    extractionConfidence: 1, claimKey: 'c'.repeat(40), createdAt: new Date().toISOString(),
  }]);
  await edgeRepo.insertEdge(db, { id: 'membership-crypto' as never, type: 'MEMBER_OF', fromId: 'claim-crypto', fromKind: 'evidence_claim',
    toId: binding.factId, toKind: 'fact', props: { role: 'support' } });
  await db.query('UPDATE org.expertise SET weight = 0.5 WHERE person_id = $1 AND subject = $2', [owner.personId, 'leave']);
  try {
    await submit((await issue()).token); // owns ev-A, no qualifying expertise
    // Remove the run's snapshot references to prove the detached MEMBER_OF is checked independently.
    await db.query('UPDATE brain.case_run SET evidence_snapshot_ids = $1 WHERE id = $2', [[], 'run-crypto']);
    const { token } = await issue();
    await db.query('UPDATE evidence.document SET allowed_principals = $1 WHERE id = $2', [[], source.document.id]);
    try { await assert.rejects(submit(token), Forbidden); }
    finally { await db.query('UPDATE evidence.document SET allowed_principals = $1 WHERE id = $2', [source.document.allowedPrincipals, source.document.id]); }
    await db.query('UPDATE evidence.document SET owner_id = NULL WHERE id = $1', [source.document.id]);
    try { await assert.rejects(submit(token), Forbidden); }
    finally { await db.query('UPDATE evidence.document SET owner_id = $1 WHERE id = $2', [source.document.ownerId, source.document.id]); }
    await db.query('UPDATE brain.edge SET from_id = $1 WHERE id = $2', ['missing-claim', 'membership-crypto']);
    try { await assert.rejects(submit(token), Forbidden); }
    finally { await db.query('UPDATE brain.edge SET from_id = $1 WHERE id = $2', ['claim-crypto', 'membership-crypto']); }
    await submit(token);
  } finally {
    await db.query('UPDATE brain.case_run SET evidence_snapshot_ids = $1 WHERE id = $2', [[source.snapshot.id], 'run-crypto']);
    await db.query('UPDATE org.expertise SET weight = 0.9 WHERE person_id = $1 AND subject = $2', [owner.personId, 'leave']);
    await db.query('DELETE FROM brain.edge WHERE id = $1', ['membership-crypto']);
  }
});

test('invalid/expired tokens never reach the action or consume a request', async () => {
  const { request } = await issue();
  const now = epoch();
  let called = false;
  for (const token of ['invalid', await custom({ jti: request.tokenJti, iat: now - 100, nbf: now - 100, exp: now - 1 }), await tokens.issue(binding)]) {
    await assert.rejects(submit(token, 'confirm', owner, async () => { called = true; }), Forbidden);
  }
  assert.equal(called, false);
  assert.equal((await brainRepo.getVerificationRequest(db, request.id))!.status, 'pending');
});
