-- 0007_agent_telemetry (up) — Fase 4A: sessoes, execucoes (runs) e eventos de agentes.
-- Somente ADITIVA. Schema AGNOSTICO de agente: nenhum nome de agente; entidade = (entity_type, entity_id)
-- com lead_id apenas como atalho. Nao toca em vne_* nem no n8n. Nenhum produtor esta conectado ainda.
--
-- Principios: (1) idempotencia por chave do produtor (run_key/event_key); (2) sem blobs: resumos e
-- payloads limitados; (3) sem PII: referenciar mensagens por id, nunca guardar o texto. Defesa em
-- PROFUNDIDADE: o contrato (src/domain/telemetry.ts) valida na borda E o banco repete as regras por CHECK:
-- (a) chaves sensiveis proibidas em payload/metadata (em qualquer profundidade); (b) e-mail/telefone
-- proibidos em textos livres; (c) coleta Nivel A (source 'n8n.collector') NAO grava resumos nem
-- error_message; (4) eventos append-only; (5) uma versao referenciada aqui passa a ser imutavel (0005).

-- Pre-requisito das FKs compostas (agente e organizacao coerentes)
ALTER TABLE acc_agents ADD CONSTRAINT uq_acc_agents_id_org UNIQUE (id, organization_id);

-- Funcoes de defesa (puras). A lista de chaves ESPELHA FORBIDDEN_KEY em src/domain/telemetry.ts; um teste
-- garante a equivalencia entre as duas implementacoes.
CREATE FUNCTION acc_jsonb_has_forbidden_keys(doc jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  k text;
  v jsonb;
BEGIN
  IF doc IS NULL THEN RETURN false; END IF;
  IF jsonb_typeof(doc) = 'object' THEN
    FOR k, v IN SELECT key, value FROM jsonb_each(doc) LOOP
      IF k ~* '^(text|texto|content|conteudo|body|message_text|message_body|prompt|system_prompt|completion|password|senha|secret|token|api[_-]?key|authorization|cookie|email|phone|telefone)$' THEN
        RETURN true;
      END IF;
      IF acc_jsonb_has_forbidden_keys(v) THEN RETURN true; END IF;
    END LOOP;
  ELSIF jsonb_typeof(doc) = 'array' THEN
    FOR v IN SELECT value FROM jsonb_array_elements(doc) LOOP
      IF acc_jsonb_has_forbidden_keys(v) THEN RETURN true; END IF;
    END LOOP;
  END IF;
  RETURN false;
END;
$$;

-- Texto livre com cara de dado pessoal: e-mail ou sequencia de 9+ digitos (telefone/documento).
CREATE FUNCTION acc_text_looks_personal(t text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT t IS NOT NULL AND (
    t ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}'
    OR t ~ '(\+?\d[\s().-]?){9,}'
  )
$$;

-- 1. Taxonomia de eventos (dado, nao enum: estender = INSERT em nova migration, sem alterar schema) -----

CREATE TABLE acc_event_types (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  category text NOT NULL CHECK (category IN ('message', 'run', 'tool', 'human', 'error', 'session', 'platform')),
  description text NOT NULL,
  default_level text NOT NULL DEFAULT 'info' CHECK (default_level IN ('info', 'warn', 'error')),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO acc_event_types (code, category, description, default_level) VALUES
  ('MESSAGE_RECEIVED', 'message', 'Mensagem do cliente recebida pelo agente', 'info'),
  ('RUN_STARTED', 'run', 'Execucao do agente iniciada', 'info'),
  ('TOOL_CALLED', 'tool', 'Agente invocou uma tool', 'info'),
  ('TOOL_SUCCEEDED', 'tool', 'Tool concluida com sucesso', 'info'),
  ('TOOL_FAILED', 'tool', 'Tool falhou', 'error'),
  ('MESSAGE_SENT', 'message', 'Mensagem enviada pelo agente ao cliente', 'info'),
  ('HUMAN_REQUESTED', 'human', 'Agente solicitou intervencao humana', 'warn'),
  ('RUN_SUCCEEDED', 'run', 'Execucao concluida com sucesso', 'info'),
  ('RUN_FAILED', 'run', 'Execucao falhou', 'error'),
  ('ERROR', 'error', 'Erro nao associado a uma tool', 'error');

-- 2. Sessoes: relacao continua entre um agente e uma entidade ------------------------------------------

CREATE TABLE acc_agent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  agent_version_id uuid,
  organization_id uuid NOT NULL,
  business_unit_id uuid,
  entity_type text NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_]{1,40}$'),
  entity_id text NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 128),
  lead_id bigint, -- atalho/index quando a entidade e um lead do Kommo (ID externo, nunca chave interna)
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'expired')),
  source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_.-]{1,40}$'), -- quem produziu: 'n8n', 'synthetic'...
  started_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  end_reason text CHECK (end_reason IS NULL OR (length(end_reason) <= 200 AND NOT acc_text_looks_personal(end_reason))),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(metadata) <= 16384 AND NOT acc_jsonb_has_forbidden_keys(metadata)),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (agent_id, organization_id) REFERENCES acc_agents (id, organization_id),
  FOREIGN KEY (agent_version_id, agent_id) REFERENCES acc_agent_versions (id, agent_id),
  FOREIGN KEY (business_unit_id, organization_id) REFERENCES acc_business_units (id, organization_id),
  UNIQUE (id, agent_id),
  CHECK ((status = 'active') = (ended_at IS NULL)),
  CHECK (last_activity_at >= started_at)
);
-- no maximo uma sessao ATIVA por agente e entidade
CREATE UNIQUE INDEX ux_acc_agent_sessions_active ON acc_agent_sessions (agent_id, entity_type, entity_id)
  WHERE status = 'active';
