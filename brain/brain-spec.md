# Brain — Specification v1

> **Repo-noot:** dit is de volledige Brain-spec (Casper). De MVP in de repo is **TrustLayer** (zie
> [solution.md](solution.md)): deterministische trust-score per bron, vault in markdown, health radar en
> flag → resolve loop, zonder DB of LLM. Deze spec is de uitbreiding/roadmap: claim-niveau, slots, attributie
> in %, reference-corpus (wiki), verificatietokens en een 8-assige radar. Delen die al bestaan in TrustLayer:
> ownership/freshness/scope/authority/corroboration-score (`src/core/trust.ts`), conflicten, orphans,
> owner-inbox (`src/core/tasks.ts`), `find_expert`. Delen die nieuw zijn: §3 claims met spans, §4 slots,
> §1 twee corpora, §9 attributie, §10 tokens/four-eyes, §11 radar-assen.

## 0. One-paragraph summary
For a question Q, the agent returns case documents A..N. The Brain:
(1) snapshots them, (2) extracts atomic claims, (3) aligns claims across
documents into facts and labels each relation (agree / contradict / refine /
supersede / different scope), (4) detects gaps against an expected answer shape
(slots), (5) searches the **separate** wiki corpus only to close those gaps or
corroborate weak facts, (6) adjudicates every fact with deterministic rules,
(7) computes per-source contribution (e.g. A 90%, B 3%, C 2%, Wiki 5%),
(8) composes a cited verdict, and (9) routes whatever still needs confirmation
to the right owner via authenticated "Ask the owner".

```
Question ─► 00 Intake ─► 10 Snapshot ─► 20 Extract ─► 30 Align ─► 40 Gaps
                                                              │
                                   ┌──────────────────────────┘
                                   ▼
                     50 Enrich (reference corpus only, gap-targeted)
                                   ▼
          60 Adjudicate ─► 70 Attribute ─► 80 Compose ─► 90 Route & Write-back
                                                          (verification, canonical, health)
```

---

## 1. The two corpora (hard separation)

| | Evidence corpus | Reference corpus |
|---|---|---|
| What | Case documents A..N returned for Q | Wiki pages, general company knowledge |
| Role | Primary evidence for the answer | Context, gap-filling, corroboration |
| DB schema | `evidence.*` | `reference.*` |
| Vector index | `evidence.passage_embedding` | `reference.section_embedding` |
| ID types | `EvidenceDocId`, `EvidenceClaimId` | `WikiPageId`, `ReferenceFactId` |
| Code | `src/evidence/**` | `src/reference/**` |
| Default authority prior | by source type (see §9) | 0.5 unless page is `official` + owned |
| Can reach VERIFIED alone? | yes (with owner/authority verification) | **no** — max status `PROVISIONAL` without evidence or owner confirmation |

Bridge edges (only created in `src/pipeline/**`):
`CORROBORATES`, `CONTRADICTS`, `FILLS_GAP`, `ADDS_CONTEXT`, `DERIVED_FROM`.

**Circularity guard:** a wiki section that is a copy of a case document (or vice
versa) is not independent evidence. Detect with any of: SimHash Hamming ≤ 3 on
passage text, cosine ≥ 0.93, or an explicit link/citation to the doc URL.
Then create `DERIVED_FROM` and merge them into one **independence group**.
Independence groups count once for consensus and share credit in attribution.

---

## 2. Graph model

All nodes have `id`, `createdAt`, `namespace` (`evidence` | `reference` | `brain` | `org`).

### 2.1 Nodes

**Run & query (`brain`)**
- `CaseRun { id, question, principalId, intent: QueryIntent, status, rulesVersion, promptVersions, modelIds, evidenceSnapshotIds[], referenceSnapshotIds[], startedAt, finishedAt }`
- `QueryIntent { subject, scope: Scope, questionType: 'rule'|'procedure'|'amount'|'deadline'|'eligibility'|'other', slotTemplateId, generatedSlots: bool }`
- `Scope { country, region?, jointCommittee? /* paritair comité, e.g. PC 200 */, employeeCategory? /* bediende|arbeider|… */, product? /* pay|hr|time */, customerId?, language? }`

