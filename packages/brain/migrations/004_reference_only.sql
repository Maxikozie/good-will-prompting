-- Facts that rest only on reference (wiki) facts carry a flag; the ceiling (max PROVISIONAL) is enforced by the domain schema and
-- mirrored here so no writer can bypass it.
ALTER TABLE brain.fact ADD COLUMN reference_only boolean NOT NULL DEFAULT false;
ALTER TABLE brain.fact ADD CONSTRAINT fact_reference_only_ceiling CHECK (NOT reference_only OR status NOT IN ('VERIFIED', 'LIKELY'));

-- Independence group of every claim (evidence claim or reference fact) for a run: sources linked by copying share a group id.
CREATE TABLE brain.claim_group (
  run_id      text NOT NULL REFERENCES brain.case_run(id) ON DELETE CASCADE,
  claim_id    text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('evidence', 'reference')),
  source_id   text NOT NULL,
  group_id    text NOT NULL,
  PRIMARY KEY (run_id, claim_id)
);
CREATE INDEX claim_group_group ON brain.claim_group (run_id, group_id);
