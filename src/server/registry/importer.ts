import { createHash } from 'node:crypto';
import { productionVersion, type Registry, type RegistryVersion } from '../../domain/registry.ts';
import { recordAudit } from '../auth/audit.ts';
import type { Queryable } from '../auth/db.ts';

// Importa o registro declarativo (v2) de forma idempotente, dentro de uma transacao do chamador.
//
// Regras (todas cobertas por teste):
//  1. O arquivo descreve IDENTIDADE e o que foi OBSERVADO no workflow. Estados de CONTROLE
//     (agent.status/operational_mode, agent_tools.permission_mode, integration.status, version.status
//     apos criada) pertencem ao Control Center e NUNCA sao sobrescritos.
//  2. Estado observado x politica: uma tool que sai do workflow vira observed_state='absent'
//     (com absent_since); o vinculo, o historico e a politica permanecem.
//  3. Versao usada/liberada (selada) e IMUTAVEL: configuracao diferente => VersionImmutableError
//     (declare uma nova versao). Procedencia de versao legada pode ser COMPLETADA uma unica vez.
//  4. Nunca remove nada (sem hard delete): itens ausentes do arquivo sao reportados como orfaos.

export class VersionImmutableError extends Error {
  readonly code = 'VERSION_IMMUTABLE';
}

type Col = { name: string; value: unknown; json?: boolean };
type Counts = { created: number; updated: number; unchanged: number };
const zero = (): Counts => ({ created: 0, updated: 0, unchanged: 0 });

export interface ObservationChange {
  agent: string;
  kind: 'tool' | 'integration';
  code: string;
  from: string;
  to: string;
}

export interface ImportSummary {
  checksum: string;
  created: Record<string, number>;
  updated: Record<string, number>;
  unchanged: Record<string, number>;
  versions: { registered: string[]; provenanceRecorded: string[]; updated: string[]; deprecated: string[] };
  observation: { changes: ObservationChange[] };
  orphans: { agents: string[]; tools: string[]; integrations: string[]; capabilities: string[] };
}

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`identificador invalido: ${s}`);
  return s;
};

