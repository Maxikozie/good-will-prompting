-- Content-hash cache for LLM answers (SPEC §5 stage 20): same prompt + same input + same model = same answer.
-- Only schema-valid responses are stored; the first answer for a key wins.
CREATE TABLE brain.llm_cache (
  prompt_id      text NOT NULL,
  prompt_version text NOT NULL,
  model_id       text NOT NULL,
  input_hash     char(64) NOT NULL,
  response       jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (prompt_id, prompt_version, model_id, input_hash)
);
