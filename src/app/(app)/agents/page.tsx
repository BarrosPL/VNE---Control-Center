import Link from 'next/link';
import { Badge, EmptyState, Forbidden, InformationalNotice, PageHeader, Table, Td, Th } from '../../../components/ui.tsx';
import { MODE_LABEL, STATUS_LABEL } from '../../../domain/labels.ts';
import { getDb } from '../../../server/db.ts';
import { checkPermission } from '../../../server/guards.ts';
import { listAgents } from '../../../server/queries/agents.ts';

export const dynamic = 'force-dynamic';

export default async function AgentsPage() {
  const { allowed } = await checkPermission('agents:read');
  if (!allowed) return <Forbidden permission="agents:read" />;
  const agents = await listAgents(getDb());

  return (
    <>
      <PageHeader title="Agentes" subtitle="Todos os agentes cadastrados na plataforma." />
      <InformationalNotice />
      {agents.length === 0 ? (
        <EmptyState title="Nenhum agente cadastrado">Importe o registro declarativo para cadastrar agentes.</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Agente</Th><Th>Tipo</Th><Th>Status</Th><Th>Modo</Th><Th>Versão ativa</Th><Th>Modelo</Th><Th>Tools em uso</Th><Th>Alertas</Th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => {
              const mode = MODE_LABEL[a.operationalMode];
              const status = STATUS_LABEL[a.status];
              return (
                <tr key={a.id} className="hover:bg-neutral-50">
                  <Td>
                    <Link href={`/agents/${a.id}`} className="font-medium text-sky-800 underline">{a.name}</Link>
                    <div className="text-xs text-neutral-500">{a.slug}</div>
                  </Td>
                  <Td>{a.agentType}</Td>
                  <Td><Badge tone={status?.tone}>{status?.label ?? a.status}</Badge></Td>
                  <Td><Badge tone={mode?.tone} title={mode?.hint}>{mode?.label ?? a.operationalMode}</Badge></Td>
                  <Td>{a.activeVersion ?? <span className="text-neutral-400">—</span>}</Td>
                  <Td>{a.modelName ?? <span className="text-neutral-400">—</span>}</Td>
                  <Td>
                    {a.toolCount}
                    {a.absentToolCount > 0 && (
                      <div className="mt-1"><Badge tone="warn" title="Vinculadas, mas retiradas do workflow">{a.absentToolCount} ausente(s)</Badge></div>
                    )}
                  </Td>
                  <Td>{a.warningCount > 0 ? <Badge tone="warn">{a.warningCount} tool(s) com aviso</Badge> : <span className="text-neutral-400">—</span>}</Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </>
  );
}
