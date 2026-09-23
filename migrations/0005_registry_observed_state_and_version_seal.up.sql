-- 0005_registry_observed_state_and_version_seal (up)
-- Hardening do Agent Registry. Somente ADITIVA (ADD COLUMN/CONSTRAINT/TRIGGER em objetos acc_*);
-- nao toca em vne_* nem no n8n.
--
--  (a) Separa o ESTADO OBSERVADO da tool/integracao no workflow (fato lido do n8n) da POLITICA do
--      Control Center (permission_mode, approval_required...). Uma tool retirada do workflow vira
--      observed_state = 'absent' sem apagar o vinculo, o historico nem a politica.
--  (b) Torna imutavel a configuracao de uma versao de agente que ja foi usada/liberada (selada),
--      com procedencia (config_hash, source_revision, config_snapshot).

-- (a) Estado observado ----------------------------------------------------------------------

ALTER TABLE acc_agent_tools
  ADD COLUMN observed_state text NOT NULL DEFAULT 'unknown'
    CHECK (observed_state IN ('present', 'absent', 'disabled_in_workflow', 'unknown')),
  ADD COLUMN observed_at timestamptz,
  ADD COLUMN observed_source text,
  ADD COLUMN absent_since timestamptz,
  ADD CONSTRAINT ck_acc_agent_tools_absent_since CHECK ((observed_state = 'absent') = (absent_since IS NOT NULL));

ALTER TABLE acc_agent_integrations
  ADD COLUMN observed_state text NOT NULL DEFAULT 'unknown'
    CHECK (observed_state IN ('present', 'absent', 'disabled_in_workflow', 'unknown')),
  ADD COLUMN observed_at timestamptz,
  ADD COLUMN observed_source text,
  ADD COLUMN absent_since timestamptz,
  ADD CONSTRAINT ck_acc_agent_integrations_absent_since CHECK ((observed_state = 'absent') = (absent_since IS NOT NULL));

CREATE INDEX ix_acc_agent_tools_observed ON acc_agent_tools (agent_id, observed_state);

-- Defesa em profundidade: observar NUNCA muda a politica. Um UPDATE que altera o estado observado
-- nao pode, no mesmo comando, alterar permission_mode/approval_required (e vice-versa).
CREATE FUNCTION acc_agent_tools_observation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.observed_state, NEW.absent_since) IS DISTINCT FROM (OLD.observed_state, OLD.absent_since)
     AND (NEW.permission_mode, NEW.approval_required, NEW.configuration)
         IS DISTINCT FROM (OLD.permission_mode, OLD.approval_required, OLD.configuration) THEN
    RAISE EXCEPTION 'POLICY_UNCHANGED_BY_OBSERVATION: observar o workflow nao altera a politica da tool'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_acc_agent_tools_observation_guard BEFORE UPDATE ON acc_agent_tools
  FOR EACH ROW EXECUTE FUNCTION acc_agent_tools_observation_guard();

-- (b) Versoes: procedencia e selagem ----------------------------------------------------------

ALTER TABLE acc_agent_versions
  ADD COLUMN config_hash text CHECK (config_hash IS NULL OR config_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN source_revision text,
  ADD COLUMN config_snapshot jsonb CHECK (config_snapshot IS NULL OR pg_column_size(config_snapshot) <= 32768),
  ADD COLUMN sealed_at timestamptz,
  ADD CONSTRAINT uq_acc_agent_versions_id_agent UNIQUE (id, agent_id);

-- a mesma configuracao nao pode ser cadastrada duas vezes para o mesmo agente/ambiente
CREATE UNIQUE INDEX ux_acc_agent_versions_config ON acc_agent_versions (agent_id, environment, config_hash)
  WHERE config_hash IS NOT NULL;

-- versoes ja liberadas antes desta migration passam a ser seladas (imutaveis)
UPDATE acc_agent_versions SET sealed_at = now()
 WHERE status IN ('active', 'deprecated', 'archived') AND sealed_at IS NULL;

CREATE FUNCTION acc_agent_versions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IN ('active', 'deprecated', 'archived') AND NEW.sealed_at IS NULL THEN
      NEW.sealed_at := now();
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.sealed_at IS NOT NULL THEN
      RAISE EXCEPTION 'VERSION_IMMUTABLE: versao selada nao pode ser removida (%)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE de versao ainda nao selada: liberar (active/deprecated/archived) sela.
  IF OLD.sealed_at IS NULL THEN
    IF NEW.status IN ('active', 'deprecated', 'archived') AND NEW.sealed_at IS NULL THEN
      NEW.sealed_at := now();
      IF NEW.status = 'active' AND NEW.released_at IS NULL THEN NEW.released_at := now(); END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE de versao SELADA: a configuracao e imutavel.
  IF NEW.sealed_at IS DISTINCT FROM OLD.sealed_at THEN
    RAISE EXCEPTION 'VERSION_IMMUTABLE: sealed_at nao pode ser alterado (%)', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.agent_id, NEW.version, NEW.environment, NEW.model_provider, NEW.model_name, NEW.temperature,
      NEW.prompt_hash, NEW.prompt_location, NEW.prompt_content, NEW.workflow_external_id, NEW.changelog, NEW.created_at)
     IS DISTINCT FROM
     (OLD.agent_id, OLD.version, OLD.environment, OLD.model_provider, OLD.model_name, OLD.temperature,
      OLD.prompt_hash, OLD.prompt_location, OLD.prompt_content, OLD.workflow_external_id, OLD.changelog, OLD.created_at) THEN
    RAISE EXCEPTION 'VERSION_IMMUTABLE: a configuracao de uma versao selada nao pode ser reescrita (%); crie uma nova versao', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- procedencia: pode ser COMPLETADA uma unica vez (NULL -> valor), nunca reescrita
  IF (OLD.config_hash IS NOT NULL AND NEW.config_hash IS DISTINCT FROM OLD.config_hash)
     OR (OLD.source_revision IS NOT NULL AND NEW.source_revision IS DISTINCT FROM OLD.source_revision)
     OR (OLD.config_snapshot IS NOT NULL AND NEW.config_snapshot IS DISTINCT FROM OLD.config_snapshot) THEN
    RAISE EXCEPTION 'VERSION_IMMUTABLE: procedencia (config_hash/source_revision/config_snapshot) ja registrada (%)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at)
     OR (OLD.released_by IS NOT NULL AND NEW.released_by IS DISTINCT FROM OLD.released_by) THEN
    RAISE EXCEPTION 'VERSION_IMMUTABLE: dados de liberacao ja registrados (%)', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  -- status: apenas ciclo de vida (active <-> deprecated para rollback, e encerramento em archived)
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'active' AND NEW.status IN ('deprecated', 'archived'))
    OR (OLD.status = 'deprecated' AND NEW.status IN ('active', 'archived'))) THEN
    RAISE EXCEPTION 'VERSION_IMMUTABLE: transicao de status invalida em versao selada (% -> %)', OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_acc_agent_versions_guard BEFORE INSERT OR UPDATE OR DELETE ON acc_agent_versions
  FOR EACH ROW EXECUTE FUNCTION acc_agent_versions_guard();

-- Selagem por USO: a primeira sessao/run/evento que referencia a versao a sela. SECURITY DEFINER para
-- que o produtor de telemetria (role da aplicacao) possa selar sem ter permissao de editar versoes.
CREATE FUNCTION acc_seal_version_on_use() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.agent_version_id IS NOT NULL THEN
    UPDATE acc_agent_versions SET sealed_at = now() WHERE id = NEW.agent_version_id AND sealed_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION acc_seal_version_on_use() FROM PUBLIC;