/** Upsert generico por chave natural. `immutable` so vale na criacao. Retorna o id (se a tabela tiver). */
async function upsert(
  db: Queryable, table: string, conflict: string[], cols: Col[], immutable: string[], counts: Counts, hasId = true,
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

const sorted = (xs: string[]) => [...xs].sort();

/** Foto da configuracao declarada de uma versao (gravada em config_snapshot; sem conteudo de prompt). */
export function versionSnapshot(v: RegistryVersion) {
  return {
    model_provider: v.model_provider ?? null, model_name: v.model_name ?? null,
    workflow_external_id: v.workflow_external_id ?? null, prompt_hash: v.prompt_hash,
    tools: sorted(v.tools), disabled_tools: sorted(v.disabled_tools), integrations: sorted(v.integrations),
  };
}

interface Ctx {
  db: Queryable;
  orgId: string;
  correlationId?: string;
  summary: ImportSummary;
  counts: Record<string, Counts>;
}

async function syncVersion(ctx: Ctx, agentId: string, agentSlug: string, v: RegistryVersion): Promise<void> {
  const { db, summary, counts } = ctx;
  const snapshot = versionSnapshot(v);
  const label = `${agentSlug}/${v.environment}/${v.version}`;
  const found = await db.query(
    `SELECT id::text AS id, status, sealed_at, config_hash, source_revision, model_provider, model_name, workflow_external_id
       FROM acc_agent_versions WHERE agent_id = $1::uuid AND environment = $2 AND version = $3`,
    [agentId, v.environment, v.version],
  );
  const cur = found.rows[0];

  if (!cur) {
    // liberar (active) supera a versao ativa anterior do mesmo ambiente: ela vira deprecated (rollback possivel)
    if (v.status === 'active') {
      const prev = await db.query(
        `UPDATE acc_agent_versions SET status = 'deprecated'
          WHERE agent_id = $1::uuid AND environment = $2 AND status = 'active' RETURNING id::text AS id, version`,
        [agentId, v.environment],
      );
      for (const p of prev.rows) {
        summary.versions.deprecated.push(`${agentSlug}/${v.environment}/${p.version}`);
        await recordAudit(db, {
          organizationId: ctx.orgId, actorType: 'system', action: 'AGENT_VERSION_DEPRECATED', targetType: 'agent_version',
          targetId: String(p.id), correlationId: ctx.correlationId, reason: `superada por ${v.version}`,
          after: { status: 'deprecated', superseded_by: v.version },
        });
      }
    }
    const ins = await db.query(
      `INSERT INTO acc_agent_versions (agent_id, version, environment, status, model_provider, model_name, prompt_hash,
                                       workflow_external_id, changelog, config_hash, source_revision, config_snapshot)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb) RETURNING id::text AS id`,
      [agentId, v.version, v.environment, v.status, v.model_provider ?? null, v.model_name ?? null, v.prompt_hash,
        v.workflow_external_id ?? null, v.changelog ?? null, v.config_hash, v.source_revision, JSON.stringify(snapshot)],
    );
    counts.versions.created++;
    summary.versions.registered.push(label);
    await recordAudit(db, {
      organizationId: ctx.orgId, actorType: 'system', action: 'AGENT_VERSION_REGISTERED', targetType: 'agent_version',
      targetId: String(ins.rows[0].id), correlationId: ctx.correlationId, reason: `registro:${summary.checksum.slice(0, 12)}`,
      after: { version: v.version, environment: v.environment, status: v.status, config_hash: v.config_hash, source_revision: v.source_revision },
    });
    return;
  }

  const sealed = cur.sealed_at != null;
  if (cur.config_hash == null) {
    // versao LEGADA (anterior a procedencia): so pode ser completada se o declarado for CONSISTENTE com o gravado
    const consistent =
      (cur.model_name ?? null) === (v.model_name ?? null) &&
      (cur.model_provider ?? null) === (v.model_provider ?? null) &&
      (cur.workflow_external_id ?? null) === (v.workflow_external_id ?? null);
    if (!consistent) {
      throw new VersionImmutableError(
        `Versao ${label} ja existe com configuracao diferente da declarada; declare uma NOVA versao em vez de reescrever a existente.`,
      );
    }
    await db.query(
      `UPDATE acc_agent_versions SET config_hash = $2, source_revision = $3, config_snapshot = $4::jsonb
        WHERE id = $1::uuid`,
      [cur.id, v.config_hash, v.source_revision, JSON.stringify(snapshot)],
    );
    counts.versions.updated++;
    summary.versions.provenanceRecorded.push(label);
    await recordAudit(db, {
      organizationId: ctx.orgId, actorType: 'system', action: 'AGENT_VERSION_PROVENANCE_RECORDED', targetType: 'agent_version',
      targetId: String(cur.id), correlationId: ctx.correlationId, reason: 'procedencia completada uma unica vez em versao legada',
      after: { config_hash: v.config_hash, source_revision: v.source_revision },
    });
    return;
  }

  if (cur.config_hash === v.config_hash) {
    counts.versions.unchanged++;
    return;
  }

  // configuracao DIFERENTE da registrada
  if (sealed) {
    throw new VersionImmutableError(
      `Versao ${label} esta selada (usada/liberada) e a configuracao declarada mudou (${String(cur.config_hash).slice(0, 12)} -> ${v.config_hash.slice(0, 12)}). ` +
        'Declare uma NOVA versao; versoes usadas nao sao reescritas.',
    );
  }
  await db.query(
    `UPDATE acc_agent_versions SET model_provider = $2, model_name = $3, prompt_hash = $4, workflow_external_id = $5,
            changelog = $6, config_hash = $7, source_revision = $8, config_snapshot = $9::jsonb
      WHERE id = $1::uuid AND sealed_at IS NULL`,
    [cur.id, v.model_provider ?? null, v.model_name ?? null, v.prompt_hash, v.workflow_external_id ?? null,
      v.changelog ?? null, v.config_hash, v.source_revision, JSON.stringify(snapshot)],
  );
  counts.versions.updated++;
  summary.versions.updated.push(label);
  await recordAudit(db, {
    organizationId: ctx.orgId, actorType: 'system', action: 'AGENT_VERSION_UPDATED', targetType: 'agent_version',
    targetId: String(cur.id), correlationId: ctx.correlationId, reason: 'versao ainda nao usada (rascunho/candidata)',
    before: { config_hash: cur.config_hash, source_revision: cur.source_revision },
    after: { config_hash: v.config_hash, source_revision: v.source_revision },
  });
}

/** Sincroniza o estado OBSERVADO (nunca a politica) de tools e integracoes do agente. */
async function syncObservation(ctx: Ctx, agentId: string, agentSlug: string, pv: RegistryVersion, toolIds: Map<string, string>, integrationIds: Map<string, string>): Promise<void> {
  const { db, summary, counts } = ctx;
  const present = new Set(pv.tools);
  const disabled = new Set(pv.disabled_tools);
  const target = (code: string) => (present.has(code) ? 'present' : disabled.has(code) ? 'disabled_in_workflow' : 'absent');

  // vinculos novos: politica INICIAL reflete a realidade do workflow; depois disso e do Control Center
  for (const code of [...present, ...disabled]) {
    const res = await db.query(
      `INSERT INTO acc_agent_tools (agent_id, tool_id, permission_mode, observed_state, observed_at, observed_source)
       VALUES ($1::uuid, $2::uuid, $3, $4, now(), $5) ON CONFLICT (agent_id, tool_id) DO NOTHING RETURNING tool_id`,
      [agentId, toolIds.get(code), present.has(code) ? 'enabled' : 'disabled', target(code), pv.source_revision],
    );
    if (res.rows[0]) counts.agent_tools.created++;
  }
  const tools = await db.query(
    `SELECT x.code, t.tool_id::text AS tool_id, t.observed_state FROM acc_agent_tools t JOIN acc_tools x ON x.id = t.tool_id WHERE t.agent_id = $1::uuid`,
    [agentId],
  );
  for (const row of tools.rows) {
    const to = target(String(row.code));
    const from = String(row.observed_state);
    if (from === to) {
      counts.agent_tools.unchanged++;
      continue;
    }
    // atualiza SOMENTE colunas observed_* (o trigger do banco rejeita mexer na politica junto)
    await db.query(
      `UPDATE acc_agent_tools SET observed_state = $3, observed_at = now(), observed_source = $4,
              absent_since = CASE WHEN $3 = 'absent' THEN COALESCE(absent_since, now()) ELSE NULL END
        WHERE agent_id = $1::uuid AND tool_id = $2::uuid`,
      [agentId, row.tool_id, to, pv.source_revision],
    );
    counts.agent_tools.updated++;
    summary.observation.changes.push({ agent: agentSlug, kind: 'tool', code: String(row.code), from, to });
    if (from !== 'unknown') {
      await recordAudit(db, {
        organizationId: ctx.orgId, actorType: 'system', action: 'TOOL_OBSERVATION_CHANGED', targetType: 'agent_tool',
        targetId: `${agentId}:${String(row.code)}`, correlationId: ctx.correlationId, reason: pv.source_revision,
        before: { observed_state: from }, after: { observed_state: to },
      });
    }
  }

  const integ = new Set(pv.integrations);
  const links = await db.query(
    `SELECT i.code, ai.integration_id::text AS integration_id, ai.observed_state
       FROM acc_agent_integrations ai JOIN acc_integrations i ON i.id = ai.integration_id WHERE ai.agent_id = $1::uuid`,
    [agentId],
  );
  for (const row of links.rows) {
    const to = integ.has(String(row.code)) ? 'present' : 'absent';
    const from = String(row.observed_state);
    if (from === to) continue;
    await db.query(
      `UPDATE acc_agent_integrations SET observed_state = $3, observed_at = now(), observed_source = $4,
              absent_since = CASE WHEN $3 = 'absent' THEN COALESCE(absent_since, now()) ELSE NULL END
        WHERE agent_id = $1::uuid AND integration_id = $2::uuid`,
      [agentId, row.integration_id, to, pv.source_revision],
    );
    counts.agent_integrations.updated++;
    summary.observation.changes.push({ agent: agentSlug, kind: 'integration', code: String(row.code), from, to });
    if (from !== 'unknown') {
      await recordAudit(db, {
        organizationId: ctx.orgId, actorType: 'system', action: 'INTEGRATION_OBSERVATION_CHANGED', targetType: 'agent_integration',
        targetId: `${agentId}:${String(row.code)}`, correlationId: ctx.correlationId, reason: pv.source_revision,
        before: { observed_state: from }, after: { observed_state: to },
      });
    }
  }
  void integrationIds;
}

export async function importRegistry(db: Queryable, reg: Registry, opts?: { correlationId?: string }): Promise<ImportSummary> {
  const checksum = createHash('sha256').update(JSON.stringify(reg)).digest('hex');
  const counts: Record<string, Counts> = Object.fromEntries(
    ['integrations', 'capabilities', 'tools', 'agents', 'versions', 'agent_capabilities', 'agent_tools', 'agent_integrations'].map((k) => [k, zero()]),
  );
  const summary: ImportSummary = {
    checksum, created: {}, updated: {}, unchanged: {},
    versions: { registered: [], provenanceRecorded: [], updated: [], deprecated: [] },
    observation: { changes: [] },
    orphans: { agents: [], tools: [], integrations: [], capabilities: [] },
  };

  const org = await db.query('SELECT id::text AS id FROM acc_organizations WHERE slug = $1', [reg.organization]);
  if (!org.rows[0]) throw new Error(`Organizacao inexistente: ${reg.organization}`);
  const orgId = String(org.rows[0].id);
  const ctx: Ctx = { db, orgId, correlationId: opts?.correlationId, summary, counts };

  const integrationIds = new Map<string, string>();
  for (const i of reg.integrations) {
    const id = await upsert(db, 'acc_integrations', ['organization_id', 'code', 'environment'], [
      { name: 'organization_id', value: orgId }, { name: 'code', value: i.code }, { name: 'environment', value: 'production' },
      { name: 'name', value: i.name }, { name: 'integration_type', value: i.integration_type },
      { name: 'metadata_without_secrets', value: i.metadata, json: true },
    ], [], counts.integrations);
    integrationIds.set(i.code, id as string);
  }

  const capabilityIds = new Map<string, string>();
  for (const cap of reg.capabilities) {
    const id = await upsert(db, 'acc_capabilities', ['code'], [
      { name: 'code', value: cap.code }, { name: 'name', value: cap.name },
      { name: 'description', value: cap.description }, { name: 'risk_level', value: cap.risk_level },
    ], [], counts.capabilities);
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
    ], [], counts.tools);
    toolIds.set(t.code, id as string);
  }

  for (const a of reg.agents) {
    const before = counts.agents.created;
    const agentId = (await upsert(db, 'acc_agents', ['organization_id', 'slug'], [
      { name: 'organization_id', value: orgId }, { name: 'slug', value: a.slug }, { name: 'name', value: a.name },
      { name: 'description', value: a.description }, { name: 'agent_type', value: a.agent_type },
      { name: 'status', value: a.status }, { name: 'operational_mode', value: a.operational_mode },
      { name: 'metadata', value: a.metadata, json: true },
    ], ['status', 'operational_mode'], counts.agents)) as string;
    if (counts.agents.created > before) {
      await recordAudit(db, {
        organizationId: orgId, actorType: 'system', action: 'AGENT_REGISTERED', targetType: 'agent', targetId: agentId,
        correlationId: opts?.correlationId, reason: `registro:${reg.source}`,
        after: { slug: a.slug, status: a.status, operational_mode: a.operational_mode },
      });
    }

    // dependencias declaradas (politica) ANTES da observacao, para os vinculos existirem
    for (const i of a.integrations) {
      await upsert(db, 'acc_agent_integrations', ['agent_id', 'integration_id'], [
        { name: 'agent_id', value: agentId }, { name: 'integration_id', value: integrationIds.get(i.code) },
        { name: 'criticality', value: i.criticality }, { name: 'required', value: i.required },
      ], [], counts.agent_integrations, false);
    }
    for (const cap of a.capabilities) {
      await upsert(db, 'acc_agent_capabilities', ['agent_id', 'capability_id'], [
        { name: 'agent_id', value: agentId }, { name: 'capability_id', value: capabilityIds.get(cap) },
      ], [], counts.agent_capabilities, false);
    }

    // versoes: nao-ativas primeiro, ativa por ultimo (a liberacao deprecia a anterior)
    const ordered = [...a.versions].sort((x, y) => Number(x.status === 'active') - Number(y.status === 'active'));
    for (const v of ordered) await syncVersion(ctx, agentId, a.slug, v);

    const pv = productionVersion(a);
    if (pv) await syncObservation(ctx, agentId, a.slug, pv, toolIds, integrationIds);
  }

  const orphans = async (sql: string, known: string[]) => (await db.query(sql, [known, orgId])).rows.map((r) => String(r.k));
  summary.orphans = {
    agents: await orphans('SELECT slug AS k FROM acc_agents WHERE organization_id = $2::uuid AND NOT (slug = ANY($1))', reg.agents.map((a) => a.slug)),
    tools: await orphans('SELECT code AS k FROM acc_tools WHERE $2::uuid IS NOT NULL AND NOT (code = ANY($1))', reg.tools.map((t) => t.code)),
    integrations: await orphans('SELECT code AS k FROM acc_integrations WHERE organization_id = $2::uuid AND NOT (code = ANY($1))', reg.integrations.map((i) => i.code)),
    capabilities: await orphans('SELECT code AS k FROM acc_capabilities WHERE $2::uuid IS NOT NULL AND NOT (code = ANY($1))', reg.capabilities.map((x) => x.code)),
  };
  for (const [k, c] of Object.entries(counts)) {
    summary.created[k] = c.created;
    summary.updated[k] = c.updated;
    summary.unchanged[k] = c.unchanged;
  }
  const changed = Object.values(counts).some((x) => x.created + x.updated > 0);
  if (changed) {
    await recordAudit(db, {
      organizationId: orgId, actorType: 'system', action: 'REGISTRY_IMPORTED', targetType: 'registry', targetId: reg.source,
      correlationId: opts?.correlationId, reason: 'importacao do registro declarativo',
      after: { checksum, created: summary.created, updated: summary.updated, observation_changes: summary.observation.changes.length },
    });
  }
  return summary;
}
