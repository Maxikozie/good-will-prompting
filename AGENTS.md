# Good Will Prompting — Tectonic Hackathon Ghent

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
<!-- fill in once decided, e.g. frontend / backend / LLM provider + model -->

## Run
<!-- e.g. npm install && npm run dev -->

## Structure & ownership
<!-- who works on what, so agents know what not to touch -->
- Maximilian:
- Isaac:
- Antonios:
- Casper:

## Status
- [ ] Project scaffold running
- [ ] Core feature
- [ ] UI polish for demo
- [ ] Video recorded
