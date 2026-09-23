-- 0005_registry_observed_state_and_version_seal (down)
-- Remove colunas/triggers criados por 0005. PERDE procedencia (config_hash/source_revision/config_snapshot),
-- selagem e estados observados. Por isso recusa executar se houver esses dados, a menos que o runner
-- receba --force (que define acc.force = 'on' dentro da transacao).
DO $$
BEGIN
  IF coalesce(current_setting('acc.force', true), '') <> 'on' AND (
       EXISTS (SELECT 1 FROM acc_agent_versions
                WHERE sealed_at IS NOT NULL OR config_hash IS NOT NULL OR source_revision IS NOT NULL OR config_snapshot IS NOT NULL)
    OR EXISTS (SELECT 1 FROM acc_agent_tools WHERE observed_state <> 'unknown')
    OR EXISTS (SELECT 1 FROM acc_agent_integrations WHERE observed_state <> 'unknown')) THEN
    RAISE EXCEPTION 'Rollback de 0005 recusado: existem versoes seladas/procedencia ou estados observados (use --force com aprovacao)';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_acc_agent_versions_guard ON acc_agent_versions;
DROP TRIGGER IF EXISTS trg_acc_agent_tools_observation_guard ON acc_agent_tools;
DROP TRIGGER IF EXISTS trg_acc_agent_integrations_observation_guard ON acc_agent_integrations;
DROP FUNCTION IF EXISTS acc_seal_version_on_use();
DROP FUNCTION IF EXISTS acc_agent_versions_guard();
DROP FUNCTION IF EXISTS acc_agent_tools_observation_guard();
DROP FUNCTION IF EXISTS acc_agent_integrations_observation_guard();

DROP INDEX IF EXISTS ux_acc_agent_versions_config;
DROP INDEX IF EXISTS ix_acc_agent_tools_observed;

ALTER TABLE acc_agent_versions
  DROP CONSTRAINT IF EXISTS uq_acc_agent_versions_id_agent,
  DROP COLUMN IF EXISTS sealed_at,
  DROP COLUMN IF EXISTS config_snapshot,
  DROP COLUMN IF EXISTS source_revision,
  DROP COLUMN IF EXISTS config_hash;

ALTER TABLE acc_agent_integrations
  DROP CONSTRAINT IF EXISTS ck_acc_agent_integrations_absent_since,
  DROP COLUMN IF EXISTS absent_since,
  DROP COLUMN IF EXISTS observed_source,
  DROP COLUMN IF EXISTS observed_at,
  DROP COLUMN IF EXISTS observed_state;

ALTER TABLE acc_agent_tools
  DROP CONSTRAINT IF EXISTS ck_acc_agent_tools_absent_since,
  DROP COLUMN IF EXISTS absent_since,
  DROP COLUMN IF EXISTS observed_source,
  DROP COLUMN IF EXISTS observed_at,
  DROP COLUMN IF EXISTS observed_state;
