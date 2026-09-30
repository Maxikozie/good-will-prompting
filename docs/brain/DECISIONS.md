# Brain decisions log

Log every assumption or deviation from the spec here (date | decision | alternative | why).

| date | decision | alternative | why |
|---|---|---|---|
| 2026-09-30 | `packages/brain` is a standalone npm package (own `package.json` + lockfile), not a workspace member | npm workspaces in the root `package.json` | The root package/lockfile are edited by teammates in parallel; a workspace change would touch both and risk merge conflicts. Root `tsconfig` only includes `src` and `web/src`, so the two do not interfere. |
| 2026-09-30 | vitest + eslint (flat config, `no-restricted-imports`) are added inside `packages/brain` only | none: follow the AGENTS.md "no tests unless asked" rule | The Brain prompt explicitly asks for vitest, lint and a boundary test; scoped to the new package so root stays test-free. |
| 2026-09-30 | `normalizeValue`, `claimKey`, `scopeKey` live in `src/domain` | `src/evidence` or `src/pipeline` | Both corpora extract claims and need the same normalizer/keys; `domain` is the only place (besides `pipeline`) both corpora may import, so the boundary stays intact. |
| 2026-09-30 | `language` is NOT part of `scopeKey`/`claimKey` | include every `Scope` field | The same rule written in NL and FR must still align into one fact; language-specific keys would split it. |
| 2026-09-30 | scope values are normalized for keys: lowercase, diacritics stripped, non-alphanumerics removed ("PC 200" = "pc200"); missing/null/empty = `*` | raw string compare | Order/format-independent keys (SPEC §3 "claimKey") without relying on extractor formatting. |
| 2026-09-30 | `evidence/**` and `reference/**` may also not import `pipeline/**` | only forbid evidence↔reference | `pipeline` sees both corpora, so importing it would be an indirect leak of the other corpus. Matches "only pipeline and domain see both". |
| 2026-09-30 | Boundary is enforced twice: eslint `no-restricted-imports` AND a regex scanner test (`test/boundary.test.ts`) | eslint only | eslint's rule ignores dynamic `import()`/`require()`; the scanner catches those and is itself tested with planted violations. |
| 2026-09-30 | Edge schemas also constrain `fromKind`/`toKind` per edge type (e.g. `CORROBORATES` only from `reference_fact`); extra node kind `subject_scope` for the composite target of `EXPERT_IN`/`INVALIDATES` | plain string kinds | SPEC §2.2 gives from→to per type; encoding it makes illegal bridge edges unrepresentable. `subject×country`/`subject×scope` is not a stored node, hence the composite kind. |
| 2026-09-30 | `Conflict.type` = `value \| polarity \| temporal \| scope \| textual`; `Conflict.resolution` = free string (ladder rule id or owner action) | leave untyped | SPEC does not define them; these match the detection kinds in §5 stage 30 and the ladder in §7. Extend here if needed. |
| 2026-09-30 | `Attribution.acceptedClaims` = `ClaimId[]`, `rejectedClaims` = `{claimId, code}[]` | counts only | §9 requires "rejectedClaims (with reason codes)" and `reliabilityPct = accepted/(accepted+rejected)`; arrays give both. |
| 2026-09-30 | `Fact.winnerClaimId` is `EvidenceClaimId \| ReferenceFactId` | evidence only | A fact supported only by reference is allowed (max `PROVISIONAL`, §1), so the winner may be a reference fact. |
| 2026-09-30 | `OrgEvent` is in namespace `brain` (SPEC §2.1 lists it under brain nodes); `Expertise` has no `id`/namespace (derived value object) | `org` namespace | Follows the spec's grouping; Expertise is recomputed on demand (§11). |
| 2026-09-30 | `ReferenceFact.passageId` holds a `WikiSectionId` | separate `sectionId` field | Keeps one shared claim shape (§3) while the brand still stops mixing with `EvidencePassageId`. |
| 2026-09-30 | Numeric dates (`01/02/2027`) parse day-first | month-first | Belgian/Dutch/French sources; ambiguous dates are never guessed as US format. |
| 2026-09-30 | Normalizer returns `{type:'text'}` for anything it cannot read cleanly (e.g. "2 dagen per jaar", "3 jaar"); a plain quantity wins over a range ("quatre-vingt" is 80, not 4–20) | best-effort numbers | Honest text beats a wrong number; text contradictions go through the LLM relation classifier with an explanation (§5 stage 30). |
| 2026-09-30 | Money is stored as integer cents with `unit: 'eur'`; a bare number gets `unit` from the slot hint when given | floats | SPEC §3 "amounts → EUR cents". |
