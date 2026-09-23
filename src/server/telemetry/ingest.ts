import { createHash } from 'node:crypto';
import { DEFAULT_LEVEL, type EventType, type TelemetryEnvelope, type TelemetryEventInput } from '../../domain/telemetry.ts';
import type { Queryable } from '../auth/db.ts';

// Ingestao de telemetria (contrato schema_version 1). Idempotente por (agent, run.key) e por
// (source, event_key): reenviar o mesmo envelope nao duplica nada. Deve rodar numa transacao do chamador.

export class TelemetryError extends Error {
  // campo explicito (sem "parameter property"): os scripts rodam este modulo via type stripping do Node
  readonly code: 'AGENT_NOT_FOUND';
  constructor(code: 'AGENT_NOT_FOUND', message: string) {
    super(message);
    this.code = code;
  }
}

export interface IngestResult {
  agentId: string;
  versionId: string | null;
  /** o produtor informou como identificar a versao, mas nenhuma versao cadastrada bateu */
  versionUnresolved: boolean;
  sessionId: string | null;
  runId: string;
  runCreated: boolean;
  runStatus: string;
  eventsInserted: number;
  eventsDuplicate: number;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);

async function resolveVersion(db: Queryable, agentId: string, v: TelemetryEnvelope['version']): Promise<{ id: string | null; unresolved: boolean }> {
  if (!v || (!v.config_hash && !v.workflow_version_id && !v.workflow_external_id)) return { id: null, unresolved: false };
  let row;
  if (v.config_hash) {
    row = (await db.query(
      `SELECT id::text AS id FROM acc_agent_versions WHERE agent_id = $1::uuid AND config_hash = $2
        ORDER BY (environment = 'production') DESC LIMIT 1`, [agentId, v.config_hash])).rows[0];
  } else if (v.workflow_version_id) {
    // source_revision termina em '#<versionId do n8n>'
    row = (await db.query(
      `SELECT id::text AS id FROM acc_agent_versions
        WHERE agent_id = $1::uuid AND source_revision IS NOT NULL AND right(source_revision, length($2) + 1) = '#' || $2
        ORDER BY (environment = 'production') DESC LIMIT 1`, [agentId, v.workflow_version_id])).rows[0];
  } else {
    row = (await db.query(
      `SELECT id::text AS id FROM acc_agent_versions
        WHERE agent_id = $1::uuid AND workflow_external_id = $2 AND environment = 'production' AND status = 'active' LIMIT 1`,
      [agentId, v.workflow_external_id])).rows[0];
  }
  return row ? { id: String(row.id), unresolved: false } : { id: null, unresolved: true };
}

/** Eventos de ciclo de vida derivados da run (o produtor nao precisa enviar RUN_STARTED/RUN_*). */
function lifecycleEvents(env: TelemetryEnvelope): TelemetryEventInput[] {
  const r = env.run;
  const out: TelemetryEventInput[] = [
    { type: 'RUN_STARTED', key: 'lifecycle:started', occurred_at: r.started_at, payload: { trigger_type: r.trigger_type } },
  ];
  if (r.completed_at && r.status && r.status !== 'running') {
    if (r.status === 'succeeded') {
      out.push({ type: 'RUN_SUCCEEDED', key: 'lifecycle:completed', occurred_at: r.completed_at, payload: {} });
    } else {
      out.push({
        type: 'RUN_FAILED', key: 'lifecycle:completed', occurred_at: r.completed_at,
        level: r.status === 'cancelled' ? 'warn' : 'error',
        payload: { status: r.status, ...(r.error ? { error_code: r.error.code } : {}) },
      });
    }
  }
  return out;
}