**Evidence (`evidence`)**
- `EvidenceDocument { id, sourceSystem: 'sharepoint'|'teams'|'email'|'manual'|'ticket'|'other', sourceUri, title, ownerId?, authorId?, lastEditedAt, lastVerifiedAt?, verifiedTier?, validUntil?, declaredScope: Partial<Scope>, allowedPrincipals[] }` — the logical document
- `EvidenceSnapshot { id, documentId, contentHash, text, fetchedAt, version }` — immutable, what the run actually read
- `EvidencePassage { id, snapshotId, ordinal, start, end, text, embedding }`
- `EvidenceClaim` — see §3

**Reference (`reference`)**
- `WikiPage { id, space, title, uri, ownerId?, official: bool, lastEditedAt, lastVerifiedAt?, declaredScope, allowedPrincipals[], outLinks[] }`
- `WikiSnapshot { id, pageId, contentHash, text, fetchedAt }`
- `WikiSection { id, snapshotId, headingPath[], start, end, text, embedding }`
- `ReferenceFact` — same shape as `Claim` (§3), origin `reference`

**Brain (`brain`)**
- `Fact` (= aligned proposition) `{ id, runId, claimKey, subject, attribute, scope, slotId?, status, confidence, winnerClaimId?, winningValue?, reasons[], needsVerification: bool, impact: 'high'|'medium'|'low' }`
- `Gap { id, runId, type, slotId?, factId?, description, closedBy?: ReferenceFactId[], status: 'open'|'closed'|'partially_closed' }`
- `Conflict { id, runId, factId, type, severity, claimIds[], resolution?, resolvedBy?: 'rule'|'owner', status }`
- `Canonical { key /* subject|attribute|scopeKey */, value, factId, runId, confidence, verifiedTier, nextReviewAt }`
- `Attribution { runId, sourceKind: 'evidence'|'reference', sourceId, contributionPct, acceptedClaims, rejectedClaims, reliabilityPct }`
- `VerificationRequest { id, factId, requestedFromId, reason, status, tokenJti, expiresAt }`
- `VerificationEvent { id, factId, claimId?, verifierId, action, tier, payload, at }` (append-only)
- `OrgEvent { id, type: 'law_change'|'indexation'|'cao_update'|'reorg'|'owner_left', scope, domain, effectiveAt }`

**Org (`org`)**
- `Person { id, name, email, team, country, active, principalIds[] }`
- `Expertise { personId, subject/domain, country, weight 0..1 }` (derived, see §11)

### 2.2 Edges (`edge { id, type, fromId, fromKind, toId, toKind, props jsonb, runId? }`)
| Type | From → To | Props |
|---|---|---|
| `ASSERTS` | Snapshot/WikiSnapshot → Claim/ReferenceFact | span |
| `MEMBER_OF` | Claim/ReferenceFact → Fact | role: 'winner'|'support'|'rejected'|'context' |
| `AGREES` | Claim → Claim | similarity |
| `CONTRADICTS` | Claim → Claim | type, severity, explanation |
| `REFINES` | Claim → Claim | addedQualifiers |
| `SUPERSEDES` | Claim → Claim | basis: 'temporal'|'authority'|'owner' |
| `SCOPE_DISJOINT` | Claim → Claim | differingScopeKeys |
| `DUPLICATE_OF` | Passage → Passage | method, score |
| `DERIVED_FROM` | Snapshot/Section → Snapshot/Section | method, score |
| `CORROBORATES` / `FILLS_GAP` / `ADDS_CONTEXT` | ReferenceFact → Fact / Gap | score |
| `OWNS` | Person → Document/WikiPage/Claim | since |
| `VERIFIED` | Person → Claim/Fact | tier, at, expiresAt |
| `EXPERT_IN` | Person → subject×country | weight |
| `INVALIDATES` | OrgEvent → subject×scope | effectiveAt |
| `RESOLVES` | Canonical → Fact | |

