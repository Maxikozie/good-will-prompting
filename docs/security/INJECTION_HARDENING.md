# SQL, prompt, YAML and prototype injection boundaries

## SQL

All 93 SQL call sites were inspected; see [SQL_AUDIT.md](SQL_AUDIT.md). The generic upsert/count helpers now select complete static statements from `packages/brain/src/store/statements.ts`. The table, full column set, conflict key and update/immutable mode must match a frozen allowlist entry. Unknown identifiers fail before reaching the database. Caller values remain positional parameters, including vectors, filtering, limits and active-only selection. Migrations execute trusted repository SQL.

`test/security/sql-source.test.ts` scans both source trees for SQL `${…}` substitutions, concatenation and unreviewed indirect query construction. Driver forwarding, the exact registry expressions and the migration loader are the only nonliteral boundaries. Runtime tests reject injected tables/columns/conflict targets and demonstrate SQL-looking person names remain data.

## Prompt and extraction

The existing evidence/wiki prompts explicitly mark `<document>` content as untrusted data and provide no tools. Inputs cannot close these delimiters. Provider request tests assert no tools or tool choice is transmitted. Model output must now be one JSON value: prose, fences and competing JSON objects are rejected and retried. Retry output and validation feedback are escaped inside the same data delimiters.

The task boundary independently applies Zod validation even when a custom provider ignores its schema argument. Model claims have no status, score, owner or verification fields. Both evidence and reference persistence paths use an exact substring check and drop claims without a verbatim quote. Optional recording validation now uses the same exact character comparison, rather than whitespace normalization.

Ten synthetic attacks in `test/fixtures/injection/` cover instruction overrides, forged verification, fake JSON, role switching, Markdown links, HTML comments, delimiter escapes, tool calls, code fences and multilingual instructions. Tests simulate a model obeying the attacks and verify the application rejects forbidden authority fields, drops fabricated quotes, and leaves real demo statuses, scores, owners and verification tables unchanged. These tests establish application boundaries; they do not establish universal resistance by live models or semantic truth of quoted source claims. A separate provenance/value-grounding review remains relevant.

## YAML and JSON

All production YAML parsing uses the shared bounded loader: YAML 1.2 core schema, no custom tag resolvers, no merge semantics or alias expansion, duplicate keys rejected, parser warnings/errors rejected. Explicit non-core tags are rejected. Rules and slots are subsequently validated against strict Zod schemas.

The recursive bounded-input guard rejects `__proto__`, `constructor` and `prototype` keys at every object/array depth. JSON files, environment JSON, model JSON, YAML and HTTP request bodies pass through it before use. No `Object.assign` or generic deep merge of external configuration exists in production source. Runtime tests cover nested JSON/YAML payloads and a real HTTP prototype-pollution request. Prototype-like words within ordinary document strings remain data.

No dependencies added. Verify with `npm run test:security`, both package typechecks, Brain lint/tests and the production build.
