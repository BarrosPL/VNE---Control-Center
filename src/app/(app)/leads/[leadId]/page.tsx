import Link from 'next/link';
import { notFound } from 'next/navigation';
import { EntityName } from '../../../../components/entity-name.tsx';
import { Timeline } from '../../../../components/timeline.tsx';
import { EventsTable } from '../../../../components/telemetry-tables.tsx';
import { Badge, Card, EmptyState, Forbidden, PageHeader, Stat, StatUnavailable } from '../../../../components/ui.tsx';
import { KIND, LEAD_DATA_INTEGRATION } from '../../../../domain/data-sources.ts';
import { channelLabel, formatDateTime, relativeAge } from '../../../../domain/labels.ts';
import { can } from '../../../../domain/rbac.ts';
import { recordEntityView } from '../../../../server/auth/audit.ts';
import { resolveEntities, type EntityRef } from '../../../../server/catalog/resolver.ts';
import { getDb } from '../../../../server/db.ts';
import { checkPermission } from '../../../../server/guards.ts';
import {
  TIMELINE_MAX_LIMIT, findAgentBySlug, getLeadHeader, getTimeline, isTimelineView, normalizeLimit,
} from '../../../../server/queries/leads.ts';
import { listEvents } from '../../../../server/queries/telemetry.ts';

export const dynamic = 'force-dynamic';

const WINDOW_HOURS = 24;