---

## 3. Claim schema (shared by EvidenceClaim and ReferenceFact)

```ts
Claim {
  id; origin: 'evidence' | 'reference';
  sourceId;            // EvidenceDocId | WikiPageId
  snapshotId; passageId;
  span: { start: number; end: number }; quote: string /* ≤ 300 chars, verbatim */;
  subject: string;     // canonical dotted id, e.g. "leave.small_leave.own_marriage"
  attribute: string;   // e.g. "duration", "eligibility", "timing_window", "pay_continuation", "proof_required", "legal_basis", "effective_from"
  value: { type: 'number'|'text'|'date'|'bool'|'enum'|'range'; raw: string; normalized: unknown; unit?: 'days'|'hours'|'eur'|'pct'|'weeks'|'months' };
  qualifiers: Partial<Scope> & { conditions: string[] };
  temporal: { effectiveFrom?: string; effectiveTo?: string; statedAsOf?: string };
  polarity: 'affirms' | 'negates';
  modality: 'rule' | 'example' | 'opinion' | 'question' | 'unknown';
  extractionConfidence: number; // 0..1, from extractor, used only as a small factor
  claimKey: string;    // sha1(subject|attribute|scopeKey(qualifiers ⊕ declaredScope))
}
```
Rules: `modality !== 'rule'` claims never win a fact. Scope for a claim =
claim qualifiers, falling back to the document's `declaredScope`. A claim with
no country and a document with no country gets `country: null` → reason
`SCOPE_UNDECLARED` (penalized, flagged as gap `MISSING_SCOPE`).

Value normalization is deterministic code, not LLM: "twee dagen", "2 d",
"2 werkdagen" → `{normalized: 2, unit: 'days'}` (keep `raw`); dates → ISO;
amounts → EUR cents.

---

## 4. Slot templates (defines the expected answer shape)

`slots/<subject>.yaml`:
```yaml
subject: leave.small_leave.own_marriage
label: "Klein verlet — eigen huwelijk"
impact: high
slots:
  - { id: duration,         attribute: duration,         required: true,  weight: 1.0,  valueType: number, unit: days }
  - { id: eligibility,      attribute: eligibility,      required: true,  weight: 1.0 }
  - { id: timing_window,    attribute: timing_window,    required: true,  weight: 0.8 }
  - { id: pay_continuation, attribute: pay_continuation, required: true,  weight: 0.8 }
  - { id: proof_required,   attribute: proof_required,   required: false, weight: 0.5 }
  - { id: legal_basis,      attribute: legal_basis,      required: false, weight: 0.5 }
  - { id: effective_from,   attribute: effective_from,   required: false, weight: 0.25 }
halfLifeDays: 365
```
Unknown subject → intake LLM proposes slots, marked `generatedSlots: true`
(required slots then weigh 0.8 instead of 1.0 and the verdict says so).

---

## 5. Pipeline stages (each stage = pure-ish function, input/output zod-typed, persisted)

**00 Intake** — Q + principal → `QueryIntent` (LLM, schema-validated) → load slot template.

**10 Snapshot** — Receive A..N from the existing agent/MCP (IDs or payloads).
Hash, store `EvidenceSnapshot`, apply ACL filter, dedupe by `contentHash`.
Split into passages (heading-aware, ~150–400 tokens, keep offsets). Embed.
Detect `DUPLICATE_OF` between passages of different case docs.

**20 Extract** — Per passage, LLM extracts claims → zod → deterministic normalizer
→ compute `claimKey`. Discard claims whose `quote` is not found verbatim in the
passage (anti-hallucination check). Cache by `(passageHash, promptVersion, modelId)`.

