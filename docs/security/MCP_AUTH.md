# MCP authentication and authorization

## Local stdio deployment

The executable remains **stdio only**. No MCP HTTP/SSE endpoint, HTTP listener or CORS policy was added. A stdio child process inherits the identity of its OS-authenticated launcher. Its operator-owned `.env` supplies the application identity/group/role mapping, which is parsed and frozen once at startup. Launch one process per identity; do not share its stdin/stdout between users. Local code running as that OS user is inside this trust boundary.

Set these values in `.env` (not in tool arguments). Without valid session configuration the server fails before initializing the vault or accepting requests. Missing/empty vault readers grant no legacy data access.

```dotenv
# MOCK: fictional demo identity/directory mapping, explicitly selected by the local operator.
TRUSTLAYER_MCP_SESSION='{"id":"user:lotte.peeters","personId":"lotte.peeters","groups":["group:demo"],"roles":["reader","contributor","verifier"]}'
TRUSTLAYER_MCP_VAULT_READERS='["group:demo"]'
```

Then run `npm run mcp` or use `.mcp.json`. The executable is `src/mcp/stdio.ts`; `src/mcp/server.ts` exports the testable factory. `npm run dev` still starts the existing dashboard/API with one command. Its mock HTTP authentication is outside this MCP-only fix and must not be used as production authentication.

This mapping is configuration, not a bearer credential: the trusted local operator controls it, just as they control the process and vault files. No roles, groups, person ID or principal ID are accepted from a tool request or its `_meta`. Do not use this process-wide identity model when adding a multi-user HTTP/SSE adapter. Such an adapter must authenticate each session, map verified identities to server-managed roles, validate Origin, use an explicit CORS allowlist, bind loopback by default and create/bind the correct per-session server context.

## Permissions

| Role | Tools |
| --- | --- |
| reader | `verify_sources`, `trusted_answer`, `knowledge_health`, `find_expert`, `brain_get_verdict`, `brain_explain_fact` |
| contributor | `flag_for_owner`, `brain_analyze_case` |
| verifier | `resolve`, `brain_list_verifications`, `brain_submit_verification` |
| admin | All tool actions, including admin-only `brain_ingest_reference` and `brain_health`; resource ACLs/owner checks still apply |

Roles are additive and do not imply one another. Every handler first invokes `authorize(principal, action, {kind: 'service'})` before any datastore access. It then checks the target resource before reading business content or executing the operation. Authorization metadata must be read to evaluate an object ACL; this happens only after the service gate and is never returned on denial. Missing and unauthorized resources return the same MCP tool error: `isError: true`, text `403 Forbidden`.

The legacy file vault has no per-document ACL metadata. Access therefore requires an explicit grant to the **whole vault** through `TRUSTLAYER_MCP_VAULT_READERS`; selecting a country/client never grants permission. `resolve` additionally requires the session person to be the assignee or team lead and retains the existing active-person check. Use a separate vault/process for differently classified legacy corpora until per-source ACLs are introduced.

Brain run/fact reads check every underlying evidence and reference source's current ACL, including sources referenced by winners, conflicts, attribution, gaps and run graph edges. A run creator/admin does not bypass a revoked source ACL. A different caller may read a run only when they can read all its sources. A source-less run is private to its creator. Missing source metadata, inconsistent claim lineage, ambiguous cross-corpus claim IDs and cross-run pointers fail closed. Verification lists filter in SQL by the session's person ID, omit token JTIs and exclude requests whose facts are no longer readable.

## Brain integration boundary

At the reviewed implementation baseline, **no `brain_*` tools were registered and the full pipeline/verification service did not exist**. This change adds `registerBrainTools` for all seven specified names and integrates it as an optional dependency of `createMcpServer(session, {db, operations})`. The default executable still advertises the six working legacy tools. It does not advertise fake analysis/verification functionality.

When the real Brain service is ready, supply the complete `BrainOperations` interface. The registration layer handles session identity, action checks, run/fact ACLs, own-request filtering, admin gates and token person/fact/action binding. Business callbacks receive the already-authorized transaction and (where needed) session principal; they must use that transaction. They must not independently read caller identity from input. `analyzeCase` currently accepts IDs of pre-ingested evidence documents and checks their ACLs before extraction; unrestricted document/metadata payloads are intentionally not exposed by this adapter. `ingestReference` must obtain metadata/ACLs from the trusted connector, not page text.

`verifyToken` must authenticate the real token signature, issuer, audience and expiry. `submitVerification` must retain current can-verify checks, high-impact approval rules, atomic token consumption and audit writing in the supplied transaction. These services are required dependencies, not permissive fallback implementations. The regression suite supplies explicit test implementations of those business services and uses a real in-memory Brain database to test the authorization boundary.

## Validation and regression coverage

`npm run test:security` uses Node's existing test runner through `tsx`; no new dependency. Every one of the six legacy and seven Brain registrations has an allowed-session and denied-session test over the MCP SDK transport. Additional tests cover strict input schemas, metadata impersonation, no datastore access on failed role gates, identical missing/forbidden errors, source revocation (including for the creator/admin), own-inbox filtering, all-source attribution ACLs, cross-run graph references, missing sources and token binding/replay rejection. Fixtures and vault writes use a temporary directory; Brain storage is in memory.

Run root typecheck/build and the existing Brain typecheck/lint/test suite as well. The API/demo smoke check should cover assistant → verdict → flag → owner resolve → verified verdict, because MCP and the dashboard share the core functions.
