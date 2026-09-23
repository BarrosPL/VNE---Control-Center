import Link from 'next/link';
import { EmptyState, Forbidden, InformationalNotice, PageHeader } from '../../../components/ui.tsx';
import { EventsTable, RunsTable, SessionsTable } from '../../../components/telemetry-tables.tsx';
import { getDb } from '../../../server/db.ts';
import { checkPermission } from '../../../server/guards.ts';
import { listAgents } from '../../../server/queries/agents.ts';
import {
  getTelemetryOverview, listEventTypes, listEvents, listRuns, listSessions, type EventFilter,
} from '../../../server/queries/telemetry.ts';

export const dynamic = 'force-dynamic';

type SP = { agent?: string; type?: string; level?: string; cursor?: string; seq?: string };

export default async function LivePage({ searchParams }: { searchParams: Promise<SP> }) {
  const { allowed } = await checkPermission('agents:read');
  if (!allowed) return <Forbidden permission="agents:read" />;
  const sp = await searchParams;
  const db = getDb();

  const overview = await getTelemetryOverview(db).catch(() => null);
  if (!overview?.hasData) {
    return (
      <>
        <PageHeader title="Operação ao vivo" subtitle="Sessões, execuções e eventos dos agentes." />
        <EmptyState title={overview ? 'Nenhuma telemetria coletada ainda' : 'Telemetria indisponível'}>
          {overview
            ? 'Quando a coleta de execuções for conectada (Fase 4B), as sessões e eventos aparecem aqui.'
            : 'As tabelas de telemetria ainda não existem neste ambiente (migration pendente).'}
        </EmptyState>
      </>
    );
  }

  const filter: EventFilter = {
    agentId: sp.agent, eventType: sp.type, level: sp.level, limit: 50,
    before: sp.cursor && sp.seq ? { occurredAt: sp.cursor, seq: sp.seq } : undefined,
  };
  const [agents, types, sessions, runs, events] = await Promise.all([
    listAgents(db), listEventTypes(db), listSessions(db, { onlyActive: true, limit: 10 }),
    listRuns(db, { agentId: sp.agent, limit: 10 }), listEvents(db, filter),
  ]);
  const last = events.items[events.items.length - 1];
  const qs = (extra: Record<string, string>) =>
    `/live?${new URLSearchParams({ ...(sp.agent ? { agent: sp.agent } : {}), ...(sp.type ? { type: sp.type } : {}), ...(sp.level ? { level: sp.level } : {}), ...extra })}`;

  return (
    <>
      <PageHeader
        title="Operação ao vivo"
        subtitle="Últimas sessões, execuções e eventos dos agentes."
        actions={<Link href="/live" className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100">Atualizar</Link>}
      />
      <InformationalNotice />
      {overview.onlySynthetic && (
        <p role="note" className="mb-4 rounded-md border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-900">
          Telemetria <strong>sintética</strong> (demonstração): não vem de execuções reais dos agentes.
        </p>
      )}

      <form method="get" action="/live" className="mb-4 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-xs text-neutral-600">Agente</span>
          <select name="agent" defaultValue={sp.agent ?? ''} className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm">
            <option value="">Todos</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs text-neutral-600">Tipo de evento</span>
          <select name="type" defaultValue={sp.type ?? ''} className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm">
            <option value="">Todos</option>
            {types.map((t) => <option key={t.code} value={t.code} title={t.description}>{t.code}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs text-neutral-600">Nível</span>
          <select name="level" defaultValue={sp.level ?? ''} className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm">
            <option value="">Todos</option>
            <option value="error">Erro</option><option value="warn">Aviso</option><option value="info">Info</option>
          </select>
        </label>
        <button type="submit" className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white">Filtrar</button>
        {(sp.agent || sp.type || sp.level) && <Link href="/live" className="text-sm text-sky-700 underline">Limpar</Link>}
      </form>

      <h2 className="mb-2 text-lg font-semibold">Sessões ativas</h2>
      <SessionsTable sessions={sessions} />
      <h2 className="mb-2 mt-8 text-lg font-semibold">Execuções recentes</h2>
      <RunsTable runs={runs} />
      <h2 className="mb-2 mt-8 text-lg font-semibold">Eventos</h2>
      <EventsTable events={events.items} />
      {events.hasMore && last && (
        <p className="mt-4 text-center text-sm">
          <Link href={qs({ cursor: last.cursor.occurredAt, seq: last.cursor.seq })} className="text-sky-700 underline">Eventos mais antigos</Link>
        </p>
      )}
    </>
  );
}
