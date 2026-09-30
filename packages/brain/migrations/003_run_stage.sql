-- Pipeline stage log per CaseRun (stage name, timing, counters such as dropped claims or ACL denials).
CREATE TABLE brain.run_stage (
  run_id      text NOT NULL REFERENCES brain.case_run(id) ON DELETE CASCADE,
  stage       text NOT NULL,
  status      text NOT NULL CHECK (status IN ('completed','failed')),
  started_at  timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  stats       jsonb NOT NULL DEFAULT '{}',
  error       text,
  PRIMARY KEY (run_id, stage)
);
