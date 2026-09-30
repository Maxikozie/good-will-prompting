-- Durable, monotonic use marker: old completed tokens remain consumed after upgrade.
ALTER TABLE brain.verification_request ADD COLUMN used_at timestamptz;
UPDATE brain.verification_request SET used_at = created_at WHERE status = 'completed';

CREATE FUNCTION brain.guard_verification_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.fact_id, NEW.requested_from_id, NEW.token_jti, NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.fact_id, OLD.requested_from_id, OLD.token_jti, OLD.expires_at, OLD.created_at)
     OR (OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at)
     OR (OLD.status <> 'pending' AND NEW.status IS DISTINCT FROM OLD.status)
     OR (NEW.status = 'completed' AND NEW.used_at IS NULL)
     OR (NEW.used_at IS NOT NULL AND NEW.status <> 'completed') THEN
    RAISE EXCEPTION 'verification token bindings and terminal state are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER verification_request_monotonic
  BEFORE UPDATE ON brain.verification_request
  FOR EACH ROW EXECUTE FUNCTION brain.guard_verification_request();
