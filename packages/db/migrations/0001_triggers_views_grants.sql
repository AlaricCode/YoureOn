-- Custom SQL migration (DATA-MODEL §12): triggers, the audit_log tripwire CHECK and the
-- database timezone. Re-authored from DATA-MODEL §6.1 / §5.18. Later streams add their
-- own custom migrations for the triggers/views of the tables they introduce.

-- DATA-MODEL §12: run the database in UTC.
DO $$ BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC');
END $$;
--> statement-breakpoint

-- bets: monotonic money status, frozen binding fields, frozen authorizations, final
-- terminal states (except "the chain wins", §8.3), version bump.
CREATE FUNCTION bets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.onchain_status < OLD.onchain_status
     OR (OLD.onchain_status >= 'settled' AND NEW.onchain_status <> OLD.onchain_status) THEN
    RAISE EXCEPTION 'bet %: onchain_status % -> % rejected', OLD.id, OLD.onchain_status, NEW.onchain_status;
  END IF;
  IF OLD.state >= 'AWAITING_AUTHORIZATIONS' AND
     (NEW.terms_hash, NEW.stake_a, NEW.stake_b, NEW.mint, NEW.party_a_id, NEW.party_b_id, NEW.evidence_source)
       IS DISTINCT FROM
     (OLD.terms_hash, OLD.stake_a, OLD.stake_b, OLD.mint, OLD.party_a_id, OLD.party_b_id, OLD.evidence_source) THEN
    RAISE EXCEPTION 'bet %: binding fields are immutable once the terms card is shown', OLD.id;
  END IF;
  IF OLD.state >= 'LOCKED' AND
     (NEW.a_authorized_at, NEW.a_authorization_method, NEW.b_authorized_at, NEW.b_authorization_method)
       IS DISTINCT FROM
     (OLD.a_authorized_at, OLD.a_authorization_method, OLD.b_authorized_at, OLD.b_authorization_method) THEN
    RAISE EXCEPTION 'bet %: authorizations are frozen once locked', OLD.id;
  END IF;
  IF OLD.state >= 'PAID' AND NEW.state <> OLD.state
     AND NOT (OLD.state IN ('CANCELLED','EXPIRED')
              AND NEW.onchain_status BETWEEN 'locked' AND 'settled') THEN
    RAISE EXCEPTION 'bet %: terminal state % is final', OLD.id, OLD.state;
  END IF;
  NEW.updated_at := now();
  NEW.version    := OLD.version + 1;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER bets_guard BEFORE UPDATE ON bets FOR EACH ROW EXECUTE FUNCTION bets_guard();
--> statement-breakpoint

-- bets: both parties active and attested 18+ (BRIEF 5c guardrail; seed rows exempt).
CREATE FUNCTION bets_parties_attested() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW.is_seed AND (SELECT count(*) FROM users
      WHERE id IN (NEW.party_a_id, NEW.party_b_id) AND age_attested_18plus AND deleted_at IS NULL) <> 2 THEN
    RAISE EXCEPTION 'both parties must be active and attested 18+';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER bets_parties_attested BEFORE INSERT ON bets FOR EACH ROW EXECUTE FUNCTION bets_parties_attested();
--> statement-breakpoint

-- audit_log: append-only.
CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
--> statement-breakpoint

-- audit_log: biometric tripwire (DATA-MODEL §5.18, §10). No biometric data, ever.
ALTER TABLE audit_log ADD CONSTRAINT audit_log_no_biometrics
  CHECK (NOT (details ?| ARRAY['embedding','embedding_ciphertext','embedding_nonce','probe','face_image','image']));
