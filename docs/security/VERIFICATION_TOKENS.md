# Verification token security

`src/verification/tokens.ts` verifies HS256 only through JOSE/WebCrypto. It requires an allowlisted `kid`, `typ=verification+jwt`, exact issuer/audience, `iat`, `nbf`, `exp`, `jti`, and fact/verifier/action bindings. Lifetime is at most 72 hours, with **zero clock tolerance**. It rejects unknown algorithms (including `none`), unknown keys, remote key headers, missing claims and extra binding claims. Authorization uses real wall-clock time, never the demo clock.

## Startup and rotation

Construct `new VerificationService(process.env)` when starting the Brain backend, before registering tools or accepting requests. Its constructor requires:

- `BRAIN_JWT_KEYS`: JSON object mapping key IDs to canonical base64-encoded random keys, each at least 32 decoded bytes.
- `BRAIN_JWT_ACTIVE_KID`: key used to sign new tokens; it must exist in the map.
- `BRAIN_JWT_ISSUER` and `BRAIN_JWT_AUDIENCE`: explicit nonempty trust-domain values.

Generate keys with a cryptographic RNG and store them only in the operator's environment or secret manager; `.env.example` contains empty placeholders. There is no default/development key. Keys are copied into private process state at construction. To rotate, add a new key and select its kid, deploy/restart, retain the previous verification key for at most the old tokens' remaining lifetime, then remove it and restart. Removing a key immediately invalidates its outstanding tokens. HS256 secrets/signatures are verified by WebCrypto, not ordinary string equality; issuer, audience, IDs and action names are public identifiers.

Use `VerificationTokens.issue` for signing. Persist the verified token's `jti`, `factId`, `verifierId` and exact expiry as a new pending verification request before delivering it. Signing alone does not create an actionable request. Issuance routing still belongs to the Brain pipeline.

## Submit transaction

`VerificationService.submit` verifies the cryptography and authenticated caller binding, then checks the persisted request and reruns `canVerify`: an active person mapped to the authenticated principal, ownership of a member claim/source or expertise >=0.6 in the fact's subject/country, and source ACLs. It checks current membership edges even when they have no run ID. Possessing a token never grants permission.

The same transaction locks the fact and performs a conditional `UPDATE ... SET used_at = now(), status = 'completed' WHERE token_jti = $1 AND used_at IS NULL AND status = 'pending' AND expires_at > now() RETURNING id`. Exactly one caller wins. Only the winner invokes the business action callback, which must use the provided transaction for both the action and its audit. A failed action rolls back consumption and all transactional writes. External notifications belong after commit.

Migration `004_verification_token_use.sql` backfills completed tokens, makes token bindings immutable, and prevents clearing `used_at` or reopening terminal requests. Repository issuance is insert-only, closing the previous upsert replay path. Apply migrations before starting the Brain backend; `seedDemo` already migrates automatically.

The MCP registration requires a real `VerificationService` in `BrainToolDependencies.verification`; the injectable `verifyToken` callback has been removed. The `submitVerification` business callback applies the action and audit; **it must not burn the token again**. The callback still owns adjudication, self-verification tier caps, four-eyes approval rules, and reassignment-target policy. This change does not fabricate the unfinished stages 60–90 or make the standard six-tool stdio executable expose them.

## Mock identity issuer

No OIDC endpoint existed in the reviewed code. `src/auth/mock-oidc.ts` now supplies an explicitly labelled local factory for future demo integration; it is not a full OIDC protocol implementation or an HTTP endpoint. Construction and use throw when `NODE_ENV=production`, even before key configuration is checked. It requires separate `BRAIN_MOCK_OIDC_*` settings and uses `typ=mock-oidc+jwt` with a 15-minute lifetime. Mock tokens cannot be used as verification tokens. Existing local stdio identity remains OS/operator configuration; the existing dashboard's labelled mock HTTP auth is unchanged.

## Regression coverage

`npm run test:security` covers malformed/expired/future/overlong tokens, wrong algorithm/`none`, tampered signatures/payloads, issuer/audience/type/key isolation, rotation, wrong fact/verifier/action, production mock rejection, permission revocation, durable single use, simultaneous double-submit, and transaction rollback. It uses real PGlite and randomly generated test-only keys, plus the existing MCP and real-stdio tests. `jose` was already installed transitively through the MCP SDK and is now an explicit root dependency.
