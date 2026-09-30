# Judging, deadlines & scoring

## Logistics
- **Submissions close 22:30** (30 Sept 2026).
- Deliverable: working demo + short presentation video. No live pitch.
- Prize: €10,000.
- Team rooms are listed on the floor plans on the doors and columns.

## Aikido security = 10% of the score
Aikido (security platform, partner of the event) scores how secure each project is.

**How it works:**
1. Sign up through the Aikido link/QR code from the talk. It gives **500 free credits**. *(Link not recorded here. Get it from the slide photo or organizers.)*
2. Connect our **GitHub repo** (`Maxikozie/good-will-prompting`) to Aikido.
3. When the project is **almost done**, run the **AI source code analysis** (AI SAST / "AI source audit").
4. **Fix as many of the reported vulnerabilities as possible.** Score depends on how many we fix.

**What it can find:** classic SAST issues (SQL injection, etc.), plus logic bugs and authentication issues via AI agents. Also dependency, secret and container scanning.

**Our plan:**
- Run the scan by **~21:00** at the latest. Fixing takes time and 22:30 is a hard stop.
- One person owns the Aikido scan + fixes.
- Cheap wins up front: no secrets in code (`.env` only), no `eval`/raw SQL string building, sanitize user input, keep dependencies minimal and current.
- Fake auth is fine for the demo, but label it `// MOCK`. Expect Aikido to flag it anyway.

## What SD Worx judges want (see [challenge.md](challenge.md))
- A focused PoC on **one** problem, not everything.
- Makes knowledge easier to **find, trust, share**.
- **Not** a SharePoint-with-search, **not** another AI agent.
