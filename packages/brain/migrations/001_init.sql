-- Brain storage, SPEC §2. Four schemas; evidence and reference never reference each other (hard corpus separation, §1).
-- Brain tables point at claims/sources by id only (polymorphic: evidence OR reference), so they carry no FK into either corpus.
-- Every statement is plain SQL, run by src/store/migrate.ts inside one transaction per file.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS evidence;
CREATE SCHEMA IF NOT EXISTS reference;
CREATE SCHEMA IF NOT EXISTS brain;
CREATE SCHEMA IF NOT EXISTS org;

-- ============================================================ org
CREATE TABLE org.person (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  email         text NOT NULL,
  team          text NOT NULL,
  country       text NOT NULL,
  active        boolean NOT NULL,
  principal_ids text[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE org.expertise (
  person_id text NOT NULL,
  subject   text NOT NULL,
  country   text NOT NULL,
  weight    double precision NOT NULL CHECK (weight >= 0 AND weight <= 1),
  PRIMARY KEY (person_id, subject, country)
);
CREATE INDEX expertise_subject ON org.expertise (subject, country);

-- ============================================================ evidence (case documents A..N)
CREATE TABLE evidence.document (
  id                 text PRIMARY KEY,
  source_system      text NOT NULL CHECK (source_system IN ('sharepoint','teams','email','manual','ticket','other')),
  source_uri         text NOT NULL,
  title              text NOT NULL,
  owner_id           text,            -- soft reference to org.person (owners may be unknown people)
  author_id          text,
  last_edited_at     timestamptz NOT NULL,
  last_verified_at   timestamptz,
  verified_tier      text CHECK (verified_tier IN ('T0','T1','T2','T3','T4')),
  valid_until        timestamptz,
  declared_scope     jsonb NOT NULL DEFAULT '{}',
  allowed_principals text[] NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE evidence.snapshot (
  id           text PRIMARY KEY,
  document_id  text NOT NULL REFERENCES evidence.document(id) ON DELETE CASCADE,
  content_hash char(64) NOT NULL,
  text         text NOT NULL,
  fetched_at   timestamptz NOT NULL,
  version      integer NOT NULL CHECK (version >= 1),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, content_hash)
);
CREATE INDEX evidence_snapshot_hash ON evidence.snapshot (content_hash);

CREATE TABLE evidence.passage (
  id          text PRIMARY KEY,
  snapshot_id text NOT NULL REFERENCES evidence.snapshot(id) ON DELETE CASCADE,
  ordinal     integer NOT NULL CHECK (ordinal >= 0),
  start_off   integer NOT NULL CHECK (start_off >= 0),
  end_off     integer NOT NULL CHECK (end_off >= start_off),
  text        text NOT NULL,
  embedding   vector(768),             -- nomic-embed-text
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, ordinal)
);
CREATE INDEX passage_embedding ON evidence.passage USING hnsw (embedding vector_cosine_ops);

CREATE TABLE evidence.claim (
  id                   text PRIMARY KEY,
  source_id            text NOT NULL REFERENCES evidence.document(id) ON DELETE CASCADE,
  snapshot_id          text NOT NULL REFERENCES evidence.snapshot(id) ON DELETE CASCADE,
  passage_id           text NOT NULL REFERENCES evidence.passage(id) ON DELETE CASCADE,
  span_start           integer NOT NULL,
  span_end             integer NOT NULL,
  quote                text NOT NULL CHECK (char_length(quote) <= 300),
  subject              text NOT NULL,
  attribute            text NOT NULL,
  value                jsonb NOT NULL,
  qualifiers           jsonb NOT NULL DEFAULT '{}',
  temporal             jsonb NOT NULL DEFAULT '{}',
  polarity             text NOT NULL CHECK (polarity IN ('affirms','negates')),
  modality             text NOT NULL CHECK (modality IN ('rule','example','opinion','question','unknown')),
  extraction_confidence double precision NOT NULL CHECK (extraction_confidence >= 0 AND extraction_confidence <= 1),
  claim_key            char(40) NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evidence_claim_key ON evidence.claim (claim_key);
CREATE INDEX evidence_claim_snapshot ON evidence.claim (snapshot_id);
CREATE INDEX evidence_claim_subject ON evidence.claim (subject, attribute);

-- ============================================================ reference (wiki)
CREATE TABLE reference.wiki_page (
  id                 text PRIMARY KEY,
  space              text NOT NULL,
  title              text NOT NULL,
  uri                text NOT NULL,
  owner_id           text,
  official           boolean NOT NULL,
  last_edited_at     timestamptz NOT NULL,
  last_verified_at   timestamptz,
  declared_scope     jsonb NOT NULL DEFAULT '{}',
  allowed_principals text[] NOT NULL DEFAULT '{}',
  out_links          text[] NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reference.wiki_snapshot (
  id           text PRIMARY KEY,
  page_id      text NOT NULL REFERENCES reference.wiki_page(id) ON DELETE CASCADE,
  content_hash char(64) NOT NULL,
  text         text NOT NULL,
  fetched_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id, content_hash)
);

CREATE TABLE reference.wiki_section (
  id           text PRIMARY KEY,
  snapshot_id  text NOT NULL REFERENCES reference.wiki_snapshot(id) ON DELETE CASCADE,
  ordinal      integer NOT NULL CHECK (ordinal >= 0),
  heading_path text[] NOT NULL DEFAULT '{}',
  start_off    integer NOT NULL CHECK (start_off >= 0),
  end_off      integer NOT NULL CHECK (end_off >= start_off),
  text         text NOT NULL,
  embedding    vector(768),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, ordinal)
);
CREATE INDEX section_embedding ON reference.wiki_section USING hnsw (embedding vector_cosine_ops);

CREATE TABLE reference.reference_fact (
  id                   text PRIMARY KEY,
  source_id            text NOT NULL REFERENCES reference.wiki_page(id) ON DELETE CASCADE,
  snapshot_id          text NOT NULL REFERENCES reference.wiki_snapshot(id) ON DELETE CASCADE,
  passage_id           text NOT NULL REFERENCES reference.wiki_section(id) ON DELETE CASCADE,  -- the section
  span_start           integer NOT NULL,
  span_end             integer NOT NULL,
  quote                text NOT NULL CHECK (char_length(quote) <= 300),
  subject              text NOT NULL,
  attribute            text NOT NULL,
  value                jsonb NOT NULL,
  qualifiers           jsonb NOT NULL DEFAULT '{}',
  temporal             jsonb NOT NULL DEFAULT '{}',
  polarity             text NOT NULL CHECK (polarity IN ('affirms','negates')),
  modality             text NOT NULL CHECK (modality IN ('rule','example','opinion','question','unknown')),
  extraction_confidence double precision NOT NULL CHECK (extraction_confidence >= 0 AND extraction_confidence <= 1),
  claim_key            char(40) NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reference_fact_key ON reference.reference_fact (claim_key);
CREATE INDEX reference_fact_snapshot ON reference.reference_fact (snapshot_id);
CREATE INDEX reference_fact_subject ON reference.reference_fact (subject, attribute);

-- ============================================================ brain
CREATE TYPE brain.edge_type AS ENUM (
  'ASSERTS','MEMBER_OF','AGREES','CONTRADICTS','REFINES','SUPERSEDES','SCOPE_DISJOINT','DUPLICATE_OF','DERIVED_FROM',
  'CORROBORATES','FILLS_GAP','ADDS_CONTEXT','OWNS','VERIFIED','EXPERT_IN','INVALIDATES','RESOLVES'
);
CREATE TYPE brain.node_kind AS ENUM (
  'case_run','evidence_document','evidence_snapshot','evidence_passage','evidence_claim','wiki_page','wiki_snapshot',
  'wiki_section','reference_fact','fact','gap','conflict','canonical','person','org_event','subject_scope'
);

CREATE TABLE brain.case_run (
  id                     text PRIMARY KEY,
  question               text NOT NULL,
  principal_id           text NOT NULL,
  intent                 jsonb NOT NULL,
  status                 text NOT NULL CHECK (status IN ('running','completed','failed')),
  rules_version          text NOT NULL,
  prompt_versions        jsonb NOT NULL DEFAULT '{}',
  model_ids              jsonb NOT NULL DEFAULT '{}',
  evidence_snapshot_ids  text[] NOT NULL DEFAULT '{}',
  reference_snapshot_ids text[] NOT NULL DEFAULT '{}',
  started_at             timestamptz NOT NULL,
  finished_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE brain.fact (
  id                 text PRIMARY KEY,
  run_id             text NOT NULL REFERENCES brain.case_run(id) ON DELETE CASCADE,
  claim_key          char(40) NOT NULL,
  subject            text NOT NULL,
  attribute          text NOT NULL,
  scope              jsonb NOT NULL,
  slot_id            text,
  status             text NOT NULL CHECK (status IN ('VERIFIED','LIKELY','DISPUTED','PROVISIONAL','REJECTED','UNKNOWN')),
  confidence         double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
  winner_claim_id    text,
  winning_value      jsonb,
  reasons            jsonb NOT NULL DEFAULT '[]',
  needs_verification boolean NOT NULL,
  impact             text NOT NULL CHECK (impact IN ('high','medium','low')),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fact_run ON brain.fact (run_id);
CREATE INDEX fact_claim_key ON brain.fact (claim_key);

CREATE TABLE brain.gap (
  id          text PRIMARY KEY,
  run_id      text NOT NULL REFERENCES brain.case_run(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('MISSING_SLOT','UNRESOLVED_CONFLICT','WEAK_SUPPORT','MISSING_SCOPE','MISSING_TEMPORAL')),
  slot_id     text,
  fact_id     text REFERENCES brain.fact(id) ON DELETE CASCADE,
  description text NOT NULL,
  closed_by   text[],                 -- ReferenceFactIds
  status      text NOT NULL CHECK (status IN ('open','closed','partially_closed')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gap_run ON brain.gap (run_id);

CREATE TABLE brain.conflict (
  id          text PRIMARY KEY,
  run_id      text NOT NULL REFERENCES brain.case_run(id) ON DELETE CASCADE,
  fact_id     text NOT NULL REFERENCES brain.fact(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('value','polarity','temporal','scope','textual')),
  severity    text NOT NULL CHECK (severity IN ('high','medium','low')),
  claim_ids   text[] NOT NULL,
  resolution  text,
  resolved_by text CHECK (resolved_by IN ('rule','owner')),
  status      text NOT NULL CHECK (status IN ('open','resolved')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conflict_run ON brain.conflict (run_id);
CREATE INDEX conflict_fact ON brain.conflict (fact_id);

CREATE TABLE brain.canonical (
  key            text PRIMARY KEY,    -- subject|attribute|scopeKey
  value          jsonb NOT NULL,
  fact_id        text NOT NULL,
  run_id         text NOT NULL,
  confidence     double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
  verified_tier  text NOT NULL CHECK (verified_tier IN ('T0','T1','T2','T3','T4')),
  next_review_at timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE brain.attribution (
  run_id           text NOT NULL REFERENCES brain.case_run(id) ON DELETE CASCADE,
  source_kind      text NOT NULL CHECK (source_kind IN ('evidence','reference')),
  source_id        text NOT NULL,
  contribution_pct double precision NOT NULL CHECK (contribution_pct >= 0 AND contribution_pct <= 100),
  accepted_claims  text[] NOT NULL DEFAULT '{}',
  rejected_claims  jsonb NOT NULL DEFAULT '[]',   -- [{claimId, code}]
  reliability_pct  double precision NOT NULL CHECK (reliability_pct >= 0 AND reliability_pct <= 100),
  PRIMARY KEY (run_id, source_kind, source_id)
);

CREATE TABLE brain.verification_request (
  id                text PRIMARY KEY,
  fact_id           text NOT NULL REFERENCES brain.fact(id) ON DELETE CASCADE,
  requested_from_id text NOT NULL,
  reason            text NOT NULL,
  status            text NOT NULL CHECK (status IN ('pending','completed','expired','cancelled')),
  token_jti         text NOT NULL UNIQUE,
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_request_person ON brain.verification_request (requested_from_id, status);

-- Append-only audit log (SPEC §10, §13): no UPDATE, no DELETE.
CREATE TABLE brain.verification_event (
  id          text PRIMARY KEY,
  fact_id     text NOT NULL,
  claim_id    text,
  verifier_id text NOT NULL,
  action      text NOT NULL CHECK (action IN ('confirm','correct','rescope','reassign','reject')),
  tier        text NOT NULL CHECK (tier IN ('T0','T1','T2','T3','T4')),
  payload     jsonb NOT NULL DEFAULT '{}',
  at          timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_event_fact ON brain.verification_event (fact_id, at);

CREATE FUNCTION brain.forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER verification_event_append_only
  BEFORE UPDATE OR DELETE ON brain.verification_event
  FOR EACH ROW EXECUTE FUNCTION brain.forbid_mutation();

CREATE TABLE brain.org_event (
  id           text PRIMARY KEY,
  type         text NOT NULL CHECK (type IN ('law_change','indexation','cao_update','reorg','owner_left')),
  scope        jsonb NOT NULL DEFAULT '{}',
  domain       text NOT NULL,
  effective_at timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- One typed edge table for the whole graph (SPEC §2.2).
CREATE TABLE brain.edge (
  id         text PRIMARY KEY,
  type       brain.edge_type NOT NULL,
  from_id    text NOT NULL,
  from_kind  brain.node_kind NOT NULL,
  to_id      text NOT NULL,
  to_kind    brain.node_kind NOT NULL,
  props      jsonb NOT NULL DEFAULT '{}',
  run_id     text REFERENCES brain.case_run(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX edge_from_type ON brain.edge (from_id, type);
CREATE INDEX edge_to_type   ON brain.edge (to_id, type);
CREATE INDEX edge_run       ON brain.edge (run_id);
