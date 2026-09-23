import Link from 'next/link';
import { Badge, EmptyState, Table, Td, Th } from './ui.tsx';
import {
  LEVEL_TONE, RUN_STATUS_LABEL, SESSION_STATUS_LABEL, eventTypeLabel, formatDateTime, formatDuration, relativeAge,
} from '../domain/labels.ts';
import type { EventItem, RunItem, SessionItem } from '../server/queries/telemetry.ts';

export const SyntheticBadge = () => <Badge tone="info" title="Dado de demonstração, não vem de execução real">Sintético</Badge>;

const entityCell = (type: string | null, id: string | null, leadId: string | null) =>
  leadId ? <Link href={`/leads/${leadId}`} className="text-sky-800 underline">lead #{leadId}</Link>
    : type && id ? <span>{type} <code className="text-xs">{id}</code></span> : <span className="text-neutral-400">não informada</span>;

export function RunsTable({ runs, showAgent = true }: { runs: RunItem[]; showAgent?: boolean }) {
  if (runs.length === 0) return <EmptyState title="Nenhuma execução registrada" />;
  return (
    <Table>
      <thead>
        <tr>
          <Th>Início</Th>{showAgent && <Th>Agente</Th>}<Th>Versão</Th><Th>Gatilho</Th><Th>Entidade</Th><Th>Status</Th><Th>Duração</Th><Th>Origem</Th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => {
          const st = RUN_STATUS_LABEL[r.status];
          return (
            <tr key={r.id}>
              <Td>{formatDateTime(r.startedAt)}<div className="text-xs text-neutral-500">{relativeAge(r.startedAt)}</div></Td>
              {showAgent && <Td><Link href={`/agents/${r.agentId}`} className="text-sky-800 underline">{r.agentName}</Link></Td>}
              <Td>{r.versionLabel ?? <span className="text-xs text-amber-700" title="A versão do workflow desta execução não está cadastrada">não resolvida</span>}</Td>
              <Td>{r.triggerType}</Td>
              <Td>{entityCell(r.entityType, r.entityId, r.leadId)}</Td>
              <Td>
                <Badge tone={st?.tone}>{st?.label ?? r.status}</Badge>
                {r.errorCode && <div className="mt-1 text-xs text-red-700">{r.errorCode}</div>}
              </Td>
              <Td>{formatDuration(r.durationMs)}</Td>
              <Td>{r.synthetic ? <SyntheticBadge /> : <span className="text-xs">{r.source}</span>}</Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

export function SessionsTable({ sessions, showAgent = true }: { sessions: SessionItem[]; showAgent?: boolean }) {
  if (sessions.length === 0) return <EmptyState title="Nenhuma sessão registrada" />;
  return (
    <Table>
      <thead><tr>{showAgent && <Th>Agente</Th>}<Th>Entidade</Th><Th>Status</Th><Th>Iniciada</Th><Th>Última atividade</Th><Th>Origem</Th></tr></thead>
      <tbody>
        {sessions.map((s) => {
          const st = SESSION_STATUS_LABEL[s.status];
          return (
            <tr key={s.id}>
              {showAgent && <Td><Link href={`/agents/${s.agentId}`} className="text-sky-800 underline">{s.agentName}</Link></Td>}
              <Td>{entityCell(s.entityType, s.entityId, s.leadId)}</Td>
              <Td><Badge tone={st?.tone}>{st?.label ?? s.status}</Badge></Td>
              <Td>{formatDateTime(s.startedAt)}</Td>
              <Td>{relativeAge(s.lastActivityAt)}</Td>
              <Td>{s.synthetic ? <SyntheticBadge /> : '—'}</Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

export function EventsTable({ events }: { events: EventItem[] }) {
  if (events.length === 0) return <EmptyState title="Nenhum evento com estes filtros" />;
  return (
    <Table>
      <thead><tr><Th>Horário</Th><Th>Agente</Th><Th>Evento</Th><Th>Entidade</Th><Th>Tool</Th><Th>Origem</Th></tr></thead>
      <tbody>
        {events.map((e) => (
          <tr key={e.id}>
            <Td>{formatDateTime(e.occurredAt)}<div className="text-xs text-neutral-500">{relativeAge(e.occurredAt)}</div></Td>
            <Td>{e.agentId ? <Link href={`/agents/${e.agentId}`} className="text-sky-800 underline">{e.agentName}</Link> : '—'}</Td>
            <Td><Badge tone={LEVEL_TONE[e.level]}>{eventTypeLabel(e.eventType)}</Badge></Td>
            <Td>{entityCell(e.entityType, e.entityId, e.leadId)}</Td>
            <Td>{e.toolCode ? <code className="text-xs">{e.toolCode}</code> : '—'}</Td>
            <Td>{e.synthetic ? <SyntheticBadge /> : <span className="text-xs">{e.source}</span>}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