**30 Align** — Group claims into `Fact`s:
1. exact `claimKey` match → same fact;
2. same subject+attribute, overlapping scope → candidate; embedding sim ≥ 0.82 → same fact;
3. borderline (0.70–0.82) → LLM relation classifier.
Then label every intra-fact pair: `AGREES` | `CONTRADICTS` | `REFINES` | `SUPERSEDES` (candidate only, confirmed in 60) | `SCOPE_DISJOINT`.
Deterministic contradiction first: same normalized type & unit and values differ
(numbers: tolerance 0; ranges: non-overlapping; bool/enum: different) or opposite
polarity. LLM only for `text` values, with a mandatory one-sentence explanation.
Claims whose scope is disjoint from the query scope → `REJECTED` / `SCOPE_MISMATCH`
(kept in graph for explanation, never deleted).

**40 Gaps** — Compare facts against slots:
| Gap type | Trigger |
|---|---|
| `MISSING_SLOT` | required/optional slot with no fact |
| `UNRESOLVED_CONFLICT` | fact has open `CONTRADICTS` after pre-adjudication |
| `WEAK_SUPPORT` | best claim score < 60 or single low-authority source |
| `MISSING_SCOPE` | winning candidate lacks country/joint committee needed by query |
| `MISSING_TEMPORAL` | no effective date and slot template `impact: high` |

**50 Enrich (reference only)** — For each open gap, build targeted queries from
`subject + attribute + scope` (never the raw question alone). Budget: ≤ 3 queries
per gap, ≤ 12 per run, top-k 5, scope-filtered on country when metadata exists,
max 1 link-hop to pages whose title matches the subject. Extract `ReferenceFact`s
with the same extractor (reference prompt variant). Link: `FILLS_GAP`,
`CORROBORATES`, `CONTRADICTS`, `ADDS_CONTEXT`. Run circularity guard (§1).
Enrichment may also be triggered for `WEAK_SUPPORT` facts to seek independent corroboration.

**60 Adjudicate** — Deterministic rules (§7) + scoring (§8) → per fact:
`status`, `confidence`, `winnerClaimId`, `reasons[]`, `needsVerification`.

**70 Attribute** — §9.

**80 Compose** — Build `CaseVerdict` (§12). Answer text is generated from facts
with status ≥ `LIKELY` only, one sentence per slot, each sentence citing its
claim spans. LLM may only rephrase provided facts (post-check: every number/date
in the output must exist in a cited fact; else fall back to template text).

**90 Route & write-back** — Create `VerificationRequest`s (§10), upsert
`Canonical` for facts `VERIFIED`/`LIKELY` with confidence ≥ 80, emit health metrics (§11).

---

## 6. Fact statuses & reason codes

Statuses: `VERIFIED` · `LIKELY` · `DISPUTED` · `PROVISIONAL` · `REJECTED` · `UNKNOWN`