CREATE INDEX ix_acc_agent_sessions_agent ON acc_agent_sessions (agent_id, status, last_activity_at DESC);
CREATE INDEX ix_acc_agent_sessions_entity ON acc_agent_sessions (entity_type, entity_id, started_at DESC);
CREATE INDEX ix_acc_agent_sessions_lead ON acc_agent_sessions (lead_id, started_at DESC) WHERE lead_id IS NOT NULL;
CREATE INDEX ix_acc_agent_sessions_activity ON acc_agent_sessions (last_activity_at DESC);
CREATE INDEX ix_acc_agent_sessions_version ON acc_agent_sessions (agent_version_id) WHERE agent_version_id IS NOT NULL;

-- 3. Execucoes ---------------------------------------------------------------------------------------

CREATE TABLE acc_agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid,
  agent_id uuid NOT NULL REFERENCES acc_agents (id),
  agent_version_id uuid,
  correlation_id text NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 128),
  -- chave de idempotencia do produtor (ex.: id da execucao no n8n). Reenvios nao duplicam.
  run_key text CHECK (run_key IS NULL OR length(run_key) BETWEEN 1 AND 200),
  trigger_type text NOT NULL CHECK (trigger_type IN ('message', 'schedule', 'webhook', 'manual', 'system', 'other')),
  trigger_ref text CHECK (trigger_ref IS NULL OR (length(trigger_ref) <= 200 AND NOT acc_text_looks_personal(trigger_ref))),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'timed_out')),
  source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_.-]{1,40}$'),
  -- nem toda execucao conhece a entidade (ex.: execucoes observadas so pelo n8n)
  entity_type text CHECK (entity_type IS NULL OR entity_type ~ '^[a-z][a-z0-9_]{1,40}$'),
  entity_id text CHECK (entity_id IS NULL OR length(entity_id) BETWEEN 1 AND 128),
  lead_id bigint,
  model_provider text,
  model_name text,
  -- RESUMOS curtos gerados por maquina (nunca o texto de mensagens/prompts)
  input_summary text CHECK (input_summary IS NULL OR (length(input_summary) <= 2000 AND NOT acc_text_looks_personal(input_summary))),
  output_summary text CHECK (output_summary IS NULL OR (length(output_summary) <= 2000 AND NOT acc_text_looks_personal(output_summary))),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  estimated_cost numeric(12, 6) CHECK (estimated_cost IS NULL OR estimated_cost >= 0),
  error_code text CHECK (error_code IS NULL OR length(error_code) <= 64),
  error_message text CHECK (error_message IS NULL OR (length(error_message) <= 1000 AND NOT acc_text_looks_personal(error_message))),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(metadata) <= 16384 AND NOT acc_jsonb_has_forbidden_keys(metadata)),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, agent_id) REFERENCES acc_agent_sessions (id, agent_id),
  FOREIGN KEY (agent_version_id, agent_id) REFERENCES acc_agent_versions (id, agent_id),
  UNIQUE (id, agent_id),
  CHECK ((status = 'running') = (completed_at IS NULL)),
  CHECK (completed_at IS NULL OR completed_at >= started_at),
  CHECK ((entity_type IS NULL) = (entity_id IS NULL)),
  -- Coleta Nivel A (somente-leitura do n8n): NENHUM texto livre ate existir politica de sanitizacao de resumos
  CONSTRAINT ck_acc_agent_runs_level_a_no_text CHECK (
    source NOT LIKE 'n8n.collector%' OR (input_summary IS NULL AND output_summary IS NULL AND error_message IS NULL))
);
CREATE UNIQUE INDEX ux_acc_agent_runs_key ON acc_agent_runs (agent_id, run_key) WHERE run_key IS NOT NULL;
CREATE INDEX ix_acc_agent_runs_agent ON acc_agent_runs (agent_id, started_at DESC);
CREATE INDEX ix_acc_agent_runs_running ON acc_agent_runs (agent_id, started_at) WHERE status = 'running';
CREATE INDEX ix_acc_agent_runs_session ON acc_agent_runs (session_id, started_at) WHERE session_id IS NOT NULL;
CREATE INDEX ix_acc_agent_runs_entity ON acc_agent_runs (entity_type, entity_id, started_at DESC) WHERE entity_type IS NOT NULL;
CREATE INDEX ix_acc_agent_runs_lead ON acc_agent_runs (lead_id, started_at DESC) WHERE lead_id IS NOT NULL;
CREATE INDEX ix_acc_agent_runs_correlation ON acc_agent_runs (correlation_id);
CREATE INDEX ix_acc_agent_runs_failed ON acc_agent_runs (started_at DESC) WHERE status IN ('failed', 'timed_out');
CREATE INDEX ix_acc_agent_runs_started ON acc_agent_runs (started_at DESC);
CREATE INDEX ix_acc_agent_runs_version ON acc_agent_runs (agent_version_id) WHERE agent_version_id IS NOT NULL;

