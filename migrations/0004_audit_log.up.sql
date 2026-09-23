-- 0004_audit_log (up) — trilha de auditoria append-only (CLAUDE.md §16). Somente ADITIVA.
-- Imutabilidade garantida por trigger: UPDATE, DELETE e TRUNCATE sao rejeitados para qualquer role.

CREATE TABLE acc_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES acc_organizations (id),
  actor_type text NOT NULL CHECK (actor_type IN ('human', 'agent', 'system')),
  actor_id uuid,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  correlation_id text,
  reason text,
  -- NUNCA gravar segredos (senhas, tokens, hashes) em before/after.
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_acc_audit_target ON acc_audit_log (target_type, target_id, created_at DESC);
CREATE INDEX ix_acc_audit_actor ON acc_audit_log (actor_id, created_at DESC) WHERE actor_id IS NOT NULL;
CREATE INDEX ix_acc_audit_action ON acc_audit_log (action, created_at DESC);
CREATE INDEX ix_acc_audit_created ON acc_audit_log (created_at DESC);
CREATE INDEX ix_acc_audit_correlation ON acc_audit_log (correlation_id) WHERE correlation_id IS NOT NULL;

CREATE FUNCTION acc_audit_log_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'acc_audit_log e append-only' USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER trg_acc_audit_log_no_update_delete BEFORE UPDATE OR DELETE ON acc_audit_log
  FOR EACH ROW EXECUTE FUNCTION acc_audit_log_immutable();
CREATE TRIGGER trg_acc_audit_log_no_truncate BEFORE TRUNCATE ON acc_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION acc_audit_log_immutable();