export async function ingestTelemetry(db: Queryable, env: TelemetryEnvelope): Promise<IngestResult> {
  const agentRow = (await db.query(
    `SELECT a.id::text AS id, a.organization_id::text AS org
       FROM acc_agents a JOIN acc_organizations o ON o.id = a.organization_id WHERE o.slug = $1 AND a.slug = $2`,
    [env.organization, env.agent],
  )).rows[0];
  if (!agentRow) throw new TelemetryError('AGENT_NOT_FOUND', `Agente nao cadastrado: ${env.organization}/${env.agent}`);
  const agentId = String(agentRow.id);
  const orgId = String(agentRow.org);
  const r = env.run;

  const version = await resolveVersion(db, agentId, env.version);
  const entity = env.entity ?? null;
  const leadId = entity?.lead_id ?? null;

  // sessao (uma ativa por agente+entidade)
  let sessionId: string | null = null;
  if (env.session && entity) {
    sessionId = String((await db.query(
      `INSERT INTO acc_agent_sessions (agent_id, agent_version_id, organization_id, entity_type, entity_id, lead_id, source, started_at, last_activity_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::bigint, $7, $8, $8)
       ON CONFLICT (agent_id, entity_type, entity_id) WHERE status = 'active'
       DO UPDATE SET last_activity_at = GREATEST(acc_agent_sessions.last_activity_at, EXCLUDED.last_activity_at)
       RETURNING id::text AS id`,
      [agentId, version.id, orgId, entity.type, entity.id, leadId, env.source, r.started_at],
    )).rows[0].id);
  }

  // run (idempotente por agent + run.key)
  const metadata = { ...r.metadata, ...(version.unresolved ? { version_unresolved: true } : {}) };
  const inserted = (await db.query(
    `INSERT INTO acc_agent_runs (session_id, agent_id, agent_version_id, correlation_id, run_key, trigger_type, trigger_ref, status, source,
                                 entity_type, entity_id, lead_id, model_provider, model_name, input_summary, started_at, metadata)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, 'running', $8, $9, $10, $11::bigint, $12, $13, $14, $15, $16::jsonb)
     ON CONFLICT (agent_id, run_key) WHERE run_key IS NOT NULL DO NOTHING
     RETURNING id::text AS id`,
    [sessionId, agentId, version.id, env.correlation_id, r.key, r.trigger_type, r.trigger_ref ?? null, env.source,
      entity?.type ?? null, entity?.id ?? null, leadId, r.model_provider ?? null, r.model_name ?? null,
      r.input_summary ?? null, r.started_at, JSON.stringify(metadata)],
  )).rows[0];
  const runCreated = Boolean(inserted);
  const existing = inserted
    ? { id: String(inserted.id), status: 'running' }
    : (await db.query(`SELECT id::text AS id, status FROM acc_agent_runs WHERE agent_id = $1::uuid AND run_key = $2`, [agentId, r.key])).rows[0];
  const runId = String(existing.id);
  let runStatus = String(existing.status);

  // conclusao: so transiciona uma run ainda 'running' (terminal e final; reenvio e no-op)
  if (r.completed_at && r.status && r.status !== 'running' && runStatus === 'running') {
    await db.query(
      `UPDATE acc_agent_runs
          SET status = $2, completed_at = $3, output_summary = $4, input_tokens = $5, output_tokens = $6,
              estimated_cost = $7, error_code = $8, error_message = $9,
              agent_version_id = COALESCE(agent_version_id, $10::uuid), session_id = COALESCE(session_id, $11::uuid),
              model_provider = COALESCE(model_provider, $12), model_name = COALESCE(model_name, $13)
        WHERE id = $1::uuid AND status = 'running'`,
      [runId, r.status, r.completed_at, r.output_summary ?? null, r.usage?.input_tokens ?? null, r.usage?.output_tokens ?? null,
        r.usage?.estimated_cost ?? null, r.error?.code ?? null, r.error?.message ?? null, version.id, sessionId,
        r.model_provider ?? null, r.model_name ?? null],
    );
    runStatus = r.status;
  }

  // eventos: ciclo de vida derivado + os enviados; chave deterministica => reenvio nao duplica
  const supplied = new Set(env.events.map((e) => e.type));
  const all: TelemetryEventInput[] = [
    ...lifecycleEvents(env).filter((e) => !supplied.has(e.type)),
    ...env.events,
  ];
  let eventsInserted = 0;
  let eventsDuplicate = 0;
  for (const [i, e] of all.entries()) {
    const key = `${r.key}#${e.key ?? sha(`${e.type}|${e.occurred_at.toISOString()}|${e.tool?.code ?? ''}|${i}`)}`;
    const level = e.level ?? DEFAULT_LEVEL[e.type as EventType];
    const res = await db.query(
      `INSERT INTO acc_agent_events (event_type, level, agent_id, agent_version_id, session_id, run_id, correlation_id,
                                    entity_type, entity_id, lead_id, tool_id, tool_code, integration_id, event_key, source, occurred_at, payload)
       VALUES ($1, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9, $10::bigint,
               (SELECT id FROM acc_tools WHERE code = $11), $11,
               (SELECT id FROM acc_integrations WHERE code = $12 AND organization_id = $13::uuid AND environment = 'production'),
               $14, $15, $16, $17::jsonb)
       ON CONFLICT (source, event_key) WHERE event_key IS NOT NULL DO NOTHING RETURNING id`,
      [e.type, level, agentId, version.id, sessionId, runId, env.correlation_id, entity?.type ?? null, entity?.id ?? null, leadId,
        e.tool?.code ?? null, e.integration ?? null, orgId, key, env.source, e.occurred_at, JSON.stringify(e.payload)],
    );
    if (res.rows[0]) eventsInserted++;
    else eventsDuplicate++;
  }

  return {
    agentId, versionId: version.id, versionUnresolved: version.unresolved, sessionId, runId, runCreated, runStatus,
    eventsInserted, eventsDuplicate,
  };
}

/** Encerra a sessao ativa de um agente numa entidade (idempotente). */
export async function endSession(
  db: Queryable, input: { agentId: string; entityType: string; entityId: string; reason: string },
): Promise<boolean> {
  const res = await db.query(
    `UPDATE acc_agent_sessions SET status = 'ended', ended_at = GREATEST(now(), last_activity_at), end_reason = left($4, 200)
      WHERE agent_id = $1::uuid AND entity_type = $2 AND entity_id = $3 AND status = 'active'`,
    [input.agentId, input.entityType, input.entityId, input.reason],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Expira sessoes ativas sem atividade ha mais de `idleMinutes` (para uma rotina periodica futura). */
export async function expireIdleSessions(db: Queryable, idleMinutes: number): Promise<number> {
  const res = await db.query(
    `UPDATE acc_agent_sessions SET status = 'expired', ended_at = GREATEST(now(), last_activity_at), end_reason = 'idle'
      WHERE status = 'active' AND last_activity_at < now() - make_interval(mins => $1)`,
    [Math.max(1, Math.trunc(idleMinutes))],
  );
  return res.rowCount ?? 0;
}
