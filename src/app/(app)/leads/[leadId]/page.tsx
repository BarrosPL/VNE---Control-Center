import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Timeline } from '../../../../components/timeline.tsx';
import { Badge, Card, EmptyState, Forbidden, PageHeader, Stat, StatUnavailable } from '../../../../components/ui.tsx';
import { channelLabel, formatDateTime, relativeAge } from '../../../../domain/labels.ts';
import { can } from '../../../../domain/rbac.ts';
import { recordEntityView } from '../../../../server/auth/audit.ts';
import { getDb } from '../../../../server/db.ts';
import { checkPermission } from '../../../../server/guards.ts';
import {
  TIMELINE_MAX_LIMIT, findAgentBySlug, getLeadHeader, getTimeline, isTimelineView, normalizeLimit,
} from '../../../../server/queries/leads.ts';

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
  const [timeline, agent] = await Promise.all([
    getTimeline(db, leadId, { view, limit, includeContent }),
    findAgentBySlug(db, header.lastWorkflow),
  ]);
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
        <Stat label="Pipeline / etapa" value={header.pipelineId || header.statusId ? `${header.pipelineId ?? '—'} / ${header.statusId ?? '—'}` : '—'}
          hint="IDs do Kommo (nomes: pendente de mapeamento)" />
        <Stat label="Responsável (usuário Kommo)" value={header.responsibleUserId ?? '—'}
          hint={header.lastResponsibleChangeAt ? `alterado ${relativeAge(header.lastResponsibleChangeAt)}` : undefined} />
        <Stat label="Mensagens (↓ cliente / ↑ empresa)" value={`${header.totalIncoming} / ${header.totalOutgoing}`}
          hint={header.channels.length ? header.channels.map(channelLabel).join(' · ') : 'canal n/d'} />
        <Stat label="Valor" value={header.price && Number(header.price) > 0 ? Number(header.price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '—'} />
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
        <Card title="Último agente que atuou">
          {header.lastWorkflow ? (
            <p className="text-sm">
              {agent ? <Link href={`/agents/${agent.id}`} className="font-medium text-sky-800 underline">{agent.name}</Link> : <strong>{header.lastWorkflow}</strong>}
              {!agent && <span className="text-neutral-500"> (não cadastrado como agente)</span>}
              <span className="block text-xs text-neutral-500">Fonte: vne_janela_meta.ultimo_workflow (informativo).</span>
            </p>
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
        <StatUnavailable label="Timeline dos agentes e solicitações internas" phase="Fase 4/5 (observabilidade e human-in-the-loop)" />
      </div>

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
          <Timeline items={timeline.items} />
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
