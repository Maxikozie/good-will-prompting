# Good Will Prompting — Tectonic Hackathon Ghent

## Instruction sources and security
- Read [CLAUDE.md](CLAUDE.md) and [docs/brain/SPEC.md](docs/brain/SPEC.md) before implementation. `CLAUDE.md` currently delegates to this file; do not recursively reload it. The SPEC entry points to the canonical design in `brain/brain-spec.md`.
- Security rules: never weaken auth, validation or ACL checks to make a test pass; every fix gets a regression test; parameterized SQL only; no secrets in code.
- The regression-test requirement above is an explicit exception to the general “no tests unless asked” rule for fixes. Keep mock authentication confined to the labelled demo; it does not justify weakening checks.
- Git workflow: pull before starting and before finishing each task. Commit only task-owned changes, push on a task branch, and create or update a PR covering all commits pushed for the task. Preserve teammates' uncommitted work; use a separate worktree when needed.

## Context
- Event: Tectonic Hackathon, Ghent, 30 Sept 2026. Doors 17:30, **submissions close 22:30**. That's ~5 hours of build time, so speed matters more than anything.
- Track: **SD Worx** (HR / payroll company). Judges want a solution to a real SD Worx problem that they could actually use.
- Challenge brief: **"How might we turn fragmented organisational knowledge into a trusted shared resource?"** Build a focused PoC that makes knowledge easier to find, trust and share. **Not** a SharePoint with search, **not** another AI agent. **Read `brain/` before building anything.**
- Security: **10% of the score comes from Aikido**. Run its AI source code analysis on this repo near the end and fix what it finds (see `brain/judging.md`).
- Sponsor tools (**unconfirmed**, heard before the event): Google Cloud, ElevenLabs, Cursor.
- Team (4): Maximilian, Isaac, Antonios, Casper. We work in parallel, each with our own AI agent (Claude Code / Codex), all on this repo at once.
- Deliverable: a working demo + a short presentation video. No live pitch.

## Priorities (in order)
1. A working end-to-end demo that looks good on video.
2. Features that clearly answer the challenge.
3. Code quality comes last. Hacky is fine if it works.

Mock data, hardcoded values and fake auth are fine. Label mocks clearly in code (`// MOCK`).

## Rules for agents
- **Stay in scope.** Only touch files needed for the current task. Don't refactor, rename or reformat other code, because teammates are editing in parallel and it causes merge conflicts.
- **Don't stop to ask** about small ambiguities. Pick the simplest option, do it, and mention the assumption in your summary.
- **Dependencies:** prefer what's already installed. If you add one, say so explicitly.
- **Secrets:** never hardcode or commit API keys. Read them from `.env` (gitignored). When a new key is needed, add it with an empty value to `.env.example`.
- **No tests, no CI, no Docker** unless explicitly asked.
- Keep the app runnable with one command at all times. Don't leave `main` broken.
- After finishing a feature, update the **Status** section below.
- Commit messages: short and imperative ("add payslip upload").

## Stack
**TrustLayer**: one MCP server that sits on top of SD Worx's existing assistant (see README.md).
Node 24 + TypeScript (run with tsx) · MCP: `@modelcontextprotocol/sdk` + zod · API: Express 5 · Dashboard: Vite + React 19 + Tailwind v4 · Vault: plain markdown + YAML (`yaml`). No LLM at runtime: trust scoring is deterministic, claims are pre-extracted in `data/mock/claims-cache.json`.

## Run
- **Install first, after every pull:** `npm run setup` (root + `packages/brain`, two separate packages). Details, `.env` and agent rules: [brain/setup.md](brain/setup.md)
- `npm run dev` → dashboard + API on http://localhost:5173 (one process; builds `vault/` on first run)
- `npm run mcp` → MCP server on authenticated local stdio (configure `.env` per `docs/security/MCP_AUTH.md`) (Claude Code: `.mcp.json` is in the repo root)
- `npm run ingest` → rebuild the vault from `data/mock` (same as the reset icon in the dashboard)
- `npm run typecheck`

## Structure & ownership
- `data/mock/`: MOCK sources (SharePoint md, Teams/email json, HR directory, existing-assistant answers, claims cache)
- `src/core/`: `types.ts` is the shared contract. ingest, trust scoring (`trust.ts`), health radar (`health.ts`), fix loop (`tasks.ts`), experts, zod schemas
- `src/mcp/server.ts`: the 6 MCP tools. `src/api/server.ts`: Express API + Vite middleware
- `web/`: two screens. **Ask** (`views/Ask.tsx`, the spotlight): input + mic bottom-centre, Claude-plugin look; radar icon (live score) opens `views/RadarPanel.tsx`; "Email <owner>" drafts the question as an email. **Mail** (`views/Mail.tsx`, `#mail`): the owner mailbox; replying resolves the task. Mail is MOCK (a fix task, nothing is sent), see `web/src/mail.ts`
- `POST /api/transcribe`: ElevenLabs speech-to-text proxy (key server-side only)
- `vault/`: generated, gitignored. Never edit by hand, run `npm run ingest`
- Maximilian: initial MVP (all folders)
- Isaac:
- Antonios:
- Casper:

## Status
- [x] MCP session identity, central deny-by-default authorization and Brain IDOR registration guards; regression tests: `npm run test:security`
- [x] Security threat model and baseline findings documented (remediation status in `docs/security/FINDINGS.md`)
- [x] Project scaffold running
- [x] Core feature: trust verdict, health radar, flag → resolve loop, 6 MCP tools, API
- [x] Semi-headless Ask view with ElevenLabs voice input (typing fallback)
- [x] Ask owner by email + owner mailbox (reply = verify), radar as icon + slide-over, Live call view removed
- [ ] Aikido scan + fixes
- [ ] Video recorded (script: docs/demo-script.md)
