# Regex audit

Inventory of every JavaScript/TypeScript regex literal and `new RegExp` in tracked source and tests (excluding dependencies/build output). No dynamic production regex construction was found. Patterns were reviewed for nested ambiguous repetition, overlapping alternatives and unanchored repeated suffix matching.

The model JSON fence parser and URL trailing-slash matcher now use linear string operations. Normalizer inputs are rejected above 500 characters before matching; legacy value extraction is capped at 1,000 characters. This bounds retry scanning in numeric/range patterns. Document split/token patterns operate on at most 200,000 characters. Prompt/config files are bounded at 1 MiB. Fixed hash/identifier patterns and delimiter-separated dotted names are anchored; delimiters cannot be consumed by adjacent repeated groups. Injection patterns have fixed keywords and bounded gaps. Test-only patterns match controlled fixtures/errors.

Regression tests exercise a 200,000-character numeric payload, a malformed fence with 100,000 spaces, and a maximum-length normalizer input, each under 50 ms. These are regression thresholds, not universal hardware latency guarantees.

| Location | Pattern | Assessment |
| --- | --- | --- |
| src/api/mock-user.ts:6 | `/^[a-z0-9][a-z0-9.-]{0,60}$/` | Fixed/linear pattern or bounded input as described above |
| src/api/routes/speech.ts:12 | `/^audio\//` | Fixed/linear pattern or bounded input as described above |
| src/api/routes/speech.ts:14 | `/^audio\/[a-z0-9.+-]{1,40}$/` | Fixed/linear pattern or bounded input as described above |
| src/api/routes/speech.ts:28 | `/[^a-z0-9]/g` | Fixed/linear pattern or bounded input as described above |
| src/api/web.ts:11 | `/^(?!\/api).*/` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/domain/brain-nodes.ts:82 | `/^[a-f0-9]{40}$/` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/domain/claim.ts:48 | `/^[a-f0-9]{40}$/` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/domain/evidence-nodes.ts:32 | `/^[a-f0-9]{64}$/` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/domain/keys.ts:20 | `/\p{M}/gu` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/domain/keys.ts:22 | `/[^a-z0-9]/g` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/domain/normalize.ts:20 | `/\p{M}/gu` | Bounded to 500 characters before matching |
| packages/brain/src/domain/normalize.ts:20 | `/\s+/g` | Bounded to 500 characters before matching |
| packages/brain/src/domain/normalize.ts:82 | `/^\d+(?:[.,]\d+)*$/` | Bounded to 500 characters before matching |
| packages/brain/src/domain/normalize.ts:104 | `/[.,]/g` | Bounded to 500 characters before matching |
| packages/brain/src/domain/normalize.ts:128 | `/^(?:€&#124;eur&#124;euros?)\s*(\d.*)$/` | Bounded to 500 characters before matching |
| packages/brain/src/domain/normalize.ts:130 | `/[.;,]+$/` | Bounded to 500 characters before matching |
| packages/brain/src/domain/normalize.ts:132 | `/^(\d+(?:[.,]\d+)*)\s*(.*)$/` | Bounded to 500 characters before matching |
| packages/brain/src/domain/normalize.ts:139 | `/[\s-]+/` | Bounded to 500 characters before matching |
| packages/brain/src/domain/normalize.ts:149 | `/^\((.*)\)$/` | Bounded to 500 characters before matching |
| packages/brain/src/domain/normalize.ts:182 | `/^(\d{4})-(\d{2})-(\d{2})(?:[t ].*)?$/` | Bounded to 500 characters before matching |
| packages/brain/src/domain/normalize.ts:184 | `/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/` | Bounded to 500 characters before matching |
| packages/brain/src/domain/normalize.ts:186 | `/^(\d{1,2})(?:st&#124;nd&#124;rd&#124;th&#124;er&#124;ste&#124;de&#124;e)?\s+([a-z]+)\.?,?\s+(\d{4})$/` | Bounded to 500 characters before matching |
| packages/brain/src/domain/normalize.ts:188 | `/^([a-z]+)\.?\s+(\d{1,2})(?:st&#124;nd&#124;rd&#124;th)?,?\s+(\d{4})$/` | Bounded to 500 characters before matching |
| packages/brain/src/domain/normalize.ts:194 | `/^(?:tussen&#124;between&#124;entre&#124;de&#124;du&#124;van&#124;from)\s+/` | Bounded to 500 characters before matching |
| packages/brain/src/domain/normalize.ts:195 | `/\s+(?:tot en met&#124;tot&#124;to&#124;a&#124;et&#124;and&#124;en)\s+&#124;\s*[-–—]\s*/g` | Bounded to 500 characters before matching |
| packages/brain/src/domain/normalize.ts:220 | `/\s+/g` | Bounded to 500 characters before matching |
| packages/brain/src/domain/reference-nodes.ts:30 | `/^[a-f0-9]{64}$/` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/domain/split.ts:16 | `/\n{2,}/` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/domain/split.ts:31 | `/^## .+$/gm` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/evidence/simhash.ts:18 | `/\p{M}/gu` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/evidence/simhash.ts:20 | `/[^a-z0-9]+/` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/llm/embedder.ts:20 | `/\p{M}/gu` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/llm/embedder.ts:21 | `/[^a-z0-9]+/` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/llm/json.ts:24 | `/[{[]/` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/llm/prompts.ts:36 | `/^[a-z-]+$/` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/llm/prompts.ts:36 | `/^v\d+$/` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/llm/prompts.ts:40 | `/^---\n([\s\S]*?)\n---\n([\s\S]*)$/` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/llm/prompts.ts:44 | `/^## system\n([\s\S]*?)\n## user\n([\s\S]*)$/` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/llm/prompts.ts:59 | `/<(\/?\s*document)/gi` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/llm/prompts.ts:66 | `/\{\{(\w+)\}\}/g` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/llm/prompts.ts:82 | `/\b(ignore&#124;disregard&#124;forget&#124;negeer&#124;oublie[rz]?&#124;ignorez)\b.{0,40}\b(previous&#124;prior&#124;above&#124;earlier&#124;all&#124;eerdere&#124;vorige&#124;alle&#124;pr[ée]c[ée]dentes?&#124;toutes)\b.{0,30}\b(instructions?&#124;instructies&#124;regels&#124;rules&#124;consignes)\b/is` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/llm/prompts.ts:83 | `/\b(system\s*(prompt&#124;message&#124;instruction)&#124;systeem\s?(prompt&#124;instructie)&#124;syst[èe]me\s*instruction)/i` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/llm/prompts.ts:84 | `/\b(note&#124;opmerking&#124;remarque)\s+(for&#124;voor&#124;pour)\s+(ai&#124;llm&#124;assistant&#124;ki&#124;ia)/i` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/llm/prompts.ts:85 | `/\b(mark&#124;markeer&#124;marque[rz]?&#124;set)\b.{0,40}\b(verified&#124;geverifieerd&#124;v[ée]rifi[ée])/i` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/llm/prompts.ts:86 | `/\b(you are now&#124;from now on you&#124;je bent nu&#124;vous [êe]tes maintenant)\b/i` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/llm/prompts.ts:87 | `/\b(only&#124;enkel&#124;uniquement)\b.{0,30}\b(this&#124;dit&#124;ce)\b.{0,20}\b(document&#124;source&#124;bron)\b/i` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/llm/schemas.ts:5 | `/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/llm/schemas.ts:6 | `/^[a-z][a-z0-9_]*$/` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/llm/tasks.ts:70 | `/\s+/g` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/reference/queries.ts:21 | `/\s+/g` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/reference/queries.ts:30 | `/_/g` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/reference/retrieval.ts:32 | `/\p{M}/gu` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/reference/sections.ts:12 | `/^# (.+)$/m` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/reference/sections.ts:13 | `/^## (.+)$/m` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/security/env.ts:5 | `/^\d+$/` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/store/migrate.ts:12 | `/^\d+_.+\.sql$/` | Fixed/linear pattern or bounded input as described above |
| packages/brain/src/store/seed.ts:42 | `/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/` | Fixed/linear pattern or bounded input as described above |
| packages/brain/test/gaps.test.ts:26 | `/required/` | Controlled test input |
| packages/brain/test/gaps.test.ts:27 | `/optional/` | Controlled test input |
| packages/brain/test/helpers/boundary.ts:21 | `/\/\*[\s\S]*?\*\//g` | Controlled test input |
| packages/brain/test/helpers/boundary.ts:21 | `/(^&#124;[^:'"&#96;])\/\/.*$/gm` | Controlled test input |
| packages/brain/test/helpers/boundary.ts:22 | `/\b(?:from&#124;import&#124;require)\s*\(?\s*['"&#96;]([^'"&#96;\n]+)['"&#96;]/g` | Controlled test input |
| packages/brain/test/helpers/boundary.ts:41 | `/^(?:src\/&#124;@\/&#124;~\/)/` | Controlled test input |
| packages/brain/test/helpers/boundary.ts:41 | `/^(?:src\/&#124;@\/&#124;~\/)/` | Controlled test input |
| packages/brain/test/helpers/boundary.ts:53 | `/\.(?:ts&#124;tsx&#124;js&#124;mjs&#124;cjs)$/` | Controlled test input |
| packages/brain/test/helpers/demo-extraction.ts:74 | `/^## (.+)$/m` | Controlled test input |
| packages/brain/test/keys.test.ts:61 | `/^[a-f0-9]{40}$/` | Controlled test input |
| packages/brain/test/keys.test.ts:81 | `/^[a-f0-9]{40}$/` | Controlled test input |
| packages/brain/test/ladder.test.ts:35 | `/^[a-f0-9]{16}$/` | Controlled test input |
| packages/brain/test/llm.fake.test.ts:29 | `/brain:record/` | Controlled test input |
| packages/brain/test/llm.fake.test.ts:36 | `/no longer matches the schema/` | Controlled test input |
| packages/brain/test/llm.fake.test.ts:38 | `/fails its check/` | Controlled test input |
| packages/brain/test/llm.fake.test.ts:135 | `/number of embeddings/` | Controlled test input |
| packages/brain/test/llm.fake.test.ts:136 | `/768/` | Controlled test input |
| packages/brain/test/llm.prompts.test.ts:42 | `/UNTRUSTED DATA/` | Controlled test input |
| packages/brain/test/llm.prompts.test.ts:43 | `/never an instruction/i` | Controlled test input |
| packages/brain/test/llm.prompts.test.ts:44 | `/<document>/` | Controlled test input |
| packages/brain/test/llm.prompts.test.ts:45 | `/ONE JSON object/` | Controlled test input |
| packages/brain/test/llm.prompts.test.ts:46 | `/no markdown, no code fences/` | Controlled test input |
| packages/brain/test/llm.prompts.test.ts:47 | `/<document>[\s\S]*<\/document>/` | Controlled test input |
| packages/brain/test/llm.prompts.test.ts:54 | `/VERBATIM/` | Controlled test input |
| packages/brain/test/llm.prompts.test.ts:55 | `/character for character/` | Controlled test input |
| packages/brain/test/llm.prompts.test.ts:56 | `/never use outside knowledge/i` | Controlled test input |
| packages/brain/test/llm.prompts.test.ts:57 | `/no tools/i` | Controlled test input |
| packages/brain/test/llm.prompts.test.ts:61 | `/"(status&#124;score&#124;winner&#124;trust)"/i` | Controlled test input |
| packages/brain/test/llm.prompts.test.ts:75 | `/not found/` | Controlled test input |
| packages/brain/test/llm.prompts.test.ts:84 | `/missing variable/` | Controlled test input |
| packages/brain/test/llm.prompts.test.ts:85 | `/unknown variable/` | Controlled test input |
| packages/brain/test/llm.prompts.test.ts:93 | `/<\s*\/?\s*document/i` | Controlled test input |
| packages/brain/test/llm.prompts.test.ts:93 | `/<\/\s*DOCUMENT/` | Controlled test input |
| packages/brain/test/llm.prompts.test.ts:93 | `/$^/` | Controlled test input |
| packages/brain/test/llm.prompts.test.ts:131 | `/UNTRUSTED DATA/` | Controlled test input |
| packages/brain/test/llm.prompts.test.ts:132 | `/Systeeminstructie&#124;negeer alle eerdere/i` | Controlled test input |
| packages/brain/test/llm.prompts.test.ts:134 | `/negeer alle eerdere instructies/i` | Controlled test input |
| packages/brain/test/llm.prompts.test.ts:135 | `/negeer/i` | Controlled test input |
| packages/brain/test/llm.prompts.test.ts:160 | `/\[claim A\][\s\S]*4 weken[\s\S]*\[claim B\][\s\S]*2 weken/` | Controlled test input |
| packages/brain/test/llm.prompts.test.ts:169 | `/not verbatim/` | Controlled test input |
| packages/brain/test/llm.provider.test.ts:69 | `/rejected/` | Controlled test input |
| packages/brain/test/llm.provider.test.ts:72 | `/n:/` | Controlled test input |
| packages/brain/test/llm.provider.test.ts:94 | `/n must be at least 5/` | Controlled test input |
| packages/brain/test/llm.provider.test.ts:182 | `/HTTP 500/` | Controlled test input |
| packages/brain/test/llm.provider.test.ts:186 | `/Invalid input/` | Controlled test input |
| packages/brain/test/llm.provider.test.ts:190 | `/http/` | Controlled test input |
| packages/brain/test/llm.provider.test.ts:191 | `/valid URL/` | Controlled test input |
| packages/brain/test/llm.provider.test.ts:199 | `/ANTHROPIC_API_KEY/` | Controlled test input |
| packages/brain/test/llm.provider.test.ts:221 | `/401/` | Controlled test input |
| packages/brain/test/llm.provider.test.ts:228 | `/^ollama:/` | Controlled test input |
| packages/brain/test/llm.provider.test.ts:230 | `/Invalid environment configuration/` | Controlled test input |
| packages/brain/test/llm.provider.test.ts:235 | `/ANTHROPIC_API_KEY/` | Controlled test input |
| packages/brain/test/llm.record.test.ts:44 | `/^#+ (.+)$/m` | Controlled test input |
| packages/brain/test/llm.record.test.ts:46 | `/[^a-z]+/g` | Controlled test input |
| packages/brain/test/llm.record.test.ts:46 | `/^_&#124;_$/g` | Controlled test input |
| packages/brain/test/migrate.test.ts:48 | `/hnsw/` | Controlled test input |
| packages/brain/test/migrate.test.ts:57 | `/\(from_id, type\)/` | Controlled test input |
| packages/brain/test/migrate.test.ts:58 | `/\(to_id, type\)/` | Controlled test input |
| packages/brain/test/migrate.test.ts:59 | `/\(run_id\)/` | Controlled test input |
| packages/brain/test/migrate.test.ts:86 | `/immutable/` | Controlled test input |
| packages/brain/test/migrate.test.ts:87 | `/immutable/` | Controlled test input |
| packages/brain/test/pipeline.test.ts:119 | `/^## (.+)$/m` | Controlled test input |
| packages/brain/test/pipeline.test.ts:346 | `/No LLM fixture/` | Controlled test input |
| packages/brain/test/reference.test.ts:33 | `/klein verlet&#124;verlof&#124;huwelijk/` | Controlled test input |
| packages/brain/test/reference.test.ts:34 | `/wettelijke basis&#124;koninklijk besluit&#124;cao&#124;legal/` | Controlled test input |
| packages/brain/test/reference.test.ts:41 | `/PC 200&#124;België/` | Controlled test input |
| packages/brain/test/reference.test.ts:42 | `/België/` | Controlled test input |
| packages/brain/test/reference.test.ts:51 | `/\d werkdagen/` | Controlled test input |
| packages/brain/test/reference.test.ts:146 | `/max PROVISIONAL/` | Controlled test input |
| packages/brain/test/reference.test.ts:276 | `/PROVISIONAL/` | Controlled test input |
| packages/brain/test/seed.fixtures.test.ts:34 | `/FICTIEVE DEMODATA/` | Controlled test input |
| packages/brain/test/seed.fixtures.test.ts:35 | `/Fictional demo data/` | Controlled test input |
| packages/brain/test/seed.fixtures.test.ts:40 | `/\b(de&#124;het&#124;een&#124;voor&#124;werknemer)\b/` | Controlled test input |
| packages/brain/test/stage30-40.test.ts:117 | `/optional/` | Controlled test input |
| packages/brain/test/stage30-40.test.ts:192 | `/No LLM fixture/` | Controlled test input |
| packages/brain/test/stage50.test.ts:216 | `/evidence_snapshot,wiki_(section&#124;snapshot)/` | Controlled test input |
| packages/brain/test/stage60.test.ts:213 | `/from\s+['"][^'"]*\/llm(?:\/&#124;['"])/` | Controlled test input |
| packages/brain/test/stage60.test.ts:217 | `/ctx\.(llm&#124;embedder)/` | Controlled test input |
| packages/brain/test/stage60.test.ts:250 | `/ladder must be exactly/` | Controlled test input |
| packages/brain/test/store.test.ts:67 | `/Wanneer op te nemen/` | Controlled test input |
| packages/brain/test/store.test.ts:68 | `/\s+/` | Controlled test input |
| packages/brain/test/store.test.ts:78 | `/Wanneer op te nemen&#124;4 weken/` | Controlled test input |
| packages/brain/test/store.test.ts:96 | `/negeer alle eerdere instructies/i` | Controlled test input |
| packages/brain/test/store.test.ts:287 | `/append-only/` | Controlled test input |
| packages/brain/test/store.test.ts:288 | `/append-only/` | Controlled test input |
| packages/brain/test/store.test.ts:326 | `/edge_from_type/` | Controlled test input |
| packages/brain/test/store.test.ts:327 | `/edge_to_type/` | Controlled test input |
| packages/brain/test/store.test.ts:328 | `/edge_run/` | Controlled test input |
| src/core/ingest.ts:71 | `/\\/g` | Fixed/linear pattern or bounded input as described above |
| src/core/ingest.ts:104 | `/\\/g` | Fixed/linear pattern or bounded input as described above |
| src/core/ingest.ts:142 | `/\\/g` | Fixed/linear pattern or bounded input as described above |
| src/core/org.ts:51 | `/nordwind/i` | Fixed/linear pattern or bounded input as described above |
| src/core/org.ts:54 | `/\b(belgium&#124;belgian&#124;belgië&#124;belgie&#124;belgique&#124;flanders&#124;brussels)\b/i` | Fixed/linear pattern or bounded input as described above |
| src/core/org.ts:54 | `/\bBE\b/` | Fixed/linear pattern or bounded input as described above |
| src/core/org.ts:55 | `/\b(netherlands&#124;dutch&#124;nederland&#124;holland)\b/i` | Fixed/linear pattern or bounded input as described above |
| src/core/org.ts:55 | `/\bNL\b/` | Fixed/linear pattern or bounded input as described above |
| src/core/util.ts:25 | `/^[a-z0-9][a-z0-9-]{0,99}$/` | Fixed/linear pattern or bounded input as described above |
| src/core/util.ts:26 | `/^[a-f0-9]{64}$/` | Fixed/linear pattern or bounded input as described above |
| src/core/util.ts:27 | `/^task-[a-z0-9-]{1,60}$/` | Fixed/linear pattern or bounded input as described above |
| src/core/util.ts:28 | `/^[a-z0-9][a-z0-9.-]{0,60}$/` | Fixed/linear pattern or bounded input as described above |
| src/core/util.ts:82 | `/[̀-ͯ]/g` | Fixed/linear pattern or bounded input as described above |
| src/core/util.ts:83 | `/[^a-z0-9]+/g` | Fixed/linear pattern or bounded input as described above |
| src/core/util.ts:84 | `/^-+&#124;-+$/g` | Fixed/linear pattern or bounded input as described above |
| src/core/util.ts:95 | `/[^a-z0-9à-ÿ%€-]+/` | Fixed/linear pattern or bounded input as described above |
| src/core/util.ts:104 | `/(\d+(?:[.,]\d+)?)\s?%/` | Fixed/linear pattern or bounded input as described above |
| src/core/util.ts:106 | `/€\s?(\d+(?:[.,]\d{1,2})?)/` | Fixed/linear pattern or bounded input as described above |
| src/core/util.ts:108 | `/\s+/g` | Fixed/linear pattern or bounded input as described above |
| src/core/vault.ts:40 | `/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/` | Fixed/linear pattern or bounded input as described above |
| src/verification/tokens.ts:32 | `/^[A-Za-z0-9_-]{1,64}$/` | Fixed/linear pattern or bounded input as described above |
| test/security/mcp.test.ts:115 | `/lotte.peeters/` | Controlled test input |
| test/security/mcp.test.ts:151 | `/request-owner/` | Controlled test input |
| test/security/mcp.test.ts:152 | `/owner-jti&#124;token_jti/` | Controlled test input |
| test/security/mcp.test.ts:252 | `/429 Rate limit exceeded/` | Controlled test input |
| test/security/mcp.test.ts:255 | `/429 Rate limit exceeded/` | Controlled test input |
| test/security/resources.test.ts:57 | `/Invalid environment/` | Controlled test input |
| test/security/verification.test.ts:33 | `/Invalid BRAIN_JWT configuration/` | Controlled test input |
| test/security/verification.test.ts:76 | `/disabled in production/` | Controlled test input |
| test/security/verification.test.ts:121 | `/immutable/` | Controlled test input |
| test/security/verification.test.ts:140 | `/action failed/` | Controlled test input |
| web/src/views/Mail.tsx:108 | `/\s+/g` | Fixed/linear pattern or bounded input as described above |
