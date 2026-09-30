# Use the TrustLayer MCP server in your own Claude

Every teammate can plug TrustLayer into their own Claude: **Claude Code** (terminal / Code tab) or **Claude chat** (desktop app). It runs locally from your clone of this repo, on the mock data.

Two ways to set it up:
- **Do it yourself:** follow the steps below (~5 min).
- **Let your agent do it:** paste the [prompt at the bottom](#prompt-for-your-agent) into Claude Code or Codex, opened in this repo.

## 1. Prerequisites (everyone)
1. `git pull` on `main`, then `npm run setup` in the repo root. This installs the root and `packages/brain`; see [setup.md](setup.md).
2. A `.env` in the repo root with the MOCK demo identity. Without it the MCP server refuses to start:
   ```dotenv
   TRUSTLAYER_MCP_SESSION='{"id":"user:lotte.peeters","personId":"lotte.peeters","groups":["group:demo"],"roles":["reader","contributor","verifier"]}'
   TRUSTLAYER_MCP_VAULT_READERS='["group:demo"]'
   ```
   `.env` is gitignored: never commit it. The identity is fictional (Lotte Peeters, the Nordwind BE owner), so `resolve` works in the demo.
3. Node 24 on your PATH (`node -v`).

## 2a. Claude Code (easiest)
The repo already has [`.mcp.json`](../.mcp.json).
1. Start `claude` **in the repo root** (the server path in `.mcp.json` is relative).
2. Approve the `trustlayer` server when asked, or run `/mcp` and enable it.
3. Check: `/mcp` shows `trustlayer · connected` with 6 tools.

## 2b. Claude chat (desktop app)
1. Open **Settings → Developer → Edit Config**. That opens the right file for your install:
   | Install | Config file |
   |---|---|
   | Windows (installer) | `%APPDATA%\Claude\claude_desktop_config.json` |
   | Windows (Microsoft Store) | `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\claude_desktop_config.json` |
   | macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
2. Add a top-level `"mcpServers"` key. **Keep everything else in the file**; if it already has `mcpServers`, just add the `trustlayer` entry inside it. Replace `<REPO>` with the absolute path of your clone, using forward slashes:
   ```json
   "mcpServers": {
     "trustlayer": {
       "command": "node",
       "args": [
         "--import",
         "file:///<REPO>/node_modules/tsx/dist/loader.mjs",
         "<REPO>/src/mcp/stdio.ts"
       ]
     }
   }
   ```
   - Windows: `<REPO>` looks like `C:/Users/you/Documents/good-will-prompting`, so the loader line becomes `file:///C:/Users/you/...`.
   - macOS: `<REPO>` looks like `/Users/you/good-will-prompting`, so the loader line becomes `file:///Users/you/...`.
   - The desktop app doesn't start in your repo folder, so the paths must be absolute. It also doesn't always see your shell's PATH (common with nvm or Homebrew on macOS): if the server fails with "node not found", put the full path from `which node` / `where node` in `"command"`.
3. **Fully quit** Claude (tray/menu bar icon → Quit; closing the window isn't enough) and open it again.
4. In a new chat: **+ → Connectors → trustlayer**, make sure its switch is on. When Claude first uses a tool, pick **Allow always**.
5. If it doesn't show up: **Settings → Developer** lists the server as *running* or *failed*, with a log.

## 3. Try it
Add "use TrustLayer" to your prompt, or Claude may answer from its own knowledge.
| Ask | Expect |
|---|---|
| "What is the Sunday overtime premium for Nordwind Retail employees in Belgium? Check it with TrustLayer." | 120% from Lotte's Teams message (trust 77), not verified, 3-way conflict |
| "Our assistant returned sp-nordwind-be-overtime-2022, sp-cs-be-kb-overtime and sp-nordwind-nl-premiums for that question. Which one should I trust? Use TrustLayer." | `verify_sources`: per-document scores and reasons (orphan, unverified change, NL ≠ BE) |
| "What night premium does Nordwind Retail pay in Belgium?" | 25%, verified |
| "Do Nordwind Retail NL employees get a bicycle commuting allowance?" | no trusted answer: a knowledge gap |
| "How healthy is our Nordwind Retail knowledge?" | `knowledge_health`: score 58, conflicts, orphans, stale, gaps |
| "I'm taking over the Nordwind Retail portfolio. Who do I need to talk to?" | `find_expert`: Lotte Peeters, Marc Claes |
| "Flag the Sunday overtime conflict to the owner." then "I'm Lotte Peeters. Resolve that task: 120% since 1 September 2026 under the new JC 311 CLA." then ask the first question again | the answer becomes verified (score 100) |

## Good to know
- **Everyone has their own vault.** The server reads `vault/` in *your* clone, so a task you flag or resolve only exists on your machine. To see chat actions live on the dashboard, run `npm run dev` from the **same folder** the MCP server points to.
- **Reset the demo:** the reset icon in the dashboard, or `npm run ingest`.
- **"403 Forbidden" from a tool:** the two `.env` lines are missing or mistyped. Fix them, then restart Claude (or `/mcp` → reconnect in Claude Code).
- **"Cannot find ... loader.mjs":** run `npm run setup` in `<REPO>`.
- **Don't** share your `.env` or config through git, and don't point your Claude at someone else's folder.

## Prompt for your agent
Open Claude Code or Codex **in the repo root** and paste this:

```text
Set up the TrustLayer MCP server from this repo in my Claude. Read brain/claude-mcp.md first; it is the source of truth.

1. Run `git pull` on main and `npm run setup` in the repo root. Stop and tell me if either fails.
2. Make sure a `.env` exists in the repo root with the two MOCK demo lines from brain/claude-mcp.md section 1 (TRUSTLAYER_MCP_SESSION and TRUSTLAYER_MCP_VAULT_READERS). If `.env` already exists, only add or replace those two lines and keep everything else. Never commit `.env`; check that `git check-ignore .env` confirms it's ignored.
3. Check that the server starts: run `node --import tsx src/mcp/stdio.ts` from the repo root with stdin closed. It must print "ready on authenticated local stdio" on stderr. If it fails, show me the error.
4. Ask me which Claude I use: Claude Code, the Claude desktop app (chat), or both.
   - Claude Code: nothing to install, `.mcp.json` is in the repo. Tell me to start `claude` in the repo root and approve `trustlayer` (or enable it with `/mcp`).
   - Desktop app: find my claude_desktop_config.json (the paths for Windows installer, Windows Microsoft Store and macOS are in brain/claude-mcp.md). If there are several candidates, pick the most recently modified one, or ask me to open Settings → Developer → Edit Config. Back up the file first. Then merge in `mcpServers.trustlayer` with absolute paths to this repo (see the JSON in section 2b). Parse and rewrite the JSON: don't hand-edit strings and don't drop any existing keys. Use "node" as the command, unless the desktop app can't find it (nvm or Homebrew on macOS); then use the absolute path from `which node` / `where node`. Validate that the file is still valid JSON.
5. Test the exact desktop command from my home folder (not the repo): do an MCP handshake with @modelcontextprotocol/sdk's Client + StdioClientTransport, list the tools (expect 6: verify_sources, trusted_answer, knowledge_health, flag_for_owner, resolve, find_expert) and call trusted_answer with "What is the Sunday overtime premium for Nordwind Retail employees in Belgium?". Put the test script in a temp folder and delete it afterwards.
6. Tell me the remaining manual steps: fully quit and reopen Claude, then + → Connectors → turn on trustlayer, and pick "Allow always" on the first tool call. Give me 3 example questions from brain/claude-mcp.md section 3.
Don't change any other files in the repo and don't commit anything.
```
