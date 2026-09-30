-- Stage 60 output: one score row per claim of a run, and the ladder's decision per fact.
CREATE TABLE brain.claim_score (
  run_id      text NOT NULL REFERENCES brain.case_run(id) ON DELETE CASCADE,
  claim_id    text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('evidence', 'reference')),
  source_id   text NOT NULL,
  fact_id     text NOT NULL REFERENCES brain.fact(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('winner', 'support', 'rejected', 'context')),
  code        text,
  score       double precision NOT NULL CHECK (score >= 0 AND score <= 100),
  breakdown   jsonb NOT NULL,
  reasons     jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (run_id, claim_id)
);
CREATE INDEX claim_score_fact ON brain.claim_score (fact_id);

CREATE TABLE brain.fact_decision (
  run_id                      text NOT NULL REFERENCES brain.case_run(id) ON DELETE CASCADE,
  fact_id                     text NOT NULL REFERENCES brain.fact(id) ON DELETE CASCADE,
  rules_version               text NOT NULL,
  fired                       jsonb NOT NULL,
  decided_by                  text,
  cap                         text,
  correction_for              text[] NOT NULL DEFAULT '{}',
  escalate_to                 text[] NOT NULL DEFAULT '{}',
  scope_fit                   double precision NOT NULL,
  independent_corroborations  integer NOT NULL,
  PRIMARY KEY (run_id, fact_id)
);
