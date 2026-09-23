import { LEVEL_A_SOURCE_PREFIX, parseTelemetry, type RunStatus, type TelemetryEnvelope } from '../../domain/telemetry.ts';
import type { Queryable } from '../auth/db.ts';
import { ingestTelemetry } from './ingest.ts';

// Coletor SOMENTE-LEITURA de execucoes do n8n (execution_entity) -> runs/eventos do Control Center.
// Observavel HOJE sem alterar nenhum workflow: id, workflowId, status, mode, startedAt, stoppedAt e
// workflowVersionId (qual versao do workflow rodou). NAO le execution_data (payloads de mensagens/PII/
// credenciais) nem tool calls: isso exige instrumentacao futura (ver docs/13_TELEMETRY_CONTRACT.md).
//
// Limitacoes conhecidas (por desenho): a entidade (lead) e o gatilho detalhado nao estao em
// execution_entity; a run nasce sem entidade. Mensagem de erro nao e lida (so o codigo de status).

export interface N8nExecutionRow {
  id: number | string;
  workflowId: string;
  status: string;
  mode: string;
  startedAt: Date | string | null;
  stoppedAt: Date | string | null;
  workflowVersionId: string | null;
}

/** status do n8n -> status da run. `running` = ainda em andamento (sem stoppedAt). */
export function mapStatus(status: string, stoppedAt: Date | null): { status: RunStatus; errorCode?: string } {
  switch (status) {
    case 'success': return { status: 'succeeded' };
    case 'error': return { status: 'failed', errorCode: 'N8N_ERROR' };
    case 'crashed': return { status: 'failed', errorCode: 'N8N_CRASHED' };
    case 'canceled': return { status: 'cancelled' };
    case 'running': case 'new': case 'waiting': return { status: 'running' };
    default: // 'unknown' e desconhecidos: so e terminal se o n8n registrou o fim
      return stoppedAt ? { status: 'failed', errorCode: 'N8N_UNKNOWN' } : { status: 'running' };
  }
}

const TRIGGER: Record<string, TelemetryEnvelope['run']['trigger_type']> = {
  webhook: 'webhook', manual: 'manual', trigger: 'other', cli: 'system', error: 'system', retry: 'system', integrated: 'system',
};

export interface AgentWorkflowMap {
  agentSlug: string;
  workflowId: string;
}

/** Workflows de agente conhecidos: versoes cadastradas que apontam para um workflow do n8n. */
export async function listAgentWorkflows(dst: Queryable, organization: string): Promise<AgentWorkflowMap[]> {
  const { rows } = await dst.query(
    `SELECT DISTINCT a.slug, v.workflow_external_id
       FROM acc_agent_versions v JOIN acc_agents a ON a.id = v.agent_id JOIN acc_organizations o ON o.id = a.organization_id
      WHERE o.slug = $1 AND v.workflow_external_id IS NOT NULL AND v.environment = 'production' AND a.status <> 'archived'`,
    [organization],
  );
  return rows.map((r) => ({ agentSlug: String(r.slug), workflowId: String(r.workflow_external_id) }));
}

export function toEnvelope(row: N8nExecutionRow, map: AgentWorkflowMap, organization: string): TelemetryEnvelope | null {
  if (!row.startedAt) return null; // execucao ainda nao iniciada: nada a observar
  const startedAt = new Date(row.startedAt);
  const stoppedAt = row.stoppedAt ? new Date(row.stoppedAt) : null;
  const mapped = mapStatus(row.status, stoppedAt);
  const terminal = mapped.status !== 'running';
  const completedAt = terminal ? (stoppedAt ?? startedAt) : null;
  return parseTelemetry({
    schema_version: 1,
    organization,
    source: LEVEL_A_SOURCE_PREFIX, // coleta Nivel A: sem resumos e sem error_message (imposto no contrato E no banco)
    agent: map.agentSlug,
    version: { workflow_external_id: map.workflowId, ...(row.workflowVersionId ? { workflow_version_id: row.workflowVersionId } : {}) },
    correlation_id: `n8n:${row.id}`,
    run: {
      key: `n8n:${row.id}`,
      trigger_type: TRIGGER[row.mode] ?? 'other',
      trigger_ref: `n8n:${row.mode}`,
      started_at: startedAt.toISOString(),
      ...(terminal ? { status: mapped.status, completed_at: (completedAt as Date).toISOString() } : {}),
      ...(mapped.errorCode ? { error: { code: mapped.errorCode } } : {}),
      metadata: { n8n_status: row.status, n8n_mode: row.mode, workflow_id: map.workflowId, workflow_version_id: row.workflowVersionId },
    },
  });
}

export interface CollectSummary {
  workflows: number;
  seen: number;
  newRuns: number;
  completed: number;
  unchanged: number;
  skipped: number;
}

/**
 * Le execucoes novas (startedAt > since) e as ainda "running" ja conhecidas, e as ingere.
 * `src` = banco do n8n (SELECT em colunas de metadados apenas); `dst` = banco do Control Center.
 * O chamador abre/fecha a transacao de `dst`. `src` nunca recebe escrita.
 */
export async function collectN8nExecutions(
  src: Queryable, dst: Queryable, opts: { organization: string; since: Date; limit?: number },
): Promise<CollectSummary> {
  const maps = await listAgentWorkflows(dst, opts.organization);
  const summary: CollectSummary = { workflows: maps.length, seen: 0, newRuns: 0, completed: 0, unchanged: 0, skipped: 0 };
  if (maps.length === 0) return summary;
  const byWorkflow = new Map(maps.map((m) => [m.workflowId, m]));
  const limit = Math.max(1, Math.min(5000, opts.limit ?? 1000));

  // runs ainda em andamento no Control Center: reconsultar suas execucoes para capturar o fim
  const open = await dst.query(
    `SELECT replace(run_key, 'n8n:', '')::int AS exec_id FROM acc_agent_runs WHERE status = 'running' AND run_key LIKE 'n8n:%' LIMIT 500`,
  );
  const openIds = open.rows.map((r) => Number(r.exec_id));

  const { rows } = await src.query(
    `SELECT id, "workflowId", status, mode, "startedAt", "stoppedAt", "workflowVersionId"
       FROM execution_entity
      WHERE "deletedAt" IS NULL AND "workflowId" = ANY($1)
        AND ("startedAt" > $2 OR id = ANY($3::int[]))
      ORDER BY "startedAt" NULLS LAST, id LIMIT $4`,
    [maps.map((m) => m.workflowId), opts.since, openIds, limit],
  );

  for (const r of rows as unknown as N8nExecutionRow[]) {
    summary.seen++;
    const map = byWorkflow.get(r.workflowId);
    const env = map ? toEnvelope(r, map, opts.organization) : null;
    if (!env) {
      summary.skipped++;
      continue;
    }
    const res = await ingestTelemetry(dst, env);
    if (res.runCreated) summary.newRuns++;
    if (env.run.status && env.run.status !== 'running' && res.eventsInserted > 0) summary.completed++;
    if (!res.runCreated && res.eventsInserted === 0) summary.unchanged++;
  }
  return summary;
}
