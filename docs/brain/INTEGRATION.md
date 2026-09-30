# Brain ↔ TrustLayer integration recon

Recon of the repo at `0e66b0b` (TrustLayer MVP). Nothing in existing code was modified.
Spec = [brain/brain-spec.md](../../brain/brain-spec.md), rules = [brain/brain-rules.md](../../brain/brain-rules.md)
(in this repo they live in `brain/`, not `docs/brain/`; the repo's root `CLAUDE.md` is just `@AGENTS.md`).

## 1. What exists today

| Area | Reality |
|---|---|
| Package manager | **npm** (`package-lock.json`), single package `trustlayer`, no workspaces. No pnpm. |
| Runtime / TS | Node 24 per AGENTS.md (local machine has 22.22, works). TS 5.9 via `tsx`, `module: ESNext`, `moduleResolution: bundler`, `strict`, `noEmit`. Includes `src`, `web/src`. Only script: `npm run typecheck` (`tsc --noEmit`). |
| Lint / tests / CI | **None.** AGENTS.md: "No tests, no CI, no Docker unless explicitly asked". No vitest, no eslint. |
| Validation | `zod` v4 (`src/core/schemas.ts`), strict objects on every MCP/API input. |
| DB | **None.** Persistence = plain files in `vault/` (gitignored, rebuilt by `npm run ingest`): `raw/<sha256>.{md,json}`, `wiki/<id>.md` (YAML frontmatter), `.meta/{tasks.json,queries.log,raw-manifest.json}`. Code: `src/core/vault.ts`. |
| LLM / embeddings | **None at runtime.** Claims are pre-extracted in `data/mock/claims-cache.json` (stands in for a cached extraction pass). No Ollama/Anthropic client, no embedder. |
| Env handling | `src/core/util.ts:10-13`: `process.loadEnvFile('.env')` (Node built-in, no dotenv); empty values deleted. Vars: `PORT`, `HOST`, `TRUSTLAYER_NOW`, `TRUSTLAYER_VAULT_DIR`. `.env.example` also lists `ELEVENLABS_API_KEY`, `GOOGLE_CLOUD_PROJECT` (unused). |
| MCP server | `src/mcp/server.ts`, `@modelcontextprotocol/sdk` `McpServer` + **stdio only** (`StdioServerTransport`, last line). Started with `npm run mcp` (`tsx src/mcp/server.ts`) or via `.mcp.json` (`node --import tsx src/mcp/server.ts`). stdout is the protocol channel, logs go to stderr. |
| MCP auth | **None.** stdio trust model: whoever spawns the process is the caller. `created_by: 'mcp'` / `askedBy: 'mcp'` are hardcoded. `resolve` checks `resolved_by` is assignee/team lead (`src/core/tasks.ts`) but the id is caller-supplied (self-asserted). No principals, no tokens, no ACLs. |
| MCP tools (6) | `verify_sources`, `trusted_answer`, `knowledge_health`, `flag_for_owner`, `resolve`, `find_expert`. Registered with `server.registerTool(name, {title, description, inputSchema, annotations}, handler)`; every handler wrapped in `guard()`; results are markdown text via `ok()`. |
| HTTP API | `src/api/server.ts` Express 5 on 127.0.0.1:5173, rate limit 300/min/IP, security headers, `x-mock-user` header = **MOCK auth** (`mockUser()`). Mirrors the MCP tools plus `/api/assistant`, `/api/pages`, `/api/raw/:hash`, `/api/people`, `/api/demo/reset`. |
| Dashboard | `web/` Vite + React 19 + Tailwind v4 (Live call, Knowledge radar, Owner inbox), polls every 3 s. |

## 2. Where "the agent" gets case documents

There is **no real agent in the repo**. The "existing SD Worx assistant" is a MOCK:

- `src/core/assistant.ts` → `existingAssistant(question): { assistant, results: AssistantResult[] }`
  - canned fixtures in `data/mock/existing-assistant/*.json` (demo question → Doc A/B/C), matched by `detectTopic` + `detectCountry` (`src/core/org.ts`)
  - otherwise naive keyword search over SharePoint-origin wiki pages (`listPages()` from `src/core/vault.ts`)
- Exposed at `GET /api/assistant?q=` (`src/api/server.ts`), consumed by `web/src/views/LiveCall.tsx`, which then POSTs `/api/verify`.
- In production the real assistant (external) calls `verify_sources` over MCP itself, or an orchestrator (Claude Code) does. Either way the entry point for case documents is the `sources` argument of `verify_sources` → `buildVerdict(question, ctx, { sources })` in `src/core/trust.ts` (input matching: `matchInput()`, `trust.ts:362`, by `id` → `hash` → `location` → title).

### Document payload as it exists today

What the assistant hands over (`InputSource`, `src/core/types.ts`; zod: `inputSourceSchema`):

```ts
{ id?: string; hash?: string /* sha256 of raw */; title?: string; location?: string /* URL */; snippet?: string /* ≤2000 chars */ }
```
(The mock `AssistantResult` adds `relevance: number`.) Note: **no full text, no owner, no dates, no scope.** The layer resolves these by looking the source up in the vault.

What the vault knows per source (`WikiPage`, `src/core/types.ts`; `vault/wiki/<id>.md`):
`id, title, topic, owner, owner_team, author, country, client, product, source_type ('policy'|'wiki'|'email'|'teams'), origin ('sharepoint'|'teams'|'outlook'|'internal'), location, created, last_edited, last_verified, status, sources[] (raw sha256), supersedes[], superseded_by, captured_in, claims: Claim[], body`.
Full original text: `getRaw(hash)` (`vault.ts`) → `vault/raw/<hash>.{md,json}`; `GET /api/raw/:hash`.

Where IDs / URIs / metadata come from (all MOCK, `src/core/ingest.ts`): SharePoint `.md` frontmatter (`id`, `url`, `owner`, `modified`, `last_verified`, `country`, `client`), Teams `.json` (`id`, `url`, `messages[]`), email `.json`; owners/people/teams from `data/mock/internal/{people,ownership,topics}.json`. Real version: Microsoft Graph.

Current `Claim` (`types.ts`): `{ topic, value: string, text, effective_from? }` — one claim per source per topic, **no span/quote/attribute/qualifiers/modality/polarity**.

## 3. Adapter: payload → EvidenceDocument / EvidenceSnapshot (SPEC §2.1)

New file (later step): `src/brain/adapter.ts` (or `src/evidence/adapter.ts`), pure, reads via existing `getPage()`/`getRaw()`; no change to core.

| SPEC field | Source today |
|---|---|
| `EvidenceDocument.id` | `InputSource.id` ⟶ else `matchInput()` page id; unmatched input gets `ext-<sha1(location\|title)>` |
| `sourceSystem` | `WikiPage.origin`: sharepoint→`sharepoint`, teams→`teams`, outlook→`email`, internal→`manual` |
| `sourceUri` | `WikiPage.location` ?? `InputSource.location` |
| `title` | `WikiPage.title` ?? `InputSource.title` |
| `ownerId` / `authorId` | `WikiPage.owner` / `WikiPage.author` (person ids like `lotte.peeters`) |
| `lastEditedAt` | `WikiPage.last_edited` |
| `lastVerifiedAt` | `WikiPage.last_verified` |
| `verifiedTier` | **not stored.** Derive: `last_verified` set and not edited after → T3 (owner-verified); `resolveTask` output (verified page) → T3; else T0. Four-eyes/T4 not representable yet |
| `validUntil` | none → undefined |
| `declaredScope` | `{ country: page.country, customerId: page.client, product: page.product }`; **`jointCommittee`/`employeeCategory` are absent** (only mentioned in body text, e.g. "JC 311") → parse from body or add to frontmatter |
| `allowedPrincipals` | **none in data** → MOCK: `['*']` (see conflicts) |
| `EvidenceSnapshot.contentHash` | `WikiPage.sources[0]` (already SHA-256 of raw, content-addressed) |
| `.text` | `getRaw(hash).content`; for snippet-only input with no vault match: `snippet` |
| `.fetchedAt` / `.version` | `raw-manifest.json` `ingested_at`; version = count of distinct hashes per `source_id` (1 today) |
| Passages (§5 stage 10) | split `.text` heading-aware (markdown `##`, Teams messages, email body); offsets kept |

Wiki/reference content is a separate adapter (§5) → `WikiPage`(SPEC)/`WikiSnapshot`/`WikiSection`, never `EvidenceDocument`.

## 4. Decision: where the `brain_*` tools live

**Register them on the existing MCP server, implemented in a new file `src/mcp/brain-tools.ts` exporting `registerBrainTools(server)`; `src/mcp/server.ts` gets one import + one call.**
1. One stdio process and one `.mcp.json` entry: the demo (Claude Code) and the dashboard already talk to `trustlayer`; a sibling would need a second entry, a second vault lock and duplicated `ensureVault()`/zod/`guard()` setup.
2. `brain_analyze_case` is the richer sibling of `verify_sources` (same inputs: question + sources) and must reuse `buildVerdict`, `flagForOwner`, `resolveTask`, `findExpert`, so in-process reuse beats IPC.
3. Isolation is kept at code level (own file + own `src/brain/**`), so the touch point in existing code is exactly two lines and trivially revertable.

## 5. Where wiki / reference content comes from

No wiki connector exists. Today `WikiPage` in this repo means "vault page" for *all* sources, i.e. it is the **evidence** store and would collide by name with SPEC's reference `WikiPage`. Plan:
- **Seed files**: new `data/mock/wiki/*.md` (frontmatter: `id, title, space, uri, owner, official, last_edited, last_verified, country`), one file per W1–W4 of SPEC §14, plus the small-leave evidence seed A–D (`data/mock/sharepoint/`, `email/`) and their claims.
- Ingested by a **separate** loader into a separate store: `vault-reference/` (or `vault/reference/`) — never into `vault/wiki/`. `npm run ingest` stays unchanged; add `npm run ingest:reference`.
- Real version: Confluence/SharePoint wiki connector via Microsoft Graph; out of scope for the hackathon.
- Retrieval for stage 50: keyword/BM25-style over section text using existing `tokens()` (`src/core/util.ts`) since there is no embedder (see conflicts).

## 6. Conflicts between SPEC / brain-rules and the codebase

| # | SPEC / rules says | Codebase reality | Resolution |
|---|---|---|---|
| 1 | pnpm monorepo, code in `packages/brain` | npm, single package, `src/` | Keep npm. Code in `src/brain/**` (+ `src/evidence/**`, `src/reference/**`, `src/pipeline/**`, `src/domain/**` as sibling folders of `src/core`). No workspace. |
| 2 | Postgres 16 + pgvector, `evidence.*`/`reference.*` schemas, typed edge table | No DB; AGENTS.md: no Docker | Files-as-DB: two separate stores `vault/` (evidence) and `vault-reference/`, plus `vault-brain/` for runs/facts/edges (JSON or JSONL, edge list in one `edges.jsonl`). Same invariants (separate stores, branded ids) without infra. Storage behind small `Store` interfaces so Postgres can be swapped in. |
| 3 | LLM extract/classify (Ollama, Anthropic, FakeProvider) | No LLM at runtime; claims pre-cached | Implement `LLMProvider` with **`FakeProvider` only** (fixtures = extended `claims-cache.json` with `quote/span/attribute/qualifiers/modality`). Optional `AnthropicProvider` later behind env key. Extraction cache keyed `(passageHash, promptVersion, modelId)` already matches the existing "cached extraction" idea. |
| 4 | Embeddings (`nomic-embed-text`), cosine ≥ 0.82/0.93, SimHash | No embedder | `Embedder` interface + `FakeEmbedder` (token-set/TF hash vectors). SimHash (pure code) stays; cosine thresholds applied to fake vectors, tuned on the seed. |
| 5 | vitest, lint rule for evidence↔reference imports, `pnpm -r typecheck/lint/test` per step | AGENTS.md: no tests/CI/lint; only `npm run typecheck` | Follow AGENTS.md (it wins). Per step run `npm run typecheck`, `node --check` on any `.js/.mjs`. Keep the **golden scenario as a runnable script** (`npm run brain:golden`, prints the attribution table + asserts) instead of vitest; enforce the import boundary with a tiny grep-based check in that script. Add vitest only if the team asks. |
| 6 | Claim = `{subject.dotted, attribute, value{type,raw,normalized,unit}, qualifiers, span, quote, modality, polarity}` | `Claim = {topic, value: string, text, effective_from}`; 7 topics, all overtime/meal-voucher style | New richer `Claim` in `src/brain/`; adapter up-converts old claims (`topic`→`subject`, `value` "120%"→`{type:'number', unit:'pct', normalized:120}`, `attribute:'value'`, `quote:=text`, span found by string search, `modality:'rule'`). Existing `Claim` and `trust.ts` untouched. |
| 7 | Scope has `jointCommittee`, `employeeCategory`, `customerId`, language | Country is `'BE'|'NL'` only, `client` free string, no PC/category | Brain `Scope` type is a superset; map `client`→`customerId`. Seed data sets `jointCommittee: 'PC 200'`, `employeeCategory: 'bediende'` in frontmatter. |
| 8 | Fact statuses `VERIFIED/LIKELY/DISPUTED/PROVISIONAL/REJECTED/UNKNOWN`; score bands | Existing `PageStatus` (`verified/unverified/conflict/stale/orphan/superseded`), `Verdict.level` high/medium/low, threshold 60 | Brain has its own enums. `CaseVerdict` is new and separate from `Verdict`. A mapping fn `toLegacyLevel` (≥80 high, 60–79 medium, <60 low) lets the dashboard show both if wanted. Two scorers coexist: `trust.ts` (source-level, live demo) and Brain (claim-level). |
| 9 | Verification tiers T0–T4, four-eyes, decay half-life | Only `last_verified` date + `status` | Derive tier per §3 table; add optional `verified_tier` + `verified_by[]` to vault frontmatter only for Brain seed docs. Four-eyes implemented in Brain's own `VerificationEvent` log, not in `tasks.ts`. |
| 10 | Principals, ACLs (`allowedPrincipals`), ACL filter before extraction, JWT tokens (jti, 72 h), `/auth/mock` issuer | No principals; MCP has no auth; API has `x-mock-user` | Add `Principal` type; MOCK issuer: Express route `/auth/mock` (new, in `src/api/`) signing HS256 JWT from `.env` `BRAIN_JWT_SECRET` (add to `.env.example`, empty). MCP tools take `principalId` argument (stdio has no identity) — labelled `// MOCK`. Seed docs get `allowedPrincipals`; one doc restricted to prove the ACL test. Aikido will flag the mock auth; accepted. |
| 11 | `CaseRun` snapshots ids, rulesVersion, determinism | `buildVerdict` reads live vault + `now()` | Brain uses `now()` from `util.ts` (honours `TRUSTLAYER_NOW`) so runs are reproducible; golden run pins `TRUSTLAYER_NOW`. Rules/scoring in `rules/rules.yaml` + `rules/scoring.yaml`, parsed with the already-installed `yaml`. |
| 12 | Rate limit MCP tools per principal | Rate limit exists only on HTTP API (per IP) | Small in-memory limiter inside `registerBrainTools` keyed by `principalId`. |
| 13 | "Conventional commits `feat(brain): …`", `git commit` per step | AGENTS.md: short imperative messages | Use `feat(brain): …` for Brain commits (user's own Prompt 0 uses it); AGENTS.md style for everyone else's. No conflict in practice. |
| 14 | Name clash: SPEC `WikiPage`/`WikiSnapshot` (reference) | Repo `WikiPage` = every vault page (evidence side) | In Brain code use branded `ReferenceWikiPage`/`WikiPageId`; never import `WikiPage` from `core/types` in `src/reference/**`. |
| 15 | Pipeline is many steps, hackathon = ~5 h total, deadline 22:30 | Team is parallel on one repo; AGENTS.md "stay in scope, don't break main" | Brain lives only in new folders + 2 touch points (`src/mcp/server.ts` import/call, `package.json` scripts). Never on `main` half-done: behind the tool flag `BRAIN_ENABLED`. Keep the minimal demo (steps 0–9) first. |
| 16 | Security: injection test doc, append-only audit, secrets via env | Aikido scan at ~21:00; zod + no-eval conventions already in place | Adopt: seed prompt-injection text in doc B; audit = append-only JSONL (`vault-brain/audit.jsonl`, opened with flag `a`). |

## 7. Touch points with existing code (planned, none done yet)
- `src/mcp/server.ts`: `import { registerBrainTools } from './brain-tools'; registerBrainTools(server);` (2 lines)
- `package.json`: scripts `ingest:reference`, `brain:golden` (+ new deps, announced when added; none expected: `yaml`, `zod`, `node:crypto` suffice for the Fake providers)
- `.env.example`: `BRAIN_JWT_SECRET=`, optional `ANTHROPIC_API_KEY=`, `BRAIN_ENABLED=`
- `.gitignore`: `vault-reference/`, `vault-brain/` (`vault-*/` already matches both)
- `AGENTS.md`: Status + Structure lines when the Brain lands
- Read-only reuse of: `getPage`, `getRaw`, `listPages`, `loadOrg`, `buildVerdict`, `flagForOwner`, `resolveTask`, `findExpert`, `now`, `tokens`, `sha256`, zod helpers in `schemas.ts`.

## MCP security integration (2026-09-30)

Use `createMcpServer(session, {db, operations, verification})` and the guarded registrations in
`src/mcp/brain-tools.ts` when connecting the pipeline. See
[the MCP authentication contract](../security/MCP_AUTH.md). Any earlier example
passing `principalId` as tool input is superseded: identity comes exclusively from
the authenticated server session. Supply the complete business-service interface;
the local executable currently registers only the six implemented legacy tools.

Verification crypto and atomic token use now live in `src/verification/`; construct `VerificationService` from environment configuration at backend startup. See [token integration](../security/VERIFICATION_TOKENS.md).
