# Setup: how everyone installs everything

The repo has **two separate npm packages**. They are not an npm workspace, and each has its own `package-lock.json` and `node_modules`:
- the root: dashboard, API, MCP server (`src/`, `web/`)
- `packages/brain/`: the Brain layer (Casper), which has its own dependencies (PGlite, pg, vitest, eslint)

## TL;DR (every teammate and every agent)
```bash
git pull
npm run setup          # = npm install (root) + npm --prefix packages/brain install
cp .env.example .env   # PowerShell: Copy-Item .env.example .env; then fill in the MCP lines below
npm run dev            # dashboard + API → http://localhost:5173
```
Run `npm run setup` again **after every pull**. It's fast when nothing changed, and it's the only way to pick up new dependencies from teammates.

## What needs what
| You want to… | You need |
|---|---|
| Run the dashboard + API (`npm run dev`) | root install only |
| Use the MCP server (`npm run mcp`, or Claude Code via `.mcp.json`) | root install + `TRUSTLAYER_MCP_SESSION` and `TRUSTLAYER_MCP_VAULT_READERS` in `.env`. Without them the server refuses to start |
| Root `npm run typecheck` | root **and** brain install (the root tsconfig includes `test/security`, which imports `packages/brain`) |
| `npm run test:security` | root **and** brain install |
| Brain work (`npm --prefix packages/brain run typecheck / lint / test / seed`) | brain install. Postgres is optional (embedded PGlite by default). LLM: `BRAIN_LLM_PROVIDER=fake` needs nothing; the default `ollama` needs Ollama running locally |
| Voice input in the Ask screen | `ELEVENLABS_API_KEY` in `.env` (optional: typing always works) |

## `.env` for the demo
Copy the MOCK demo identity from [docs/security/MCP_AUTH.md](../docs/security/MCP_AUTH.md) into `.env`:
```dotenv
TRUSTLAYER_MCP_SESSION='{"id":"user:lotte.peeters","personId":"lotte.peeters","groups":["group:demo"],"roles":["reader","contributor","verifier"]}'
TRUSTLAYER_MCP_VAULT_READERS='["group:demo"]'
```
`.env` is read once at startup. After editing it, restart `npm run dev` and restart the MCP server in Claude Code (`/mcp` → restart, or reopen `claude`). Never commit `.env`.

To use the MCP server in your own Claude (Claude Code or the desktop chat app), follow [claude-mcp.md](claude-mcp.md). It also has a copy-paste prompt for your agent.

## Check that everything works
```bash
npm run typecheck        # root
npm run test:security    # 25 tests should pass
npm --prefix packages/brain run typecheck
```

## Rules for agents
- Install dependencies with `npm run setup` before building or type-checking; don't report "missing module" errors without running it first.
- Add a new dependency to the package that uses it: root for `src/`/`web/`, `packages/brain` for Brain code. Say which one in your summary, and commit its `package-lock.json` together with its `package.json`.
- Don't turn the repo into a workspace or move dependencies between the two packages without agreeing with the team first.

## Known issue (30 Sept, 21:05)
After a full install, root `npm run typecheck` still reports **1 error** in `test/security/mcp.test.ts:71`: the fixture misses the `referenceOnly` field that the Brain claim-alignment change made required. The tests themselves run and pass (25/25). The owner of the security tests should add the field.
