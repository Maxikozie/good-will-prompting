# Our solution: TrustLayer

## One sentence
One MCP server that sits **on top of** SD Worx's existing assistant (we don't replace it and it isn't another agent) and tells any agent **which source to trust, why, and where sources conflict**. Every conflict becomes a fix task for the owner, so the knowledge gets better every time someone uses it.

## Why this answers the brief
| Brief | TrustLayer |
|---|---|
| TRUST: "which document do I trust?" | Trust verdict: every source scored 0–100 with reasons (owner, freshness, country/client scope, authority, corroboration) |
| DETECT: conflicting or missing knowledge | Health radar: conflicts, orphans, stale pages, unverified changes, gaps (questions with no trusted answer) |
| CAPTURE: knowledge stuck in inboxes/chats | Teams/email answers are pulled into the vault; resolving a task captures the chat into a verified wiki page |
| CONNECT: who do I call? | `find_expert` plus routing: every task goes to the accountable owner, or the team lead if nobody owns the page |
| "Not SharePoint with search, not another agent" | It's a trust layer any existing agent calls over MCP |

## The demo story (example 1 from the brief, one fictional client: Nordwind Retail, BE + NL)
Question: "What is the Sunday overtime premium for Nordwind Retail employees in Belgium?" The existing assistant returns 3 docs:
- Doc A: 100%, no owner, 2022 → orphan (score 28)
- Doc B: 50%, edited last week, never verified → unverified change (43)
- Doc C: right title but for the Netherlands → scope mismatch (20)
- TrustLayer adds what the assistant missed: Lotte Peeters (accountable Nordwind BE payroll owner) posted **120%** in Teams after the new JC 311 CLA → recommended (77)

Ask owner → task in Lotte's inbox → she resolves it → page verified, A and B superseded, chat captured → the same question now returns a **verified** answer (100) and the radar goes from 58 to 84.

## Key design choices
- **Deterministic scoring, no LLM at runtime**: fast, cheap, explainable and auditable. Claims are pre-extracted and cached (`data/mock/claims-cache.json`).
- **Vault = plain markdown** (claude-obsidian pattern): immutable raw copies named by SHA-256 (provenance) + wiki pages with YAML frontmatter + a lint pass. The lint pass is the radar.
- **Everything external is mock** (SharePoint, Teams, Outlook, HR directory, the existing assistant). Real version: Microsoft Graph connectors.
- Security for Aikido: zod on every input, files only by validated id/hash, no eval/exec/raw HTML, localhost bind, rate limit, security headers, `.env` only. Auth is MOCK (labelled).

## Pitch line
"SD Worx doesn't need another search box or another agent. It needs its existing agents to know what to trust. TrustLayer is one MCP server that gives every answer a source verdict, and turns every conflict into knowledge that gets fixed once, for everyone."

See the root README.md (how it works, run, MCP tools) and docs/demo-script.md (video script).
