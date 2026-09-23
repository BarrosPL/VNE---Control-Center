import { createHash } from 'node:crypto';
import type { Registry } from '../../domain/registry.ts';
import { recordAudit } from '../auth/audit.ts';
import type { Queryable } from '../auth/db.ts';

// Importa o registro declarativo (identidade/configuracao) de forma idempotente.
// Principios:
//  - NAO sobrescreve estados de CONTROLE (agent.status/operational_mode, agent_tools.permission_mode,
//    integration.status, version.status): esses pertencem ao Control Center, nao ao arquivo.
//  - Nunca remove nada (sem hard delete): itens ausentes do arquivo sao apenas reportados (orphans).
//  - Deve rodar dentro de uma transacao aberta pelo chamador.

type Col = { name: string; value: unknown; json?: boolean };
type Counts = { created: number; updated: number; unchanged: number };
export interface ImportSummary {
  checksum: string;
  created: Record<string, number>;
  updated: Record<string, number>;
  unchanged: Record<string, number>;
  orphans: { agents: string[]; tools: string[]; integrations: string[]; capabilities: string[] };
}

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`identificador invalido: ${s}`);
  return s;
};

/** Upsert generico por chave natural. `immutable` so vale na criacao. Retorna o id (se a tabela tiver). */
async function upsert(
  db: Queryable,
  table: string,
  conflict: string[],
  cols: Col[],
  immutable: string[],
  counts: Counts,
  hasId = true,
): Promise<string | null> {
  const names = cols.map((c) => ident(c.name));
  const params = cols.map((c) => (c.json ? JSON.stringify(c.value ?? {}) : (c.value ?? null)));
  const placeholders = cols.map((c, i) => `$${i + 1}${c.json ? '::jsonb' : ''}`);
  const updatable = names.filter((n) => !conflict.includes(n) && !immutable.includes(n));
  const setClause = updatable.map((n) => `${n} = EXCLUDED.${n}`).join(', ');
  const guard = updatable.length
    ? `WHERE (${updatable.map((n) => `${ident(table)}.${n}`).join(', ')}) IS DISTINCT FROM (${updatable.map((n) => `EXCLUDED.${n}`).join(', ')})`
    : '';
  const action = updatable.length ? `DO UPDATE SET ${setClause} ${guard}` : 'DO NOTHING';
  const res = await db.query(
    `INSERT INTO ${ident(table)} (${names.join(', ')}) VALUES (${placeholders.join(', ')})
     ON CONFLICT (${conflict.map(ident).join(', ')}) ${action}
     RETURNING ${hasId ? 'id::text AS id, ' : ''}(xmax = 0) AS inserted`,
    params,
  );
  const row = res.rows[0];
  if (row) {
    if (row.inserted) counts.created++;
    else counts.updated++;
    return hasId ? String(row.id) : null;
  }
  counts.unchanged++;
  if (!hasId) return null;
  const where = conflict.map((c, i) => `${ident(c)} = $${i + 1}`).join(' AND ');
  const values = conflict.map((c) => cols.find((x) => x.name === c)?.value);
  const found = await db.query(`SELECT id::text AS id FROM ${ident(table)} WHERE ${where}`, values);
  return String(found.rows[0].id);
}

