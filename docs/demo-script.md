# Demo video script (~3 min)

Before recording: put `ELEVENLABS_API_KEY=...` in `.env`, run `npm run dev`, open http://localhost:5173 at 1920×1080 and click **Reset** (faint, top right). Allow the microphone once. Have Claude Code open in this repo with the `trustlayer` MCP server approved.

The main screen is "semi-headless": an empty page with one input bar and a mic, like a Claude plugin. **Radar**, **Inbox** and **Reset** are faint links in the top-right corner.

## 1. The question (20 s)
> "A customer calls SD Worx: what's the Sunday overtime premium for Nordwind Retail employees in Belgium?"

Click the **mic**, say the question, click the mic again to stop. It's transcribed by ElevenLabs and sent automatically. If voice fails, just type it and press Enter.
Two tool-call lines appear: *SD Worx Assistant · returned 3 documents*, then *trustlayer › verify_sources · 4 sources scored*.

## 2. The trust verdict (40 s)
> "TrustLayer doesn't replace SD Worx's assistant. It sits on top of it, as one MCP server."

- The answer: **120%**, trust **77**, amber **Not verified yet**: it comes from Lotte Peeters' Teams message, the accountable Nordwind BE payroll owner. Tagged **Found by TrustLayer**: the assistant missed it.
- Red line: **Conflict**, 3 sources disagree: 120% vs 50% vs 100%.
- The rows: the 2022 doc has **No owner** (100%), the KB page is an **Unverified change** (50%), the NL doc is **NL ≠ BE**.
- Click **Ask Lotte Peeters** → "Sent to Lotte Peeters' inbox".

## 3. The radar (30 s): Knowledge radar view
> "Every conflict we hit while answering feeds the radar."

Health score **58**. Point at: the conflict (assigned to Lotte), the orphaned 2022 doc and bonus email, the stale meal-voucher page, and the gap: "bicycle allowance NL" asked 3 times and nobody could answer. Optionally click **Assign** on the gap.

## 4. The owner fixes it once (30 s): Inbox (top right)
Viewing as Lotte. The task shows the conflicting claims and the suggested answer (her own Teams message). Click **Resolve & verify**.
> "Lotte fixes it once, for everyone. The chat is captured into the wiki, the wrong docs are superseded."

Go to the radar: the score jumps **58 → 84**.

## 5. The next colleague gets a trusted answer (20 s)
In the inbox click **Ask the question again →** (or go back and ask it with the mic). Below the first answer: **✓ Verified by Lotte Peeters**, score 100, old docs marked superseded.

## 6. It plugs into any agent (30 s): Claude Code
Prompt:
> A customer asks what the Sunday overtime premium is for Nordwind Retail employees in Belgium. Our assistant returned sp-nordwind-be-overtime-2022, sp-cs-be-kb-overtime and sp-nordwind-nl-premiums. Which one should I trust? Use TrustLayer.

Claude calls `verify_sources` and answers with the verified 120%. Optional second prompt: *"What does the knowledge health look like, and who should fix the bicycle allowance gap?"* (`knowledge_health` + `flag_for_owner`); the dashboard updates live.

## Closing line
> "SD Worx doesn't need another search box or another agent. It needs its existing agents to know what to trust. TrustLayer: one MCP server that gives every answer a source verdict and turns every conflict into knowledge that gets fixed once, for everyone."

Tip: to show the "before" state again, click **Reset** (top right). To rehearse without touching the demo vault, run with `TRUSTLAYER_VAULT_DIR=./vault-rehearsal`.
