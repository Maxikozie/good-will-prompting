# TrustLayer: an MCP trust layer for SD Worx knowledge

> SD Worx doesn't need another search box or another agent. It needs its existing agents to know what to trust.
> TrustLayer is one MCP server that gives every answer a source verdict, and turns every conflict into knowledge that gets fixed once, for everyone.

Built at the Tectonic Hackathon Ghent (30 Sept 2026), SD Worx track: *"How might we turn fragmented organisational knowledge into a trusted shared resource?"*

## What it does
SD Worx already has an assistant that searches its documents. It returns 3 documents and the colleague on the phone still doesn't know which one to trust. TrustLayer sits **on top of** that assistant (or any agent) as one MCP server:

1. **Trust verdict**: for a question plus the sources the assistant returned, score every source 0–100 with human-readable reasons (owner, freshness, country/client scope, authority, corroboration), detect conflicts, recommend one source, give a one-line answer and name the owner to ask. It also adds what the assistant missed, like the payroll expert's Teams message.
2. **Knowledge health radar**: continuously lint the knowledge vault for conflicts, orphaned (ownerless) pages, stale pages, unverified changes and gaps (questions nobody could answer), each routed to an owner.

**The loop:** a conflict found while answering becomes a fix task for the owner → the owner resolves it → the wiki page becomes *verified*, the losing sources are *superseded*, the chat is *captured* → the next person gets a trusted answer. Knowledge gets better every time it's used.

Scoring is **deterministic and explainable**: no LLM at runtime, so it's fast, cheap and auditable. Claims are pre-extracted and cached in the vault.

## Run
```bash
npm install
npm run dev          # dashboard + API on http://localhost:5173 (builds the vault on first run)
```
- `npm run ingest`: rebuild the vault from `data/mock` (also: "Reset demo" in the dashboard footer)
- `npm run mcp`: the MCP server over stdio (use `npm run --silent mcp` so npm doesn't write to stdout)

### Use it from Claude
Claude Code picks up [`.mcp.json`](.mcp.json) automatically when you open this folder (approve the `trustlayer` server). Or add it by hand from the repo root:
```bash
claude mcp add trustlayer -- node --import tsx src/mcp/server.ts
```
Then ask: *"A customer asks what the Sunday overtime premium is for Nordwind Retail employees in Belgium. Our assistant returned sp-nordwind-be-overtime-2022, sp-cs-be-kb-overtime and sp-nordwind-nl-premiums. Which one should I trust?"*

The dashboard polls every 3 s, so tasks Claude creates or resolves through MCP show up live.

## MCP tools
| Tool | What it does |
|---|---|
| `verify_sources(question, sources[], context?)` | The core layer-on-top call: per-source score + reasons, conflicts, recommended source, trusted answer, confidence, owner to ask |
| `trusted_answer(question, context?)` | Same verdict, searching the vault directly |
| `knowledge_health(country?, team?)` | The radar: health score, team/country tiles, conflicts, orphans, stale, unverified, gaps |
| `flag_for_owner(topic, issue, note, context?)` | Fix task for the accountable owner (team lead if orphaned). Idempotent |
| `resolve(task_id, verified_claim, resolved_by)` | Owner verifies: page → verified, losers → superseded, chat → captured |
| `find_expert(topic, context?)` | Who owns / last answered this (Connect) |

## Trust score (0–100, reasons first)
| Factor | Points |
|---|---|
| Ownership | accountable client owner / team lead 30 · client's payroll team 25 · other owner 18 · owner left 3 · no owner 0 (orphan) |
| Freshness | verified ≤ 90 d 25 · ≤ 1 y 15 · stale 3 · chat from this month 18 · edited but never verified 5 (flagged "unverified change") |
| Scope | country + client match up to 25 · **mismatch caps the whole score at 20** ("applies to NL, you asked about BE") |
| Authority | policy doc 15 · team wiki 10 · email 6 · Teams chat 4 |
| Corroboration | +5 per agreeing in-scope source (max +10) · −15 if contradicted by a more trusted source |
| Supersession | replaced by a verified page: capped at 10 |

Conflict = two or more in-scope, non-superseded sources claiming different values for the same topic.

## Architecture
```
data/mock/            MOCK sources: sharepoint/*.md, teams/*.json, email/*.json, internal/*.json,
                      existing-assistant/*.json (what the current assistant returns), claims-cache.json
vault/                generated, gitignored; opens in Obsidian
  raw/<sha256>.*      immutable copies, content-addressed (provenance: what a source said, and when)
  wiki/<id>.md        one page per knowledge item, YAML frontmatter (owner, owner_team, country, client,
                      product, source_type, last_verified, status, sources, supersedes, claims)
  .meta/              tasks.json, queries.log (gap detection), raw-manifest.json
src/core/             pure logic shared by MCP + API: ingest, trust scoring, health/lint, tasks, experts
src/mcp/server.ts     MCP server (stdio, @modelcontextprotocol/sdk, zod-validated tools)
src/api/server.ts     Express API + Vite dev middleware (one process, one port)
web/                  React + Tailwind dashboard: Live call · Knowledge radar · Owner inbox
```
Vault pattern borrowed from claude-obsidian: immutable raw sources + linked wiki pages with citations + a lint pass for vault health. Our lint pass *is* the health radar.

## Demo scenario (mock data)
One fictional client, **Nordwind Retail**, in Belgium and the Netherlands. Question: *"What is the Sunday overtime premium for Nordwind Retail employees in Belgium?"* The existing assistant returns 3 docs:
- **Doc A** (2022, no owner) says 100% → orphan, outdated
- **Doc B** (edited last week, never verified) says 50% → unverified change
- **Doc C** (right title, but for the Netherlands) says 50% → scope mismatch
- TrustLayer adds the **Teams message** from Lotte Peeters, the accountable Nordwind BE payroll owner: 120% since the new JC 311 CLA → recommended
After Lotte resolves the task, the same question returns a verified answer (score 100, green badge) and the radar goes from 58 to 84. See [docs/demo-script.md](docs/demo-script.md).

## Security
- Every MCP tool input and API body is validated with zod (strict objects, length limits, enums).
- Files are only addressed by validated ids / SHA-256 hashes inside `vault/`, never by user-supplied paths.
- No eval, no shell exec, no raw HTML rendering of source content.
- API binds to 127.0.0.1, sets security headers, hides stack traces, caps JSON bodies at 64 kB.
- Secrets only in `.env` (gitignored). No keys are needed to run the demo.
- Auth is **MOCK** (labelled in code): the signed-in user is a demo selector. Resolve still enforces that only the assignee or their team lead can verify.

Everything external is mocked: SharePoint, Teams, Outlook, the HR directory and the existing assistant are fixtures in `data/mock/`. Production would use Microsoft Graph connectors.
