# Demo video script (~3 min)

Before recording: `npm run dev`, open http://localhost:5173 at 1920×1080, click **Reset demo** (footer). Have Claude Code open in this repo with the `trustlayer` MCP server approved.

## 1. The problem (20 s): Live call view
> "A customer calls SD Worx: what's the Sunday overtime premium for Nordwind Retail employees in Belgium? Our colleague Nina asks the existing assistant."

Click **Ask**. Point at the left column: 3 bare documents. No owner, no date, no country. "Which one do you trust?"

## 2. The trust verdict (40 s): right column
> "TrustLayer doesn't replace that assistant. It sits on top of it, as one MCP server."

- Doc A says 100%: **orphan**, nobody owns it, written in 2022.
- Doc B says 50%: edited last week, **never verified**.
- Doc C has the right title but applies to **the Netherlands**.
- TrustLayer found what the assistant missed: Lotte Peeters, the accountable Nordwind BE payroll owner, posted the new rule in **Teams** after the CLA change: **120%**. Recommended, but it only lives in a chat.
- Red callout: 3 sources disagree. Click **Ask owner** → "Sent to Lotte Peeters' inbox".

## 3. The radar (30 s): Knowledge radar view
> "Every conflict we hit while answering feeds the radar."

Health score **58**. Point at: the conflict (assigned to Lotte), the orphaned 2022 doc and bonus email, the stale meal-voucher page, and the gap: "bicycle allowance NL" asked 3 times and nobody could answer. Optionally click **Assign** on the gap.

## 4. The owner fixes it once (30 s): Owner inbox
Viewing as Lotte. The task shows the conflicting claims and the suggested answer (her own Teams message). Click **Resolve & verify**.
> "Lotte fixes it once, for everyone. The chat is captured into the wiki, the wrong docs are superseded."

Go to the radar: the score jumps **58 → 84**.

## 5. The next colleague gets a trusted answer (20 s): Live call
Ask the same question again: **green Verified by Lotte Peeters today**, score 100, old docs marked superseded.

## 6. It plugs into any agent (30 s): Claude Code
Prompt:
> A customer asks what the Sunday overtime premium is for Nordwind Retail employees in Belgium. Our assistant returned sp-nordwind-be-overtime-2022, sp-cs-be-kb-overtime and sp-nordwind-nl-premiums. Which one should I trust? Use TrustLayer.

Claude calls `verify_sources` and answers with the verified 120%. Optional second prompt: *"What does the knowledge health look like, and who should fix the bicycle allowance gap?"* (`knowledge_health` + `flag_for_owner`); the dashboard updates live.

## Closing line
> "SD Worx doesn't need another search box or another agent. It needs its existing agents to know what to trust. TrustLayer: one MCP server that gives every answer a source verdict and turns every conflict into knowledge that gets fixed once, for everyone."

Tip: to show the "before" state again, click **Reset demo**. To rehearse without touching the demo vault, run with `TRUSTLAYER_VAULT_DIR=./vault-rehearsal`.
