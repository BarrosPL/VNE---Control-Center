import Link from 'next/link';
import { Badge, Card, Forbidden, InformationalNotice, PageHeader, Stat, StatUnavailable } from '../../components/ui.tsx';
import { MODE_LABEL, formatDateTime, relativeAge } from '../../domain/labels.ts';
import { getDb } from '../../server/db.ts';
import { checkPermission } from '../../server/guards.ts';
import { getOverview } from '../../server/queries/overview.ts';
import { getTelemetryOverview } from '../../server/queries/telemetry.ts';

export const dynamic = 'force-dynamic';

export default async function CommandCenter() {
  const { allowed } = await checkPermission('dashboard:read');
  if (!allowed) return <Forbidden permission="dashboard:read" />;
  const db = getDb();
  const o = await getOverview(db);
  // telemetria e opcional: se as tabelas ainda nao existem (migration pendente), fica "indisponivel", nunca zero
  const tele = await getTelemetryOverview(db).catch(() => null);
  const modes = Object.keys(MODE_LABEL);
  const notActive = o.agents.total - (o.agents.byMode.active ?? 0);
  const degradedIntegrations = (o.integrations.byStatus.degraded ?? 0) + (o.integrations.byStatus.disabled ?? 0);

  return (
    <>
      <PageHeader title="Command Center" subtitle="Saúde do ecossistema de agentes em segundos." />
      <InformationalNotice />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Agentes ativos" value={`${o.agents.byMode.active ?? 0} de ${o.agents.total}`}
          hint={notActive > 0 ? `${notActive} fora do modo ativo` : 'Todos em modo ativo'} tone={notActive > 0 ? 'warn' : undefined} />
        <Stat label="Integrações" value={o.integrations.total}
          hint={degradedIntegrations > 0 ? `${degradedIntegrations} degradada(s)/desabilitada(s)` : 'Todas ativas'}
          tone={degradedIntegrations > 0 ? 'warn' : undefined} />
        <Stat label="Tools mutáveis" value={`${o.registry.mutableTools} de ${o.registry.tools}`}
          hint="Escrevem em sistemas externos" />
        <Stat label="Agentes com alertas" value={o.agents.withWarnings}
          hint={o.agents.withWarnings > 0 ? 'Tools presentes com avisos de revisão' : 'Sem avisos'}
          tone={o.agents.withWarnings > 0 ? 'warn' : undefined} />
      </div>

      {tele?.hasData ? (
        <>
          {tele.onlySynthetic && (
            <p role="note" className="mt-4 rounded-md border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-900">
              Telemetria <strong>sintética</strong> (demonstração): não vem de execuções reais dos agentes.
            </p>
          )}
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Sessões ativas" value={tele.activeSessions} hint="Agente ↔ entidade em andamento" />
            <Stat label="Execuções (24h)" value={tele.runs24h}
              hint={tele.runningRuns > 0 ? `${tele.runningRuns} em andamento` : 'Nenhuma em andamento'} />
            <Stat label="Execuções com falha (24h)" value={tele.failedRuns24h}
              tone={tele.failedRuns24h > 0 ? 'danger' : undefined}
              hint={tele.runs24h > 0 ? `${Math.round((tele.failedRuns24h / tele.runs24h) * 100)}% das execuções` : undefined} />
            <Stat label="Eventos de erro (24h)" value={tele.errorEvents24h}
              tone={tele.errorEvents24h > 0 ? 'warn' : undefined}
              hint={tele.lastEventAt ? `último evento ${relativeAge(tele.lastEventAt)}` : undefined} />
          </div>
          <p className="mt-2 text-xs text-neutral-500">
            <Link href="/live" className="text-sky-700 underline">Ver operação ao vivo</Link>
          </p>
        </>
      ) : (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatUnavailable label="Sessões ativas" phase="telemetria (Fase 4B: coleta conectada)" />
          <StatUnavailable label="Execuções (24h)" phase="telemetria (Fase 4B: coleta conectada)" />
          <StatUnavailable label="Requests humanos pendentes" phase="Fase 5 (human-in-the-loop)" />
          <StatUnavailable label="Incidentes abertos" phase="Fase 8 (incidentes e saúde)" />
        </div>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card title="Agentes por modo operacional">
          {o.agents.total === 0 ? (
            <p className="text-sm text-neutral-600">Nenhum agente cadastrado.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {modes.map((m) => (
                <li key={m} className="flex justify-between">
                  <span>{MODE_LABEL[m].label}</span>
                  <span className="font-medium">{o.agents.byMode[m] ?? 0}</span>
                </li>
              ))}
            </ul>
          )}
          <Link href="/agents" className="mt-3 inline-block text-sm text-sky-700 underline">Ver agentes</Link>
        </Card>

        <Card title="Dados operacionais (leitura de vne_*)">
          {o.dataPlane ? (
            <dl className="space-y-1 text-sm">
              <Row k="Mensagens (24h)" v={o.dataPlane.messages24h} />
              <Row k="Eventos CRM (24h)" v={o.dataPlane.crmEvents24h} />
              <Row k="Leads acompanhados" v={o.dataPlane.leadsTracked} />
              <Row k="Última mensagem" v={`${formatDateTime(o.dataPlane.lastMessageAt)} (${relativeAge(o.dataPlane.lastMessageAt)})`} />
              <Row k="Último evento CRM" v={`${formatDateTime(o.dataPlane.lastCrmEventAt)} (${relativeAge(o.dataPlane.lastCrmEventAt)})`} />
            </dl>
          ) : (
            <p className="text-sm text-neutral-600">Indisponível no momento (fonte de dados não respondeu).</p>
          )}
          <p className="mt-3 text-xs text-neutral-500">Fonte: PostgreSQL, tabelas vne_mensagens, vne_eventos_crm, vne_leads_snapshot.</p>
          {tele && !tele.hasData && <p className="mt-1"><Badge tone="neutral">Telemetria dos agentes: nenhuma coletada ainda</Badge></p>}
        </Card>
      </div>
    </>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-neutral-600">{k}</dt>
      <dd className="font-medium">{v}</dd>
    </div>
  );
}
