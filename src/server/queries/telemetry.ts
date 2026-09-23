import type { Queryable, Row } from '../auth/db.ts';

// Filtros vem de parametros de URL: SEMPRE validados antes de chegar ao SQL (entrada invalida = filtro
// ignorado, nunca um erro 500 do banco).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEAD_RE = /^\d{1,18}$/;
const uuidOrNull = (v: string | undefined | null) => (v && UUID_RE.test(v) ? v : null);
const leadOrNull = (v: string | undefined | null) => (v && LEAD_RE.test(v) ? v : null);

const s = (v: unknown) => (v == null ? null : String(v));
const num = (v: unknown) => Number(v ?? 0);
const iso = (v: unknown) => (v ? new Date(String(v)).toISOString() : null);

export interface TelemetryOverview {
  /** existe alguma telemetria (real ou sintetica)? Sem isso as metricas sao "indisponiveis", nunca zero. */
  hasData: boolean;
  /** toda a telemetria existente e sintetica (fixtures/testes) */
  onlySynthetic: boolean;
  activeSessions: number;
  runs24h: number;
  failedRuns24h: number;
  runningRuns: number;
  errorEvents24h: number;
  lastEventAt: string | null;
}

export async function getTelemetryOverview(db: Queryable): Promise<TelemetryOverview> {
  const { rows } = await db.query(
    `SELECT
       (SELECT count(*) FROM acc_agent_events)::int AS events_total,
       (SELECT count(*) FROM acc_agent_runs)::int AS runs_total,
       (SELECT count(*) FROM acc_agent_runs WHERE source <> 'synthetic')::int AS runs_real,
       (SELECT count(*) FROM acc_agent_events WHERE source <> 'synthetic')::int AS events_real,
       (SELECT count(*) FROM acc_agent_sessions WHERE status = 'active')::int AS sessions,
       (SELECT count(*) FROM acc_agent_runs WHERE started_at > now() - interval '24 hours')::int AS runs24,
       (SELECT count(*) FROM acc_agent_runs WHERE started_at > now() - interval '24 hours' AND status IN ('failed','timed_out'))::int AS failed24,
       (SELECT count(*) FROM acc_agent_runs WHERE status = 'running')::int AS running,
       (SELECT count(*) FROM acc_agent_events WHERE level = 'error' AND occurred_at > now() - interval '24 hours')::int AS errors24,
       (SELECT max(occurred_at) FROM acc_agent_events) AS last_event`,
  );
  const r = rows[0];
  const hasData = num(r.events_total) + num(r.runs_total) > 0;
  return {
    hasData,
    onlySynthetic: hasData && num(r.events_real) + num(r.runs_real) === 0,
    activeSessions: num(r.sessions), runs24h: num(r.runs24), failedRuns24h: num(r.failed24), runningRuns: num(r.running),
    errorEvents24h: num(r.errors24), lastEventAt: iso(r.last_event),
  };
}

export interface RunItem {
  id: string;
  agentId: string;
  agentName: string;
  versionLabel: string | null;
  status: string;
  triggerType: string;
  source: string;
  entityType: string | null;
  entityId: string | null;
  leadId: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  modelName: string | null;
  errorCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  correlationId: string;
  synthetic: boolean;
}

export async function listRuns(db: Queryable, opts: { agentId?: string; leadId?: string; limit?: number }): Promise<RunItem[]> {
  const limit = Math.max(1, Math.min(200, Math.trunc(opts.limit ?? 25)));
  const { rows } = await db.query(
    `SELECT r.*, a.name AS agent_name, v.version AS version_label
       FROM acc_agent_runs r JOIN acc_agents a ON a.id = r.agent_id LEFT JOIN acc_agent_versions v ON v.id = r.agent_version_id
      WHERE ($1::uuid IS NULL OR r.agent_id = $1::uuid) AND ($2::bigint IS NULL OR r.lead_id = $2::bigint)
      ORDER BY r.started_at DESC, r.id DESC LIMIT $3`,
    [uuidOrNull(opts.agentId), leadOrNull(opts.leadId), limit],
  );
  return rows.map((r: Row): RunItem => ({
    id: String(r.id), agentId: String(r.agent_id), agentName: String(r.agent_name), versionLabel: s(r.version_label),
    status: String(r.status), triggerType: String(r.trigger_type), source: String(r.source),
    entityType: s(r.entity_type), entityId: s(r.entity_id), leadId: s(r.lead_id),
    startedAt: iso(r.started_at)!, completedAt: iso(r.completed_at), durationMs: r.duration_ms == null ? null : num(r.duration_ms),
    modelName: s(r.model_name), errorCode: s(r.error_code),
    inputTokens: r.input_tokens == null ? null : num(r.input_tokens), outputTokens: r.output_tokens == null ? null : num(r.output_tokens),
    correlationId: String(r.correlation_id), synthetic: r.source === 'synthetic',
  }));
}

export interface SessionItem {
  id: string;
  agentId: string;
  agentName: string;
  entityType: string;
  entityId: string;
  leadId: string | null;
  status: string;
  startedAt: string;
  lastActivityAt: string;
  synthetic: boolean;
}

