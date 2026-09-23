-- 0006_integration_catalog (up) — catalogo GENERICO de entidades externas de uma integracao
-- (ex.: Kommo: pipeline, status, user, tag, custom_field), para resolver IDs em nomes sem hardcode no
-- frontend. Somente ADITIVA. Nao contem segredos; nao substitui o dado do sistema externo: e um
-- espelho de metadados de referencia (nome/hierarquia), com origem e data da ultima sincronizacao.

CREATE TABLE acc_integration_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL REFERENCES acc_integrations (id),
  -- tipo da entidade no sistema externo (livre, snake_case): 'pipeline', 'status', 'user', 'tag'...
  entity_kind text NOT NULL CHECK (entity_kind ~ '^[a-z][a-z0-9_]{1,40}$'),
  -- ID no sistema externo, SEMPRE texto (IDs externos nunca sao tratados como IDs internos)
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 64),
  -- hierarquia opcional (status -> pipeline)
  parent_kind text CHECK (parent_kind IS NULL OR parent_kind ~ '^[a-z][a-z0-9_]{1,40}$'),
  parent_external_id text CHECK (parent_external_id IS NULL OR length(parent_external_id) BETWEEN 1 AND 64),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  -- atributos nao sensiveis (cor, ordem, is_closed...). Sem PII alem do nome de exibicao.
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(attributes) <= 8192),
  -- entidade removida no sistema externo nao e apagada: fica inativa (historico continua resolvendo nomes)
  is_active boolean NOT NULL DEFAULT true,
  source text NOT NULL CHECK (source IN ('manual', 'registry', 'api_sync')),
  synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((parent_kind IS NULL) = (parent_external_id IS NULL))
);

-- chave natural: a mesma entidade externa aparece uma vez (o pai desambigua IDs reutilizados)
CREATE UNIQUE INDEX ux_acc_integration_entities_key
  ON acc_integration_entities (integration_id, entity_kind, external_id, COALESCE(parent_external_id, ''));
CREATE INDEX ix_acc_integration_entities_lookup
  ON acc_integration_entities (integration_id, entity_kind, external_id) INCLUDE (name, is_active);
CREATE INDEX ix_acc_integration_entities_parent
  ON acc_integration_entities (integration_id, parent_kind, parent_external_id) WHERE parent_external_id IS NOT NULL;

CREATE TRIGGER trg_acc_integration_entities_updated_at BEFORE UPDATE ON acc_integration_entities
  FOR EACH ROW EXECUTE FUNCTION acc_set_updated_at();