export default async function Lead360Page({
  params,
  searchParams,
}: {
  params: Promise<{ leadId: string }>;
  searchParams: Promise<{ view?: string; limit?: string }>;
}) {
  const { user, allowed } = await checkPermission('entities:read');
  if (!allowed) return <Forbidden permission="entities:read" />;
  const { leadId } = await params;
  const sp = await searchParams;
  const db = getDb();
  const header = await getLeadHeader(db, leadId);
  if (!header) notFound();

  const view = isTimelineView(sp.view) ? sp.view : 'all';
  const limit = normalizeLimit(sp.limit);
  const includeContent = can(user.role, 'conversations:read');
  const [timeline, agent, agentEvents] = await Promise.all([
    getTimeline(db, leadId, { view, limit, includeContent }),
    findAgentBySlug(db, header.lastWorkflow),
    listEvents(db, { leadId, limit: 10 }).catch(() => null), // opcional: null = telemetria indisponivel
  ]);
  // nomes de pipeline/etapa/usuario via catalogo generico (uma consulta em lote)
  const refs: EntityRef[] = [
    { kind: KIND.pipeline, id: header.pipelineId }, { kind: KIND.status, id: header.statusId },
    { kind: KIND.user, id: header.responsibleUserId },
    ...timeline.items.flatMap((it): EntityRef[] => it.kind === 'event'
      ? [{ kind: KIND.pipeline, id: it.pipelineId }, { kind: KIND.status, id: it.statusId },
         { kind: KIND.pipeline, id: it.previousPipelineId }, { kind: KIND.status, id: it.previousStatusId },
         { kind: KIND.user, id: it.responsibleUserId }]
      : []),
  ];
  const catalog = await resolveEntities(db, LEAD_DATA_INTEGRATION, refs);
  // dados pessoais exibidos => trilha de auditoria (deduplicada em 10 min)
  if (includeContent) {
    await recordEntityView(db, { actorId: user.id, entityType: 'lead', entityId: leadId, reason: 'lead_360' });
  }

  const sinceClientH = header.lastClientMessageAt
    ? (Date.now() - new Date(header.lastClientMessageAt).getTime()) / 3_600_000
    : null;
  const windowOpen = sinceClientH !== null && sinceClientH < WINDOW_HOURS;
  const tab = (v: string, label: string) => (
    <Link
      href={`/leads/${leadId}?view=${v}`}
      aria-current={view === v ? 'page' : undefined}
      className={`rounded-md px-3 py-1.5 text-sm ${view === v ? 'bg-neutral-900 text-white' : 'border border-neutral-300 text-neutral-700 hover:bg-neutral-100'}`}
    >
      {label}
    </Link>
  );

  return (
    <>
      <p className="mb-2 text-sm"><Link href="/leads" className="text-sky-700 underline">← Leads</Link></p>
      <PageHeader
        title={header.name ?? `Lead ${header.leadId}`}
        subtitle={<>Lead Kommo #{header.leadId}{header.contactId && <> · contato #{header.contactId}</>}</>}
        actions={
          <div className="flex gap-2">
            {header.isDeleted && <Badge tone="danger">Excluído no Kommo</Badge>}
            {!header.inSnapshot && <Badge tone="warn" title="Só há mensagens/eventos; sem snapshot do CRM">Sem snapshot CRM</Badge>}
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Pipeline / etapa"
          value={header.pipelineId || header.statusId
            ? <span className="text-lg"><EntityName map={catalog} kind={KIND.pipeline} id={header.pipelineId} /> / <EntityName map={catalog} kind={KIND.status} id={header.statusId} /></span>
            : <span className="text-lg text-amber-700">Não sincronizado</span>}
          hint={header.pipelineId || header.statusId ? `IDs do Kommo: ${header.pipelineId ?? '—'} / ${header.statusId ?? '—'}` : 'Ainda não há evento CRM registrado para este lead'} />
        <Stat label="Responsável (usuário Kommo)" value={<span className="text-lg"><EntityName map={catalog} kind={KIND.user} id={header.responsibleUserId} /></span>}
          hint={header.lastResponsibleChangeAt ? `alterado ${relativeAge(header.lastResponsibleChangeAt)}` : undefined} />
        <Stat label="Mensagens (↓ cliente / ↑ empresa)" value={`${header.totalIncoming} / ${header.totalOutgoing}`}
          hint={header.channels.length ? header.channels.map(channelLabel).join(' · ') : 'canal n/d'} />
        <Stat label="Preço do lead no Kommo"
          value={header.price && Number(header.price) > 0 ? Number(header.price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : <span className="text-lg text-neutral-500">Não informado</span>}
          hint="Campo padrão price do lead; não é necessariamente o Valor Apresentado" />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Janela de resposta (24h)">
          {header.lastClientMessageAt ? (
            <>
              <p className="text-sm">
                Última mensagem do cliente: <strong>{formatDateTime(header.lastClientMessageAt)}</strong>{' '}
                <span className="text-neutral-500">({relativeAge(header.lastClientMessageAt)})</span>
              </p>
              <p className="mt-2"><Badge tone={windowOpen ? 'ok' : 'warn'}>{windowOpen ? 'Dentro de 24h' : 'Fora de 24h'}</Badge></p>
              <p className="mt-2 text-xs text-neutral-500">Calculado a partir da última mensagem do cliente; regra de 24h do WhatsApp (derivado).</p>
            </>
          ) : <p className="text-sm text-neutral-600">Sem mensagem do cliente registrada.</p>}
        </Card>
        <Card title="Último workflow registrado">
          {header.lastWorkflow ? (
            <div className="text-sm">
              <strong>{header.lastWorkflow}</strong>
              <p className="mt-2 text-xs text-neutral-500">
                Fonte: vne_janela_meta.ultimo_workflow. Informativo: é o último workflow que atualizou a janela de
                conversa e <strong>não comprova</strong> qual agente enviou a última mensagem. A autoria por agente
                depende da telemetria (acc_agent_events), ainda não ativa.
              </p>
              {agent && (
                <p className="mt-1 text-xs text-neutral-500">
                  O identificador coincide com o agente cadastrado{' '}
                  <Link href={`/agents/${agent.id}`} className="text-sky-800 underline">{agent.name}</Link> (correlação por nome).
                </p>
              )}
            </div>
          ) : <p className="text-sm text-neutral-600">Sem registro.</p>}
        </Card>
        <Card title="Atividade">
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between"><dt className="text-neutral-600">Visto pela 1ª vez</dt><dd>{formatDateTime(header.firstSeenAt)}</dd></div>
            <div className="flex justify-between"><dt className="text-neutral-600">Última atividade</dt><dd>{formatDateTime(header.lastSeenAt)}</dd></div>
            <div className="flex justify-between"><dt className="text-neutral-600">Última mudança de etapa</dt><dd>{formatDateTime(header.lastStatusChangeAt)}</dd></div>
            <div className="flex justify-between"><dt className="text-neutral-600">Conversas (talks)</dt><dd>{header.talks}</dd></div>
          </dl>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <StatUnavailable label="Controle IA / humano" phase="Fase 6 (controles operacionais)" />
        {agentEvents === null && <StatUnavailable label="Timeline dos agentes" phase="Fase 4B (telemetria conectada)" />}
      </div>

      {agentEvents !== null && (
        <div className="mt-4">
          <Card title="Timeline dos agentes (telemetria)">
            {agentEvents.items.length === 0
              ? <p className="text-sm text-neutral-600">Nenhum evento de agente registrado para este lead. A autoria por agente só existe com telemetria coletada.</p>
              : <EventsTable events={agentEvents.items} />}
          </Card>
        </div>
      )}

      <div className="mb-3 mt-8 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Linha do tempo</h2>
        <div className="flex gap-2" role="group" aria-label="Filtro da linha do tempo">
          {tab('all', 'Tudo')}{tab('messages', 'Conversa')}{tab('events', 'Eventos CRM')}
        </div>
      </div>
      {!includeContent && (
        <p role="note" className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          O conteúdo das mensagens é restrito ao seu perfil. Você vê apenas quem, quando e por qual canal.
        </p>
      )}
      {timeline.items.length === 0 ? (
        <EmptyState title="Sem registros nesta visão" />
      ) : (
        <>
          <Timeline items={timeline.items} catalog={catalog} />
          {timeline.hasMore && (
            <p className="mt-4 text-center text-sm">
              <Link href={`/leads/${leadId}?view=${view}&limit=${Math.min(TIMELINE_MAX_LIMIT, limit + 100)}`} className="text-sky-700 underline">
                Ver registros mais antigos
              </Link>
            </p>
          )}
        </>
      )}
      <p className="mt-6 text-xs text-neutral-500">
        Fontes (somente leitura): vne_leads_snapshot, vne_mensagens, vne_eventos_crm, vne_chat_map, vne_janela_meta. Horários em America/Sao_Paulo.
      </p>
    </>
  );
}
