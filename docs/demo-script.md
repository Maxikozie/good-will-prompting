# Demo video script (~3 min)

Before recording: run `npm run dev`, open http://localhost:5173 at 1920×1080 and click the **reset icon** (top right). Have Claude Code open in this repo with the `trustlayer` MCP server approved. Voice is optional: with `ELEVENLABS_API_KEY` in `.env` the mic works, otherwise type the question.

There are only two screens:
- **Ask** (the spotlight): an empty page with one input bar and a mic, like a Claude plugin. Top right: a **radar icon with the live health score**, a **mail icon** and a **reset icon**.
- **Mail**: the owner's mailbox. Asking a colleague for the right answer happens by email, and their reply becomes the verified answer.

## 1. The question (20 s)
> "A customer calls SD Worx: what's the Sunday overtime premium for Nordwind Retail employees in Belgium?"

Ask it with the **mic** (click, speak, click again) or type it and press Enter.
Two tool-call lines appear: *SD Worx Assistant · returned 3 documents*, then *trustlayer › verify_sources · 4 sources scored*.

## 2. The trust verdict (40 s)
> "TrustLayer doesn't replace SD Worx's assistant. It sits on top of it, as one MCP server."

- The answer: **120%**, trust **77**, amber **Not verified yet**. It comes from Lotte Peeters' Teams message; she's the accountable Nordwind BE payroll owner. Tagged **Found by TrustLayer**: the assistant missed it.
- Red line: **Conflict**, 3 sources disagree: 120% vs 50% vs 100%.
- The rows: the 2022 doc has **No owner** (100%), the KB page is an **Unverified change** (50%), the NL doc is **NL ≠ BE**.

## 3. Ask the owner, by email (20 s)
Click **✉ Email Lotte Peeters**. An email draft opens with the question and the 3 conflicting sources already filled in. Click **Send** → "Email sent to Lotte Peeters · waiting for a reply".

## 4. The radar (20 s)
> "Every conflict we hit while answering feeds the radar."

Click the **radar icon** (it shows **58**). The slide-over lists the conflict ("Emailed Lotte"), the ownerless 2022 doc and bonus email, the stale meal-voucher page, and the unanswered question: "bicycle allowance NL", asked 3 times. Optionally click **Email owner** on it. Close the panel.

## 5. The owner fixes it once (30 s): Mail
Click the **mail icon**. Lotte's mailbox shows Nina's email. The reply box is prefilled with the answer from her own Teams message. Click **Send reply** → "✓ Verified in TrustLayer · 2 outdated sources superseded".
> "Lotte answers once, for everyone. The chat is captured into the wiki, the wrong docs are superseded."

## 6. The next colleague gets a trusted answer (20 s)
Click **Ask the question again →**. Below the first answer: **✓ Verified by Lotte Peeters**, score **100**, old docs superseded. The radar icon now shows **84 ▲26**.

## 7. It plugs into any agent (30 s): Claude Code
Prompt:
> A customer asks what the Sunday overtime premium is for Nordwind Retail employees in Belgium. Our assistant returned sp-nordwind-be-overtime-2022, sp-cs-be-kb-overtime and sp-nordwind-nl-premiums. Which one should I trust? Use TrustLayer.

Claude calls `verify_sources` and answers with the verified 120%. Optional second prompt: *"What does the knowledge health look like, and who should fix the bicycle allowance gap?"* (`knowledge_health` + `flag_for_owner`). The radar score and mail badge update live.

## Closing line
> "SD Worx doesn't need another search box or another agent. It needs its existing agents to know what to trust. TrustLayer: one MCP server that gives every answer a source verdict and turns every conflict into knowledge that gets fixed once, for everyone."

Tip: to show the "before" state again, click the **reset icon** (top right). To rehearse without touching the demo vault, run with `TRUSTLAYER_VAULT_DIR=./vault-rehearsal`.
