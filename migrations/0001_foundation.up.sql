-- 0001_foundation (up) — Fase 1: fundacao de dados do VNE Agent Control Center.
-- Somente ADITIVA: cria objetos acc_*. Nao toca em vne_* nem em tabelas do n8n.
-- Convencoes: UUID interno, timestamptz (UTC), sem hard delete (FKs RESTRICT),
-- IDs externos em colunas proprias, JSONB apenas para payload variavel.

CREATE OR REPLACE FUNCTION acc_set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- 1. Organizacao ------------------------------------------------------------

CREATE TABLE acc_organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE acc_business_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES acc_organizations (id),
  slug text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug),
  UNIQUE (id, organization_id)
);

-- 2. Pessoas e equipes ------------------------------------------------------

CREATE TABLE acc_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_user_id text,
  name text NOT NULL,
  email text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'invited')),
  role text NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'manager', 'specialist', 'viewer')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_acc_users_email ON acc_users (lower(email));
CREATE UNIQUE INDEX ux_acc_users_external ON acc_users (external_user_id)
  WHERE external_user_id IS NOT NULL;

CREATE TABLE acc_teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES acc_organizations (id),
  business_unit_id uuid,
  slug text NOT NULL,
  name text NOT NULL,
  category text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug),
  UNIQUE (id, organization_id),
  -- a business unit deve pertencer a mesma organizacao
  FOREIGN KEY (business_unit_id, organization_id)
    REFERENCES acc_business_units (id, organization_id)
);

CREATE TABLE acc_team_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES acc_teams (id),
  user_id uuid NOT NULL REFERENCES acc_users (id),
  membership_role text NOT NULL DEFAULT 'member' CHECK (membership_role IN ('lead', 'member')),
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, user_id)
);
CREATE INDEX ix_acc_team_members_user ON acc_team_members (user_id);

-- 3. Agentes ----------------------------------------------------------------

CREATE TABLE acc_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES acc_organizations (id),
  business_unit_id uuid,
  slug text NOT NULL,
  name text NOT NULL,
  description text,
  agent_type text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  -- novo agente nasce pausado: nada roda antes de ser habilitado explicitamente
  operational_mode text NOT NULL DEFAULT 'paused'
    CHECK (operational_mode IN ('active', 'read_only', 'paused', 'degraded', 'disabled')),
  owner_team_id uuid REFERENCES acc_teams (id),
  owner_user_id uuid REFERENCES acc_users (id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug),
  FOREIGN KEY (business_unit_id, organization_id)
    REFERENCES acc_business_units (id, organization_id)
);
CREATE INDEX ix_acc_agents_status ON acc_agents (status, operational_mode);

CREATE TABLE acc_agent_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES acc_agents (id),
  version text NOT NULL,
  environment text NOT NULL DEFAULT 'production'
    CHECK (environment IN ('development', 'staging', 'production')),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'candidate', 'active', 'deprecated', 'archived')),
  model_provider text,
  model_name text,
  temperature numeric(4, 2),
  prompt_hash text,
  prompt_location text,
  prompt_content text,
  workflow_external_id text,
  changelog text,
  released_at timestamptz,
  released_by uuid REFERENCES acc_users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, environment, version)
);
-- no maximo uma versao ativa por agente e ambiente
CREATE UNIQUE INDEX ux_acc_agent_versions_active
  ON acc_agent_versions (agent_id, environment) WHERE status = 'active';
CREATE INDEX ix_acc_agent_versions_workflow ON acc_agent_versions (workflow_external_id)
  WHERE workflow_external_id IS NOT NULL;

-- 4. Capabilities -----------------------------------------------------------

CREATE TABLE acc_capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  risk_level text NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE acc_agent_capabilities (
  agent_id uuid NOT NULL REFERENCES acc_agents (id),
  capability_id uuid NOT NULL REFERENCES acc_capabilities (id),
  enabled boolean NOT NULL DEFAULT true,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, capability_id)
);
CREATE INDEX ix_acc_agent_capabilities_capability ON acc_agent_capabilities (capability_id);

-- 5. Integracoes (antes de tools: tools referenciam integracoes) ------------

CREATE TABLE acc_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES acc_organizations (id),
  code text NOT NULL,
  name text NOT NULL,
  integration_type text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'degraded', 'disabled')),
  environment text NOT NULL DEFAULT 'production'
    CHECK (environment IN ('development', 'staging', 'production')),
  -- NUNCA armazenar segredos aqui: somente metadados nao sensiveis.
  metadata_without_secrets jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code, environment)
);

-- 6. Tools ------------------------------------------------------------------

CREATE TABLE acc_tools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  tool_type text NOT NULL,
  mutation_level text NOT NULL DEFAULT 'read'
    CHECK (mutation_level IN ('read', 'write', 'destructive')),
  risk_level text NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  integration_id uuid REFERENCES acc_integrations (id),
  external_reference text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_acc_tools_integration ON acc_tools (integration_id)
  WHERE integration_id IS NOT NULL;

CREATE TABLE acc_agent_tools (
  agent_id uuid NOT NULL REFERENCES acc_agents (id),
  tool_id uuid NOT NULL REFERENCES acc_tools (id),
  -- tool nasce desabilitada para o agente: habilitar e decisao explicita
  permission_mode text NOT NULL DEFAULT 'disabled'
    CHECK (permission_mode IN ('enabled', 'read_only', 'approval_required', 'disabled')),
  approval_required boolean NOT NULL DEFAULT false,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, tool_id)
);
CREATE INDEX ix_acc_agent_tools_tool ON acc_agent_tools (tool_id);

CREATE TABLE acc_agent_integrations (
  agent_id uuid NOT NULL REFERENCES acc_agents (id),
  integration_id uuid NOT NULL REFERENCES acc_integrations (id),
  criticality text NOT NULL DEFAULT 'normal'
    CHECK (criticality IN ('low', 'normal', 'high', 'critical')),
  required boolean NOT NULL DEFAULT false,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, integration_id)
);
CREATE INDEX ix_acc_agent_integrations_integration ON acc_agent_integrations (integration_id);

-- updated_at automatico -------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'acc_organizations', 'acc_business_units', 'acc_users', 'acc_teams', 'acc_agents',
    'acc_agent_capabilities', 'acc_integrations', 'acc_tools', 'acc_agent_tools'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON %1$I
       FOR EACH ROW EXECUTE FUNCTION acc_set_updated_at()', t);
  END LOOP;
END;
$$;
