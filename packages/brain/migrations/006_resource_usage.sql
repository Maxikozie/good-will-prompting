-- Atomic, restart-safe model reservations. Failed model calls/retries still cost budget.
CREATE TABLE brain.resource_usage (
  scope text NOT NULL CHECK (scope IN ('run', 'principal_hour')),
  key text NOT NULL,
  calls integer NOT NULL CHECK (calls >= 0),
  tokens bigint NOT NULL CHECK (tokens >= 0),
  PRIMARY KEY (scope, key)
);
