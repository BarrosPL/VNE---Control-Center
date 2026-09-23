import type { Queryable, Row } from '../auth/db.ts';

// Lead 360: CORRELACIONA vne_leads_snapshot, vne_mensagens, vne_eventos_crm, vne_chat_map e
// vne_janela_meta (somente leitura). Nao copia dados. Toda consulta e delimitada por lead_id
// (indices existentes) ou paginada.

const LEAD_ID = /^\d{1,18}$/;
export const isValidLeadId = (v: string) => LEAD_ID.test(v);

const s = (v: unknown) => (v == null ? null : String(v));
const iso = (v: unknown) => (v ? new Date(String(v)).toISOString() : null);
const num = (v: unknown) => Number(v ?? 0);

export const PAGE_SIZE = 25;

export interface LeadListItem {
  leadId: string;
  name: string | null;
  pipelineId: string | null;
  statusId: string | null;
  responsibleUserId: string | null;
  price: string | null;
  totalIncoming: number;
  totalOutgoing: number;
  lastClientMessageAt: string | null;
  lastCompanyMessageAt: string | null;
  lastSeenAt: string | null;
  isDeleted: boolean;
  lastWorkflow: string | null;
}

const escapeLike = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function listLeads(
  db: Queryable,
  opts: { q?: string; page?: number },
): Promise<{ items: LeadListItem[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, Math.min(10_000, Math.trunc(opts.page ?? 1) || 1));
  const q = (opts.q ?? '').trim().slice(0, 100);
  const byId = LEAD_ID.test(q) ? q : null;
  const like = q ? `%${escapeLike(q)}%` : null;
  const where = `($1::text IS NULL AND $2::text IS NULL)
        OR ($1::text IS NOT NULL AND l.lead_id = $1::bigint)
        OR ($2::text IS NOT NULL AND (l.lead_name ILIKE $2 OR j.contact_name ILIKE $2))`;
  const params = [byId, like];
  const [rows, total] = await Promise.all([
    db.query(
      `SELECT l.lead_id, COALESCE(l.lead_name, j.contact_name) AS name, l.pipeline_id, l.status_id,
              l.responsible_user_id, l.price, l.total_incoming, l.total_outgoing,
              l.last_message_client_at, l.last_message_company_at, l.last_seen_at, l.is_deleted,
              j.ultimo_workflow
         FROM vne_leads_snapshot l LEFT JOIN vne_janela_meta j ON j.lead_id = l.lead_id
        WHERE ${where}
        ORDER BY l.last_seen_at DESC NULLS LAST, l.lead_id DESC
        LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
      params,
    ),
    db.query(
      `SELECT count(*)::int AS n FROM vne_leads_snapshot l LEFT JOIN vne_janela_meta j ON j.lead_id = l.lead_id WHERE ${where}`,
      params,
    ),
  ]);
  return {
    items: rows.rows.map((r: Row) => ({
      leadId: String(r.lead_id), name: s(r.name), pipelineId: s(r.pipeline_id), statusId: s(r.status_id),
      responsibleUserId: s(r.responsible_user_id), price: s(r.price), totalIncoming: num(r.total_incoming),
      totalOutgoing: num(r.total_outgoing), lastClientMessageAt: iso(r.last_message_client_at),
      lastCompanyMessageAt: iso(r.last_message_company_at), lastSeenAt: iso(r.last_seen_at),
      isDeleted: Boolean(r.is_deleted), lastWorkflow: s(r.ultimo_workflow),
    })),
    total: num(total.rows[0].n),
    page,
    pageSize: PAGE_SIZE,
  };
}

export interface LeadHeader {
  leadId: string;
  name: string | null;
  contactId: string | null;
  inSnapshot: boolean;
  pipelineId: string | null;
  statusId: string | null;
  responsibleUserId: string | null;
  price: string | null;
  isDeleted: boolean;
  deletedAt: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  lastStatusChangeAt: string | null;
  lastResponsibleChangeAt: string | null;
  totalIncoming: number;
  totalOutgoing: number;
  lastClientMessageAt: string | null;
  lastCompanyMessageAt: string | null;
  lastWorkflow: string | null;
  channels: string[];
  talks: number;
}

export async function getLeadHeader(db: Queryable, leadId: string): Promise<LeadHeader | null> {
  if (!LEAD_ID.test(leadId)) return null;
  const [snap, jan, chats, msgs] = await Promise.all([
    db.query('SELECT * FROM vne_leads_snapshot WHERE lead_id = $1::bigint', [leadId]),
    db.query('SELECT * FROM vne_janela_meta WHERE lead_id = $1::bigint', [leadId]),
    db.query(
      `SELECT count(*)::int AS talks, COALESCE(array_agg(DISTINCT origin) FILTER (WHERE origin IS NOT NULL), '{}') AS origins
         FROM vne_chat_map WHERE lead_id = $1::bigint`,
      [leadId],
    ),
    db.query('SELECT count(*)::int AS n FROM vne_mensagens WHERE lead_id = $1::bigint', [leadId]),
  ]);
  const l = snap.rows[0];
  const j = jan.rows[0];
  // o lead "existe" se aparece em qualquer fonte
  if (!l && !j && num(msgs.rows[0].n) === 0 && num(chats.rows[0].talks) === 0) return null;
  const origins = new Set<string>((chats.rows[0].origins as string[]) ?? []);
  if (j?.origin) origins.add(String(j.origin));
  return {
    leadId,
    name: s(l?.lead_name) ?? s(j?.contact_name),
    contactId: s(j?.contact_id),
    inSnapshot: Boolean(l),
    pipelineId: s(l?.pipeline_id), statusId: s(l?.status_id), responsibleUserId: s(l?.responsible_user_id),
    price: s(l?.price), isDeleted: Boolean(l?.is_deleted), deletedAt: iso(l?.deleted_at),
    firstSeenAt: iso(l?.first_seen_at), lastSeenAt: iso(l?.last_seen_at),
    lastStatusChangeAt: iso(l?.last_status_change_at), lastResponsibleChangeAt: iso(l?.last_responsible_change_at),
    totalIncoming: num(l?.total_incoming), totalOutgoing: num(l?.total_outgoing),
    // "ultima mensagem do cliente": a fonte da janela (vne_janela_meta) e a mais atualizada
    lastClientMessageAt: iso(j?.ultima_mensagem_cliente_em) ?? iso(l?.last_message_client_at),
    lastCompanyMessageAt: iso(l?.last_message_company_at),
    lastWorkflow: s(j?.ultimo_workflow),
    channels: [...origins].sort(),
    talks: num(chats.rows[0].talks),
  };
}

/** Limite invalido (NaN, <= 0, nao numerico) => padrao; acima do maximo => maximo. */
export function normalizeLimit(v: unknown): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n < 1) return TIMELINE_DEFAULT_LIMIT;
  return Math.min(TIMELINE_MAX_LIMIT, n);
}

export type TimelineView = 'all' | 'messages' | 'events';
export const isTimelineView = (v: unknown): v is TimelineView => v === 'all' || v === 'messages' || v === 'events';
export const TIMELINE_DEFAULT_LIMIT = 50;
export const TIMELINE_MAX_LIMIT = 500;

export interface MessageItem {
  kind: 'message';
  ref: string;
  at: string | null;
  direction: string;
  authorClass: string | null;
  authorName: string | null;
  text: string | null; // null quando o usuario nao tem conversations:read
  contentRestricted: boolean;
  messageType: string | null;
  attachmentType: string | null;
  attachmentName: string | null;
  origin: string | null;
  isAutomated: boolean | null;
}
export interface EventItem {
  kind: 'event';
  ref: string;
  at: string | null;
  eventType: string;
  entityType: string;
  pipelineId: string | null;
  statusId: string | null;
  previousPipelineId: string | null;
  previousStatusId: string | null;
  responsibleUserId: string | null;
  taskText: string | null; // restrito como conteudo
  taskStatus: number | null;
  talkId: string | null;
}
export type TimelineItem = MessageItem | EventItem;

/**
 * Timeline unificada (mensagens + eventos CRM), do mais recente ao mais antigo.
 * `includeContent=false` => texto/anexos/tarefas NAO saem do banco (menor privilegio).
 * O payload bruto dos eventos nunca e selecionado.
 */
export async function getTimeline(
  db: Queryable,
  leadId: string,
  opts: { view?: TimelineView; limit?: number; includeContent: boolean },
): Promise<{ items: TimelineItem[]; hasMore: boolean; limit: number }> {
  if (!LEAD_ID.test(leadId)) return { items: [], hasMore: false, limit: 0 };
  const view = opts.view ?? 'all';
  const limit = normalizeLimit(opts.limit);
  const parts: string[] = [];
  if (view !== 'events') {
    parts.push(`SELECT 'message'::text AS kind, m.id::text AS ref, COALESCE(m.created_at_kommo, m.received_at) AS ts,
        m.direcao AS a, m.autor_classificacao AS b, m.author_name AS c,
        CASE WHEN $3 THEN m.texto END AS d, m.message_type AS e, m.attachment_type AS f,
        CASE WHEN $3 THEN m.attachment_file_name END AS g, m.origin AS h,
        m.is_automated AS auto, NULL::text AS i, NULL::text AS j, NULL::text AS k, NULL::text AS l,
        NULL::text AS m2, NULL::text AS n2, NULL::text AS o
       FROM vne_mensagens m WHERE m.lead_id = $1::bigint`);
  }
  if (view !== 'messages') {
    parts.push(`SELECT 'event'::text AS kind, e.id::text AS ref, COALESCE(e.occurred_at, e.received_at) AS ts,
        e.event_type AS a, e.entity_type AS b, NULL::text AS c,
        CASE WHEN $3 THEN e.task_text END AS d, NULL::text AS e, NULL::text AS f, NULL::text AS g, NULL::text AS h,
        NULL::boolean AS auto, e.pipeline_id::text AS i, e.status_id::text AS j,
        e.previous_pipeline_id::text AS k, e.previous_status_id::text AS l,
        e.responsible_user_id::text AS m2, e.task_status::text AS n2, e.talk_id AS o
       FROM vne_eventos_crm e WHERE e.lead_id = $1::bigint`);
  }
  const { rows } = await db.query(
    `SELECT * FROM (${parts.join(' UNION ALL ')}) t ORDER BY ts DESC NULLS LAST, ref DESC LIMIT $2`,
    [leadId, limit + 1, opts.includeContent],
  );
  const items: TimelineItem[] = rows.slice(0, limit).map((r: Row): TimelineItem =>
    r.kind === 'message'
      ? {
          kind: 'message', ref: String(r.ref), at: iso(r.ts), direction: String(r.a), authorClass: s(r.b),
          authorName: s(r.c), text: opts.includeContent ? s(r.d) : null, contentRestricted: !opts.includeContent,
          messageType: s(r.e), attachmentType: s(r.f), attachmentName: opts.includeContent ? s(r.g) : null,
          origin: s(r.h), isAutomated: r.auto == null ? null : Boolean(r.auto),
        }
      : {
          kind: 'event', ref: String(r.ref), at: iso(r.ts), eventType: String(r.a), entityType: String(r.b),
          taskText: opts.includeContent ? s(r.d) : null, pipelineId: s(r.i), statusId: s(r.j),
          previousPipelineId: s(r.k), previousStatusId: s(r.l), responsibleUserId: s(r.m2),
          taskStatus: r.n2 == null ? null : Number(r.n2), talkId: s(r.o),
        },
  );
  return { items, hasMore: rows.length > limit, limit };
}

/** Agente cadastrado cujo slug coincide com vne_janela_meta.ultimo_workflow (vinculo por dado). */
export async function findAgentBySlug(db: Queryable, slug: string | null): Promise<{ id: string; name: string } | null> {
  if (!slug) return null;
  const { rows } = await db.query(`SELECT id::text AS id, name FROM acc_agents WHERE slug = $1 LIMIT 1`, [slug]);
  return rows[0] ? { id: String(rows[0].id), name: String(rows[0].name) } : null;
}