-- 4. Eventos (timeline canonica, append-only) ---------------------------------------------------------

CREATE TABLE acc_agent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE, -- desempate estavel de ordenacao / paginacao por cursor
  event_type text NOT NULL REFERENCES acc_event_types (code),
  level text NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'error')),
  agent_id uuid REFERENCES acc_agents (id),
  agent_version_id uuid,
  session_id uuid,
  run_id uuid,
  correlation_id text CHECK (correlation_id IS NULL OR length(correlation_id) BETWEEN 1 AND 128),
  entity_type text CHECK (entity_type IS NULL OR entity_type ~ '^[a-z][a-z0-9_]{1,40}$'),
  entity_id text CHECK (entity_id IS NULL OR length(entity_id) BETWEEN 1 AND 128),
  lead_id bigint,
  tool_id uuid REFERENCES acc_tools (id),
  -- nome observado da tool (pode nao estar cadastrada); a FK acima e opcional
  tool_code text CHECK (tool_code IS NULL OR length(tool_code) <= 128),
  integration_id uuid REFERENCES acc_integrations (id),
  -- idempotencia do produtor (ex.: '<execucao>:<node>:<n>'); (source, event_key) e unico
  event_key text CHECK (event_key IS NULL OR length(event_key) BETWEEN 1 AND 200),
  source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_.-]{1,40}$'),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  -- payload especifico e LIMITADO; nunca texto de mensagens (usar message_ref) nem segredos
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(payload) <= 16384 AND NOT acc_jsonb_has_forbidden_keys(payload)),
  FOREIGN KEY (agent_version_id, agent_id) REFERENCES acc_agent_versions (id, agent_id),
  FOREIGN KEY (session_id, agent_id) REFERENCES acc_agent_sessions (id, agent_id),
  FOREIGN KEY (run_id, agent_id) REFERENCES acc_agent_runs (id, agent_id),
  -- FKs compostas ignoram NULL: exigir agent_id sempre que houver sessao/run/versao
  CHECK ((session_id IS NULL AND run_id IS NULL AND agent_version_id IS NULL) OR agent_id IS NOT NULL),
  CHECK ((entity_type IS NULL) = (entity_id IS NULL)),
  CHECK (event_type NOT LIKE 'TOOL\_%' OR tool_id IS NOT NULL OR tool_code IS NOT NULL)
);
CREATE UNIQUE INDEX ux_acc_agent_events_key ON acc_agent_events (source, event_key) WHERE event_key IS NOT NULL;
CREATE INDEX ix_acc_agent_events_agent ON acc_agent_events (agent_id, occurred_at DESC, seq DESC) WHERE agent_id IS NOT NULL;
CREATE INDEX ix_acc_agent_events_entity ON acc_agent_events (entity_type, entity_id, occurred_at DESC, seq DESC) WHERE entity_type IS NOT NULL;
CREATE INDEX ix_acc_agent_events_lead ON acc_agent_events (lead_id, occurred_at DESC, seq DESC) WHERE lead_id IS NOT NULL;
CREATE INDEX ix_acc_agent_events_session ON acc_agent_events (session_id, occurred_at, seq) WHERE session_id IS NOT NULL;
CREATE INDEX ix_acc_agent_events_run ON acc_agent_events (run_id, seq) WHERE run_id IS NOT NULL;
CREATE INDEX ix_acc_agent_events_correlation ON acc_agent_events (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX ix_acc_agent_events_type ON acc_agent_events (event_type, occurred_at DESC);
CREATE INDEX ix_acc_agent_events_tool ON acc_agent_events (tool_id, occurred_at DESC) WHERE tool_id IS NOT NULL;
CREATE INDEX ix_acc_agent_events_level ON acc_agent_events (occurred_at DESC) WHERE level = 'error';
CREATE INDEX ix_acc_agent_events_time ON acc_agent_events (occurred_at DESC, seq DESC);

-- 5. Regras no banco (independem do produtor) ----------------------------------------------------------

-- eventos sao append-only (a retencao, quando existir, sera por particao/rotina administrativa propria)
CREATE FUNCTION acc_agent_events_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'acc_agent_events e append-only' USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER trg_acc_agent_events_no_update_delete BEFORE UPDATE OR DELETE ON acc_agent_events
  FOR EACH ROW EXECUTE FUNCTION acc_agent_events_immutable();
CREATE TRIGGER trg_acc_agent_events_no_truncate BEFORE TRUNCATE ON acc_agent_events
  FOR EACH STATEMENT EXECUTE FUNCTION acc_agent_events_immutable();

-- run: estado terminal e final; identidade imutavel; duration_ms calculado
CREATE FUNCTION acc_agent_runs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'running' THEN
    RAISE EXCEPTION 'RUN_FINAL: execucao % ja terminou (%) e nao pode ser alterada', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.agent_id, NEW.correlation_id, NEW.run_key, NEW.started_at, NEW.source, NEW.trigger_type)
     IS DISTINCT FROM (OLD.agent_id, OLD.correlation_id, OLD.run_key, OLD.started_at, OLD.source, OLD.trigger_type)
     OR (OLD.session_id IS NOT NULL AND NEW.session_id IS DISTINCT FROM OLD.session_id) THEN
    RAISE EXCEPTION 'RUN_IDENTITY_IMMUTABLE: identidade da execucao % nao pode ser alterada', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.completed_at IS NOT NULL AND NEW.duration_ms IS NULL THEN
    NEW.duration_ms := GREATEST(0, round(extract(epoch FROM (NEW.completed_at - NEW.started_at)) * 1000))::integer;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_acc_agent_runs_guard BEFORE UPDATE ON acc_agent_runs
  FOR EACH ROW EXECUTE FUNCTION acc_agent_runs_guard();

-- atividade da sessao acompanha os eventos (nunca retrocede)
CREATE FUNCTION acc_agent_events_touch_session() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.session_id IS NOT NULL THEN
    UPDATE acc_agent_sessions SET last_activity_at = GREATEST(last_activity_at, NEW.occurred_at)
     WHERE id = NEW.session_id AND status = 'active';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_acc_agent_events_touch_session AFTER INSERT ON acc_agent_events
  FOR EACH ROW EXECUTE FUNCTION acc_agent_events_touch_session();

-- usar uma versao a sela (imutabilidade da configuracao que produziu o comportamento observado)
CREATE TRIGGER trg_acc_agent_sessions_seal AFTER INSERT ON acc_agent_sessions
  FOR EACH ROW EXECUTE FUNCTION acc_seal_version_on_use();
CREATE TRIGGER trg_acc_agent_runs_seal AFTER INSERT ON acc_agent_runs
  FOR EACH ROW EXECUTE FUNCTION acc_seal_version_on_use();
CREATE TRIGGER trg_acc_agent_events_seal AFTER INSERT ON acc_agent_events
  FOR EACH ROW EXECUTE FUNCTION acc_seal_version_on_use();
