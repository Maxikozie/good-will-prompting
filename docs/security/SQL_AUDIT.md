# SQL query audit

Every `.query`/`.exec` call in `src/` and `packages/brain/src/` is listed below. SQL values use positional parameters. Queries have fixed table, column and ordering identifiers. The upsert/count adapters select whole statements from the frozen `store/statements.ts` allowlist and require an exact column set, conflict key and conflict mode. No runtime SQL interpolation or concatenation remains.

The only nonliteral SQL forwarding boundaries are the database drivers, the fixed statement registry and the migration loader. Migration SQL is trusted repository code read from local migration files, not application input. `test/security/sql-source.test.ts` scans both source trees for SQL template substitutions, concatenation and new indirect call sites; no external grep executable is needed. The registry additionally contains the 23 fixed insert statements and fixed count statements.

| Call site | SQL / forwarding expression |
| --- | --- |
| src/mcp/brain-tools.ts:58 | `'SELECT allowed_principals FROM evidence.document WHERE id = $1'` |
| src/mcp/brain-tools.ts:74 | `'SELECT id, fact_id, requested_from_id, reason, status, expires_at FROM brain.verification_request WHERE requested_from_id = $1 ORDER BY created_at, id'` |
| src/security/brain-access.ts:7 | `'SELECT principal_id FROM brain.case_run WHERE id = $1'` |
| src/security/brain-access.ts:11 | ` WITH nodes(kind, id) AS ( SELECT 'evidence_snapshot', unnest(evidence_snapshot_ids) FROM brain.case_run WHERE id = $1 UNION SELECT 'wiki_snapshot', unnest(ref` |
| src/security/brain-access.ts:41 | ` SELECT 1 FROM brain.edge e WHERE e.run_id = $1 AND ( (e.from_kind = 'case_run' AND e.from_id <> $1) OR (e.to_kind = 'case_run' AND e.to_id <> $1) OR (e.from_k` |
| src/security/brain-access.ts:61 | `'SELECT run_id FROM brain.fact WHERE id = $1'` |
| src/verification/service.ts:24 | `'SELECT id FROM org.person WHERE id = $1 AND active AND $2 = ANY(principal_ids) FOR SHARE'` |
| src/verification/service.ts:31 | `'SELECT id FROM brain.fact WHERE id = $1 FOR UPDATE'` |
| src/verification/service.ts:35 | ` SELECT CASE e.from_kind WHEN 'evidence_claim' THEN d.allowed_principals WHEN 'reference_fact' THEN p.allowed_principals ELSE NULL END AS acl FROM brain.edge e` |
| src/verification/service.ts:52 | ` WITH members(kind, id) AS ( SELECT from_kind::text, from_id FROM brain.edge WHERE type = 'MEMBER_OF' AND to_kind = 'fact' AND to_id = $1 UNION SELECT 'evidenc` |
| src/verification/service.ts:86 | `'SELECT fact_id, requested_from_id FROM brain.verification_request WHERE token_jti = $1'` |
| packages/brain/src/llm/db-cache.ts:10 | `'SELECT response FROM brain.llm_cache WHERE prompt_id = $1 AND prompt_version = $2 AND model_id = $3 AND input_hash = $4'` |
| packages/brain/src/pipeline/10-snapshot.ts:109 | `DELETE FROM brain.edge WHERE run_id = $1 AND type = 'DUPLICATE_OF'` |
| packages/brain/src/security/budget.ts:31 | `INSERT INTO brain.resource_usage (scope,key,calls,tokens) VALUES ($1,$2,1,$3) ON CONFLICT (scope,key) DO UPDATE SET calls = brain.resource_usage.calls + 1, tok` |
| packages/brain/src/store/brain-repo.ts:50 | `'SELECT * FROM brain.case_run WHERE id = $1'` |
| packages/brain/src/store/brain-repo.ts:72 | `'SELECT * FROM brain.fact WHERE id = $1'` |
| packages/brain/src/store/brain-repo.ts:77 | `'SELECT * FROM brain.fact WHERE run_id = $1 ORDER BY id'` |
| packages/brain/src/store/brain-repo.ts:90 | `'SELECT * FROM brain.gap WHERE run_id = $1 ORDER BY id'` |
| packages/brain/src/store/brain-repo.ts:108 | `SELECT * FROM brain.conflict WHERE ($1::text IS NULL OR run_id = $1) AND ($2::text IS NULL OR fact_id = $2) AND ($3::text IS NULL OR status = $3) ORDER BY id` |
| packages/brain/src/store/brain-repo.ts:124 | `'SELECT * FROM brain.canonical WHERE key = $1'` |
| packages/brain/src/store/brain-repo.ts:135 | `'DELETE FROM brain.attribution WHERE run_id = $1'` |
| packages/brain/src/store/brain-repo.ts:146 | `'SELECT * FROM brain.attribution WHERE run_id = $1 ORDER BY contribution_pct DESC, source_id'` |
| packages/brain/src/store/brain-repo.ts:157 | `INSERT INTO brain.verification_request (id, fact_id, requested_from_id, reason, status, token_jti, expires_at, created_at) VALUES ($1,$2,$3,$4,'pending',$5,$6,` |
| packages/brain/src/store/brain-repo.ts:164 | `'SELECT * FROM brain.verification_request WHERE id = $1'` |
| packages/brain/src/store/brain-repo.ts:169 | `'SELECT * FROM brain.verification_request WHERE token_jti = $1'` |
| packages/brain/src/store/brain-repo.ts:174 | `SELECT * FROM brain.verification_request WHERE ($1::text IS NULL OR requested_from_id = $1) AND ($2::text IS NULL OR fact_id = $2) AND ($3::text IS NULL OR sta` |
| packages/brain/src/store/brain-repo.ts:183 | `UPDATE brain.verification_request SET used_at = now(), status = 'completed' WHERE token_jti = $1 AND used_at IS NULL AND status = 'pending' AND expires_at > no` |
| packages/brain/src/store/brain-repo.ts:192 | `INSERT INTO brain.verification_event (id, fact_id, claim_id, verifier_id, action, tier, payload, at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)` |
| packages/brain/src/store/brain-repo.ts:199 | `'SELECT * FROM brain.verification_event WHERE fact_id = $1 ORDER BY at, id'` |
| packages/brain/src/store/brain-repo.ts:211 | `'SELECT * FROM brain.org_event ORDER BY effective_at, id'` |
| packages/brain/src/store/brain-repo.ts:225 | `'SELECT * FROM brain.run_stage WHERE run_id = $1 ORDER BY stage'` |
| packages/brain/src/store/brain-repo.ts:231 | `'DELETE FROM brain.fact WHERE run_id = $1'` |
| packages/brain/src/store/brain-repo.ts:235 | `'DELETE FROM brain.gap WHERE run_id = $1'` |
| packages/brain/src/store/brain-repo.ts:241 | `UPDATE brain.gap g SET status = 'open', closed_by = NULL, fact_id = CASE WHEN EXISTS (SELECT 1 FROM brain.fact f WHERE f.id = g.fact_id AND f.reference_only) T` |
| packages/brain/src/store/brain-repo.ts:247 | `'DELETE FROM brain.fact WHERE run_id = $1 AND reference_only'` |
| packages/brain/src/store/brain-repo.ts:248 | `'DELETE FROM brain.claim_group WHERE run_id = $1'` |
| packages/brain/src/store/brain-repo.ts:252 | `'UPDATE brain.gap SET status = $2, closed_by = $3, fact_id = COALESCE($4, fact_id) WHERE id = $1'` |
| packages/brain/src/store/brain-repo.ts:270 | `'SELECT * FROM brain.claim_group WHERE run_id = $1 ORDER BY claim_id'` |
| packages/brain/src/store/brain-repo.ts:276 | `'DELETE FROM brain.conflict WHERE run_id = $1'` |
| packages/brain/src/store/brain-repo.ts:281 | `'DELETE FROM brain.claim_score WHERE run_id = $1'` |
| packages/brain/src/store/brain-repo.ts:282 | `'DELETE FROM brain.fact_decision WHERE run_id = $1'` |
| packages/brain/src/store/brain-repo.ts:294 | `'SELECT * FROM brain.claim_score WHERE run_id = $1 ORDER BY fact_id, claim_id'` |
| packages/brain/src/store/brain-repo.ts:309 | `'SELECT * FROM brain.fact_decision WHERE run_id = $1 AND fact_id = $2'` |
| packages/brain/src/store/db.ts:45 | `sql` |
| packages/brain/src/store/db.ts:50 | `sql` |
| packages/brain/src/store/db.ts:57 | `'BEGIN'` |
| packages/brain/src/store/db.ts:59 | `'COMMIT'` |
| packages/brain/src/store/db.ts:63 | `'ROLLBACK'` |
| packages/brain/src/store/db.ts:84 | `sql` |
| packages/brain/src/store/db.ts:89 | `sql` |
| packages/brain/src/store/db.ts:111 | `"SELECT set_config('statement_timeout', $1, false)"` |
| packages/brain/src/store/edge-repo.ts:21 | `'SELECT * FROM brain.edge WHERE from_id = $1 AND ($2::brain.edge_type IS NULL OR type = $2::brain.edge_type) ORDER BY id'` |
| packages/brain/src/store/edge-repo.ts:26 | `'SELECT * FROM brain.edge WHERE to_id = $1 AND ($2::brain.edge_type IS NULL OR type = $2::brain.edge_type) ORDER BY id'` |
| packages/brain/src/store/edge-repo.ts:31 | `'SELECT * FROM brain.edge WHERE run_id = $1 ORDER BY id'` |
| packages/brain/src/store/edge-repo.ts:37 | `'DELETE FROM brain.edge WHERE run_id = $1 AND ($2::text[] IS NULL OR type::text = ANY($2::text[])) AND ($3::text IS NULL OR from_kind::text = $3)'` |
| packages/brain/src/store/evidence-repo.ts:52 | `'SELECT * FROM evidence.document WHERE source_uri = $1 ORDER BY id LIMIT 1'` |
| packages/brain/src/store/evidence-repo.ts:57 | `'SELECT * FROM evidence.document WHERE id = $1'` |
| packages/brain/src/store/evidence-repo.ts:63 | `SELECT * FROM evidence.document WHERE ('*' = ANY(allowed_principals) OR allowed_principals && $1::text[]) AND ($2::text[] IS NULL OR id = ANY($2::text[])) ORDE` |
| packages/brain/src/store/evidence-repo.ts:79 | `'SELECT * FROM evidence.snapshot WHERE id = $1'` |
| packages/brain/src/store/evidence-repo.ts:84 | `'SELECT * FROM evidence.snapshot WHERE document_id = $1 ORDER BY version DESC LIMIT 1'` |
| packages/brain/src/store/evidence-repo.ts:95 | `'SELECT * FROM evidence.passage WHERE snapshot_id = $1 ORDER BY ordinal'` |
| packages/brain/src/store/evidence-repo.ts:100 | `'UPDATE evidence.passage SET embedding = $2::vector WHERE id = $1'` |
| packages/brain/src/store/evidence-repo.ts:105 | `SELECT *, 1 - (embedding <=> $1::vector) AS score FROM evidence.passage WHERE embedding IS NOT NULL AND ($2::text[] IS NULL OR snapshot_id = ANY($2::text[])) O` |
| packages/brain/src/store/evidence-repo.ts:119 | `'SELECT * FROM evidence.claim WHERE id = $1'` |
| packages/brain/src/store/evidence-repo.ts:124 | `'SELECT * FROM evidence.claim WHERE snapshot_id = $1 ORDER BY span_start, id'` |
| packages/brain/src/store/evidence-repo.ts:129 | `'SELECT * FROM evidence.claim WHERE claim_key = $1 ORDER BY id'` |
| packages/brain/src/store/evidence-repo.ts:135 | `'SELECT id FROM evidence.passage WHERE snapshot_id = $1 AND embedding IS NULL ORDER BY ordinal'` |
| packages/brain/src/store/evidence-repo.ts:141 | `'SELECT id, embedding::text AS e FROM evidence.passage WHERE snapshot_id = $1 AND embedding IS NOT NULL'` |
| packages/brain/src/store/evidence-repo.ts:147 | `'SELECT max(version) AS v FROM evidence.snapshot WHERE document_id = $1'` |
| packages/brain/src/store/migrate.ts:10 | `'CREATE TABLE IF NOT EXISTS public._brain_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'` |
| packages/brain/src/store/migrate.ts:11 | `'SELECT name FROM public._brain_migrations'` |
| packages/brain/src/store/migrate.ts:18 | `sql` |
| packages/brain/src/store/migrate.ts:19 | `'INSERT INTO public._brain_migrations (name) VALUES ($1)'` |
| packages/brain/src/store/org-repo.ts:13 | `'SELECT * FROM org.person WHERE id = $1'` |
| packages/brain/src/store/org-repo.ts:18 | `'SELECT * FROM org.person WHERE (NOT $1::boolean OR active) ORDER BY id'` |
| packages/brain/src/store/org-repo.ts:28 | `SELECT person_id, subject, country, weight FROM org.expertise WHERE subject = $1 AND ($2::text IS NULL OR country = $2) AND weight >= $3 ORDER BY weight DESC, ` |
| packages/brain/src/store/org-repo.ts:39 | `'SELECT principal_ids FROM org.person WHERE $1 = ANY(principal_ids) ORDER BY id LIMIT 1'` |
| packages/brain/src/store/reference-repo.ts:50 | `'SELECT * FROM reference.wiki_page WHERE id = $1'` |
| packages/brain/src/store/reference-repo.ts:55 | `SELECT * FROM reference.wiki_page WHERE '*' = ANY(allowed_principals) OR allowed_principals && $1::text[] ORDER BY id` |
| packages/brain/src/store/reference-repo.ts:64 | `'SELECT * FROM reference.wiki_snapshot WHERE id = $1'` |
| packages/brain/src/store/reference-repo.ts:69 | `'SELECT * FROM reference.wiki_snapshot WHERE page_id = $1 ORDER BY fetched_at DESC LIMIT 1'` |
| packages/brain/src/store/reference-repo.ts:80 | `'SELECT * FROM reference.wiki_section WHERE snapshot_id = $1 ORDER BY ordinal'` |
| packages/brain/src/store/reference-repo.ts:85 | `'UPDATE reference.wiki_section SET embedding = $2::vector WHERE id = $1'` |
| packages/brain/src/store/reference-repo.ts:89 | `SELECT *, 1 - (embedding <=> $1::vector) AS score FROM reference.wiki_section WHERE embedding IS NOT NULL AND ($2::text[] IS NULL OR snapshot_id = ANY($2::text` |
| packages/brain/src/store/reference-repo.ts:103 | `'SELECT * FROM reference.reference_fact WHERE id = $1'` |
| packages/brain/src/store/reference-repo.ts:108 | `'SELECT * FROM reference.reference_fact WHERE subject = $1 AND ($2::text IS NULL OR attribute = $2) ORDER BY id'` |
| packages/brain/src/store/reference-repo.ts:114 | `'SELECT * FROM reference.wiki_page WHERE id = ANY($1::text[]) ORDER BY id'` |
| packages/brain/src/store/reference-repo.ts:119 | `'SELECT * FROM reference.wiki_page ORDER BY id'` |
| packages/brain/src/store/reference-repo.ts:125 | `'SELECT id, text FROM reference.wiki_section WHERE embedding IS NULL ORDER BY id'` |
| packages/brain/src/store/reference-repo.ts:140 | `SELECT s.*, n.page_id AS page_id, 1 - (s.embedding <=> $1::vector) AS score FROM reference.wiki_section s JOIN reference.wiki_snapshot n ON n.id = s.snapshot_i` |
| packages/brain/src/store/reference-repo.ts:163 | `'SELECT id, embedding::text AS e FROM reference.wiki_section WHERE snapshot_id = $1 AND embedding IS NOT NULL'` |
| packages/brain/src/store/rows.ts:39 | `statement.sql` |
| packages/brain/src/store/rows.ts:44 | `COUNTS[table as keyof typeof COUNTS]` |