- `VERIFIED` — winner has verification tier ≥ T3 (not decayed below 0.5, not expired), no open high-severity conflict.
- `LIKELY` — confidence ≥ 70, no unresolved high-severity conflict.
- `DISPUTED` — unresolved contradiction after the ladder.
- `PROVISIONAL` — supported only by reference facts, or by a single source with confidence < 70.
- `REJECTED` — per-claim label for losing/invalid claims (fact itself keeps the winner's status).
- `UNKNOWN` — slot with no fact after enrichment.

`needsVerification = status ∈ {DISPUTED, PROVISIONAL} ∨ (status = LIKELY ∧ impact = high)`.

ReasonCode enum (extend only via DECISIONS.md):
`SCOPE_MISMATCH, SCOPE_UNDECLARED, SUPERSEDED_TEMPORAL, SUPERSEDED_BY_AUTHORITY,
CONTRADICTED_BY_AUTHORITY, CONTRADICTED_BY_CONSENSUS, EXPIRED, INVALIDATED_BY_EVENT,
NO_OWNER, OWNER_INACTIVE, EDITED_AFTER_VERIFICATION, VERIFICATION_DECAYED,
UNVERIFIED, NEWER_BUT_UNVERIFIED, DERIVED_COPY, NOT_A_RULE, REFERENCE_ONLY,
CORROBORATED_INDEPENDENT, AUTHORITATIVE_SOURCE, OWNER_VERIFIED, DUPLICATE_OLDER_VERSION`

---

## 7. Adjudication ladder (`rules/rules.yaml`, evaluated in order per fact)

```yaml
version: 1
ladder:
  - id: 1_scope_split
    when: claims differ only in scope keys (country, jointCommittee, employeeCategory, customer)
    then: relabel pair SCOPE_DISJOINT; keep only claims matching query scope; no conflict
  - id: 2_duplicate_older
    when: DUPLICATE_OF across docs and one snapshot is an older version
    then: older → REJECTED(DUPLICATE_OLDER_VERSION); newer inherits as support, not as independent
  - id: 3_authority
    when: exactly one side has tier T4 or source authority 1.0
    then: that side wins; other → REJECTED(CONTRADICTED_BY_AUTHORITY); correction task to its owner
  - id: 4_temporal_supersession
    when: same scope AND newer.effectiveFrom/lastVerifiedAt > older AND newer.tier >= older.tier
    then: newer SUPERSEDES older → older REJECTED(SUPERSEDED_TEMPORAL), capped score 20
  - id: 5_newer_but_unverified   # "newest ≠ correct"
    when: newer by lastEditedAt but newer.tier < older.tier
    then: older wins provisionally; newer flagged NEWER_BUT_UNVERIFIED; conflict stays OPEN but
          downgraded to severity medium (a provisional winner exists); fact max LIKELY; needsVerification
  - id: 6_consensus
    when: ≥ 2 independent groups (after DERIVED_FROM merge) agree AND score gap ≥ 20 over dissent
    then: majority wins; dissent REJECTED(CONTRADICTED_BY_CONSENSUS); status max LIKELY until owner confirms
  - id: 7_escalate
    otherwise: status DISPUTED; VerificationRequest to owners of all contradicting claims
```

Old vs new matrix (must be covered by unit tests):
| | old verified | old unverified |
|---|---|---|
| **new verified** | new wins (rule 4) | new wins (rule 4) |
| **new unverified** | old wins provisionally + OPEN conflict (rule 5) | both weak → rule 6 or 7 |

---

## 8. Scoring

### 8.1 Claim score (0–100, stored)
```
ClaimScore = 100 × (0.30·V + 0.20·A + 0.15·O + 0.15·C + 0.10·I + 0.10·U) − ConflictPenalty
```
| Component | Definition |
|---|---|
| V verification | `tierWeight × 0.5^(daysSinceVerified / halfLifeDays)`; tiers T0 0, T1 0.3, T2 0.6, T3 0.85, T4 1.0 |
| A authority | evidence: law/CAO 1.0 · owner-maintained policy/manual 0.85 · SharePoint doc 0.7 · ticket resolution 0.5 · Teams 0.4 · email 0.3 · unknown 0.2 — reference: 0.5 (official+owned page 0.7) |
| O ownership | active owner 1.0 · owner inactive 0.4 · none 0.2 |
| C consensus | `min(1, 0.35 × independentAgreeingGroups)` (own group excluded) |
| I integrity | `1 − driftRatio`; driftRatio = changed claims / claims since last verification (1.0 if never verified → I = 0.5 neutral) |
| U usage | Beta-smoothed `(resolvedTickets + 1) / (resolved + reopened + 2)`; 0.5 when no data |
| ConflictPenalty | open high −30, medium −15, low −5 (max −40) |

Hard gates (applied after the formula): `EXPIRED` → ≤ 10 · superseded → ≤ 20 ·
`INVALIDATED_BY_EVENT` → ≤ 30 until re-verified · `NOT_A_RULE` → ≤ 25 ·
scope mismatch on country → excluded · ACL denied → invisible.

### 8.2 Fact confidence
```
FactConfidence = min(100, winnerScore + 10·min(1, independentCorroborations/2)) × ScopeFit
ScopeFit: exact 1.0 · parent scope (country-level for a customer query) 0.8 · product unknown 0.6 · other country 0
```
Bands: ≥ 80 trusted · 60–79 use with care · < 60 ask the owner.

All weights, tier weights, half-lives and bands live in `rules/scoring.yaml`
(versioned, part of `rulesVersion`). Every score returns its full breakdown.

---

## 9. Attribution (the "A 90% / B 3% / C 2% / Wiki 5%" view)

Final fact set F = facts with status ∈ {VERIFIED, LIKELY, PROVISIONAL}.
Slot weight `w_f` from template (generated slots × 0.8; facts without slot 0.25).
For each fact f, support set S_f = winner + claims/facts that `AGREES`/`CORROBORATES`/`FILLS_GAP` the winning value.
Group S_f by independence group g. Group weight `q_g = max ClaimScore in g`.
Group share `share_f(g) = q_g / Σ q`; inside a group, split equally among member sources.
The winner's group gets a +25% bonus on `q_g` before normalizing (primary-source credit).
```
Contribution(source) = Σ_f w_f · share_f(source) / Σ_f w_f     → sums to 100%
```
Report per source: `contributionPct`, `acceptedClaims`, `rejectedClaims` (with reason codes),
`reliabilityPct = accepted / (accepted + rejected)` over in-scope claims.
Report evidence total vs reference total separately (e.g. "95% case docs, 5% wiki").
Rejected claims never earn contribution.

---

## 10. Verification — "Ask the owner" (authenticated)

Trigger: `needsVerification` facts, `DISPUTED` conflicts, decayed/expired winners, rule 3 correction tasks.

Routing: `OWNS` of winner/contradicting claim → if owner inactive → `EXPERT_IN(subject, country)`
highest weight ≥ 0.6 → else team lead of document's team.

```
can_verify(person, fact) :=
     person.active
 AND (person OWNS a member claim OR EXPERT_IN(fact.subject, fact.scope.country).weight ≥ 0.6)
 AND person may read all member claims' sources (ACL)
```
- `impact: high` facts require two distinct verifiers, not both authors (four-eyes).
- Self-verification (verifier authored the claim) caps tier at T1.
- Token: signed JWT (EdDSA or HS256 from env), claims `{jti, factId, verifierId, allowedActions, exp: 72h}`; single use (jti stored, burned on use); server re-checks `can_verify` at submit time.
- Actions: `confirm` · `correct {value, quote?, sourceUri?}` · `rescope {scope}` · `reassign {personId}` (target must pass `can_verify`) · `reject`.
- Every action → `VerificationEvent` (append-only) → re-run 60–90 for that fact only → canonical update → notify the original asker.
- Hackathon: OIDC is mocked by a local `/auth/mock` issuer behind the same interface as real Entra ID/OIDC.

---

## 11. Health radar (metrics per subject-domain × country)

| Axis (0–100) | Metric |
|---|---|
| Freshness | % canonical/winning claims with V ≥ 0.5 |
| Ownership | % claims with active owner |
| Consistency | 100 − severity-weighted open conflicts per 100 facts |
| Verification depth | mean tier / T4 |
| Coverage | % runs whose required slots all reached ≥ LIKELY |
| Bus factor | experts with weight ≥ 0.6 (0→0, 1→25, 2→60, ≥3→100) |
| Capture rate | % email/Teams-sourced knowledge that reached a canonical |
| Resolution speed | 100 × 0.5^(median days conflict→resolved / 7) |

Alerts: owner deactivated (orphaned claims + suggested successors) · `OrgEvent`
(blast radius via `INVALIDATES` + `DERIVED_FROM`, bulk gate + verification queue) ·
recurring gaps (same slot `UNKNOWN` ≥ 3 runs/week) · bus factor = 1.

Verification queue priority: `askFrequency × (1 − confidence/100) × impactWeight(high 3, med 2, low 1)`.

Expertise derivation: `weight = 1 − exp(−(0.5·ownedClaims + 1.0·verifications + 0.7·resolvedConflicts)/10)`, per subject × country, recomputed nightly (on demand in hackathon).

---

## 12. Output contract & MCP tools

```ts
CaseVerdict {
  runId; question; scope; generatedSlots: boolean;
  answer: { text: string; sentences: { text; factId; citations: { sourceKind; sourceId; title; quote; span }[] }[] };
  facts: { id; slotId?; attribute; value?; status; confidence; breakdown; reasons: { code; message }[]; needsVerification }[];
  conflicts: { id; factId; type; severity; claims: {...}[]; resolution?; status }[];
  gaps: { id; type; slotId?; status; closedBy?: ReferenceFactId[] }[];
  attribution: { evidenceTotalPct; referenceTotalPct; sources: Attribution[] };
  verification: { requestId; factId; requestedFrom: { id; name; team }; status }[];
  versions: { rulesVersion; promptVersions; modelIds };
}
```
MCP tools (register on the existing server or a sibling server — see INTEGRATION.md),
all zod-validated and principal-checked:
`brain_analyze_case { question, documents: {id?, uri?, text?, metadata?}[] } → CaseVerdict`
`brain_get_verdict { runId }` · `brain_explain_fact { factId }` (full graph path + breakdown)
`brain_list_verifications { personId }` · `brain_submit_verification { token, action, payload }`
`brain_health { domain?, country? }` · `brain_ingest_reference { pages[] }` (admin)

---

## 13. Security (Aikido-scan ready)
- Prompt-injection: content in `<document>` delimiters, system prompt says content is data; strip/flag instruction-like text; extraction LLM has no tools; output schema-only.
- Parameterized SQL only; zod on every external input; rate limit MCP tools per principal.
- ACL filter before extraction and before composing; test that a principal without access gets neither content nor derived facts.
- Tokens single-use, short-lived, bound to fact + person; re-authorize on submit.
- Append-only audit (`VerificationEvent`, `CaseRun`); no PII in logs beyond ids.
- Secrets only via env; `.env.example` committed; CI check for committed secrets.

---

## 14. Demo scenario (seed + golden test) — fictional demo data, not legal reference
Question (BE, PC 200, bediende): "Hoeveel dagen klein verlet krijg ik voor mijn eigen huwelijk en wanneer moet ik ze opnemen?"

Evidence:
- **A** SharePoint "HR-beleid klein verlet BE" — owner active (Sarah, Payroll BE), T3 verified 4 months ago; duration 2 days, eligibility, timing window, pay continuation, proof required. → main source.
- **B** SharePoint "Klein verlet – update" — edited last week, unverified, author = Tom; duration 3 days. → `NEWER_BUT_UNVERIFIED`, open conflict, ask Sarah + Tom.
- **C** "Bijzonder verlof bij huwelijk" — declaredScope NL. → `SCOPE_MISMATCH`.
- **D** Email attachment from colleague — older version of A (duplicate passages), missing timing window. → `DUPLICATE_OLDER_VERSION`.

Reference:
- **W1** "Verlofoverzicht België" — independently corroborates duration and proof_required (lifts confidence).
- **W2** copy of A's text → `DERIVED_FROM` A (no independent credit).
- **W3** "CAO/KB-referenties verlof" — fills `legal_basis` + `effective_from`.
- **W4** outdated wiki page, 1 day, last edited 2019, no owner → rejected.

Golden assertions: duration = 2 days (LIKELY or VERIFIED); B conflict OPEN with
verification requests to Sarah and Tom; C rejected SCOPE_MISMATCH; D rejected
DUPLICATE_OLDER_VERSION; W2 has DERIVED_FROM and zero independent credit;
`legal_basis` and `effective_from` gaps closed by W3; W4 rejected;
attribution: A is the top contributor with ≥ 60%, B ≤ 5% (only claims that agree
with the winner count), C and D 0% (rejected / older duplicate), reference total between 10% and 35%, contributions sum to 100% (±0.1);
the golden test prints the attribution table so weights can be tuned in `scoring.yaml`;
verdict identical across two runs (determinism).