export async function listSessions(db: Queryable, opts: { agentId?: string; onlyActive?: boolean; limit?: number }): Promise<SessionItem[]> {
  const limit = Math.max(1, Math.min(200, Math.trunc(opts.limit ?? 25)));
  const { rows } = await db.query(
    `SELECT s.*, a.name AS agent_name FROM acc_agent_sessions s JOIN acc_agents a ON a.id = s.agent_id
      WHERE ($1::uuid IS NULL OR s.agent_id = $1::uuid) AND (NOT $2::boolean OR s.status = 'active')
      ORDER BY s.last_activity_at DESC, s.id DESC LIMIT $3`,
    [uuidOrNull(opts.agentId), opts.onlyActive ?? false, limit],
  );
  return rows.map((r: Row): SessionItem => ({
    id: String(r.id), agentId: String(r.agent_id), agentName: String(r.agent_name), entityType: String(r.entity_type),
    entityId: String(r.entity_id), leadId: s(r.lead_id), status: String(r.status),
    startedAt: iso(r.started_at)!, lastActivityAt: iso(r.last_activity_at)!, synthetic: r.source === 'synthetic',
  }));
}

export interface EventItem {
  id: string;
  seq: string;
  eventType: string;
  level: string;
  occurredAt: string;
  agentId: string | null;
  agentName: string | null;
  runId: string | null;
  sessionId: string | null;
  entityType: string | null;
  entityId: string | null;
  leadId: string | null;
  toolCode: string | null;
  source: string;
  synthetic: boolean;
  correlationId: string | null;
  /** cursor de paginacao com precisao de MICROssegundos (timestamptz do Postgres); nunca reconstruir a partir de Date */
  cursor: { occurredAt: string; seq: string };
}

export interface EventFilter {
  agentId?: string;
  leadId?: string;
  eventType?: string;
  level?: string;
  runId?: string;
  limit?: number;
  /** cursor: itens estritamente ANTERIORES a (occurredAt, seq) */
  before?: { occurredAt: string; seq: string };
}

const CURSOR_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const EVENT_TYPE = /^[A-Z][A-Z0-9_]{2,63}$/;

/** Eventos mais recentes primeiro; paginacao por cursor (occurred_at, seq). Filtros invalidos sao ignorados. */
export async function listEvents(db: Queryable, f: EventFilter): Promise<{ items: EventItem[]; hasMore: boolean }> {
  const limit = Math.max(1, Math.min(200, Math.trunc(f.limit ?? 50)));
  const agentId = uuidOrNull(f.agentId);
  const runId = uuidOrNull(f.runId);
  const leadId = leadOrNull(f.leadId);
  const eventType = f.eventType && EVENT_TYPE.test(f.eventType) ? f.eventType : null;
  const level = f.level === 'info' || f.level === 'warn' || f.level === 'error' ? f.level : null;
  const before = f.before && /^\d+$/.test(f.before.seq) && CURSOR_TS.test(f.before.occurredAt) ? f.before : null;
  const { rows } = await db.query(
    `SELECT e.id, e.seq, e.event_type, e.level, e.occurred_at,
            to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at_us, e.agent_id, a.name AS agent_name, e.run_id, e.session_id,
            e.entity_type, e.entity_id, e.lead_id, e.tool_code, e.source, e.correlation_id
       FROM acc_agent_events e LEFT JOIN acc_agents a ON a.id = e.agent_id
      WHERE ($1::uuid IS NULL OR e.agent_id = $1::uuid) AND ($2::bigint IS NULL OR e.lead_id = $2::bigint)
        AND ($3::text IS NULL OR e.event_type = $3) AND ($4::text IS NULL OR e.level = $4) AND ($5::uuid IS NULL OR e.run_id = $5::uuid)
        AND ($6::timestamptz IS NULL OR (e.occurred_at, e.seq) < ($6::timestamptz, $7::bigint))
      ORDER BY e.occurred_at DESC, e.seq DESC LIMIT $8`,
    [agentId, leadId, eventType, level, runId, before?.occurredAt ?? null, before?.seq ?? null, limit + 1],
  );
  const items = rows.slice(0, limit).map((r: Row): EventItem => ({
    id: String(r.id), seq: String(r.seq), eventType: String(r.event_type), level: String(r.level), occurredAt: iso(r.occurred_at)!,
    agentId: s(r.agent_id), agentName: s(r.agent_name), runId: s(r.run_id), sessionId: s(r.session_id),
    entityType: s(r.entity_type), entityId: s(r.entity_id), leadId: s(r.lead_id), toolCode: s(r.tool_code),
    source: String(r.source), synthetic: r.source === 'synthetic', correlationId: s(r.correlation_id),
    cursor: { occurredAt: String(r.occurred_at_us), seq: String(r.seq) },
  }));
  return { items, hasMore: rows.length > limit };
}

export async function listEventTypes(db: Queryable): Promise<{ code: string; category: string; description: string }[]> {
  const { rows } = await db.query('SELECT code, category, description FROM acc_event_types ORDER BY category, code');
  return rows.map((r) => ({ code: String(r.code), category: String(r.category), description: String(r.description) }));
}