export async function importRegistry(db: Queryable, reg: Registry, opts?: { correlationId?: string }): Promise<ImportSummary> {
  const checksum = createHash('sha256').update(JSON.stringify(reg)).digest('hex');
  const c = {
    integrations: { created: 0, updated: 0, unchanged: 0 },
    capabilities: { created: 0, updated: 0, unchanged: 0 },
    tools: { created: 0, updated: 0, unchanged: 0 },
    agents: { created: 0, updated: 0, unchanged: 0 },
    versions: { created: 0, updated: 0, unchanged: 0 },
    agent_capabilities: { created: 0, updated: 0, unchanged: 0 },
    agent_tools: { created: 0, updated: 0, unchanged: 0 },
    agent_integrations: { created: 0, updated: 0, unchanged: 0 },
  };

  const org = await db.query('SELECT id::text AS id FROM acc_organizations WHERE slug = $1', [reg.organization]);
  if (!org.rows[0]) throw new Error(`Organizacao inexistente: ${reg.organization}`);
  const orgId = String(org.rows[0].id);

  const integrationIds = new Map<string, string>();
  for (const i of reg.integrations) {
    const id = await upsert(db, 'acc_integrations', ['organization_id', 'code', 'environment'], [
      { name: 'organization_id', value: orgId }, { name: 'code', value: i.code }, { name: 'environment', value: 'production' },
      { name: 'name', value: i.name }, { name: 'integration_type', value: i.integration_type },
      { name: 'metadata_without_secrets', value: i.metadata, json: true },
    ], [], c.integrations);
    integrationIds.set(i.code, id as string);
  }

  const capabilityIds = new Map<string, string>();
  for (const cap of reg.capabilities) {
    const id = await upsert(db, 'acc_capabilities', ['code'], [
      { name: 'code', value: cap.code }, { name: 'name', value: cap.name },
      { name: 'description', value: cap.description }, { name: 'risk_level', value: cap.risk_level },
    ], [], c.capabilities);
    capabilityIds.set(cap.code, id as string);
  }

  const toolIds = new Map<string, string>();
  for (const t of reg.tools) {
    const id = await upsert(db, 'acc_tools', ['code'], [
      { name: 'code', value: t.code }, { name: 'name', value: t.name }, { name: 'description', value: t.description },
      { name: 'tool_type', value: t.tool_type }, { name: 'mutation_level', value: t.mutation_level },
      { name: 'risk_level', value: t.risk_level },
      { name: 'integration_id', value: t.integration ? integrationIds.get(t.integration) : null },
      { name: 'external_reference', value: t.external_reference }, { name: 'metadata', value: t.metadata, json: true },
    ], [], c.tools);
    toolIds.set(t.code, id as string);
  }

  for (const a of reg.agents) {
    const before = c.agents.created;
    const agentId = (await upsert(db, 'acc_agents', ['organization_id', 'slug'], [
      { name: 'organization_id', value: orgId }, { name: 'slug', value: a.slug }, { name: 'name', value: a.name },
      { name: 'description', value: a.description }, { name: 'agent_type', value: a.agent_type },
      { name: 'status', value: a.status }, { name: 'operational_mode', value: a.operational_mode },
      { name: 'metadata', value: a.metadata, json: true },
    ], ['status', 'operational_mode'], c.agents)) as string;
    if (c.agents.created > before) {
      await recordAudit(db, {
        organizationId: orgId, actorType: 'system', action: 'AGENT_REGISTERED', targetType: 'agent', targetId: agentId,
        correlationId: opts?.correlationId, reason: `registro:${reg.source}`,
        after: { slug: a.slug, status: a.status, operational_mode: a.operational_mode },
      });
    }

    const v = a.version;
    await upsert(db, 'acc_agent_versions', ['agent_id', 'environment', 'version'], [
      { name: 'agent_id', value: agentId }, { name: 'environment', value: v.environment }, { name: 'version', value: v.version },
      { name: 'status', value: v.status }, { name: 'model_provider', value: v.model_provider },
      { name: 'model_name', value: v.model_name }, { name: 'workflow_external_id', value: v.workflow_external_id },
      { name: 'prompt_hash', value: v.prompt_hash }, { name: 'changelog', value: v.changelog },
    ], ['status'], c.versions);

    for (const cap of a.capabilities) {
      await upsert(db, 'acc_agent_capabilities', ['agent_id', 'capability_id'], [
        { name: 'agent_id', value: agentId }, { name: 'capability_id', value: capabilityIds.get(cap) },
      ], [], c.agent_capabilities, false);
    }
    for (const t of a.tools) {
      // registrar a ferramenta como habilitada reflete a realidade atual do workflow; depois disso o estado
      // de permissao e gerido pelo Control Center (immutable => nao e sobrescrito).
      await upsert(db, 'acc_agent_tools', ['agent_id', 'tool_id'], [
        { name: 'agent_id', value: agentId }, { name: 'tool_id', value: toolIds.get(t) },
        { name: 'permission_mode', value: 'enabled' },
      ], ['permission_mode'], c.agent_tools, false);
    }
    for (const i of a.integrations) {
      await upsert(db, 'acc_agent_integrations', ['agent_id', 'integration_id'], [
        { name: 'agent_id', value: agentId }, { name: 'integration_id', value: integrationIds.get(i.code) },
        { name: 'criticality', value: i.criticality }, { name: 'required', value: i.required },
      ], [], c.agent_integrations, false);
    }
  }

  const orphans = async (sql: string, known: string[]) =>
    (await db.query(sql, [known, orgId])).rows.map((r) => String(r.k));
  const summary: ImportSummary = {
    checksum,
    created: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.created])),
    updated: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.updated])),
    unchanged: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.unchanged])),
    orphans: {
      agents: await orphans('SELECT slug AS k FROM acc_agents WHERE organization_id = $2::uuid AND NOT (slug = ANY($1))', reg.agents.map((a) => a.slug)),
      tools: await orphans('SELECT code AS k FROM acc_tools WHERE $2::uuid IS NOT NULL AND NOT (code = ANY($1))', reg.tools.map((t) => t.code)),
      integrations: await orphans('SELECT code AS k FROM acc_integrations WHERE organization_id = $2::uuid AND NOT (code = ANY($1))', reg.integrations.map((i) => i.code)),
      capabilities: await orphans('SELECT code AS k FROM acc_capabilities WHERE $2::uuid IS NOT NULL AND NOT (code = ANY($1))', reg.capabilities.map((x) => x.code)),
    },
  };
  const changed = Object.values(c).some((x) => x.created + x.updated > 0);
  if (changed) {
    await recordAudit(db, {
      organizationId: orgId, actorType: 'system', action: 'REGISTRY_IMPORTED', targetType: 'registry', targetId: reg.source,
      correlationId: opts?.correlationId, reason: 'importacao do registro declarativo',
      after: { checksum, created: summary.created, updated: summary.updated },
    });
  }
  return summary;
}
