import Link from 'next/link';
import { Badge, EmptyState, Forbidden, InformationalNotice, PageHeader, Table, Td, Th } from '../../../components/ui.tsx';
import { CRITICALITY_LABEL, STATUS_LABEL } from '../../../domain/labels.ts';
import { getDb } from '../../../server/db.ts';
import { checkPermission } from '../../../server/guards.ts';
import { listIntegrations } from '../../../server/queries/integrations.ts';

export const dynamic = 'force-dynamic';

export default async function IntegrationsPage() {
  const { allowed } = await checkPermission('integrations:read');
  if (!allowed) return <Forbidden permission="integrations:read" />;
  const items = await listIntegrations(getDb());

  return (
    <>
      <PageHeader title="Integrações" subtitle="Dependências dos agentes. Nenhum segredo é exibido." />
      <InformationalNotice />
      {items.length === 0 ? (
        <EmptyState title="Nenhuma integração cadastrada" />
      ) : (
        <Table>
          <thead>
            <tr><Th>Integração</Th><Th>Tipo</Th><Th>Ambiente</Th><Th>Estado</Th><Th>Última checagem</Th><Th>Tools</Th><Th>Catálogo</Th><Th>Agentes dependentes</Th></tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <Td><div className="font-medium">{i.name}</div><code className="text-xs text-neutral-500">{i.code}</code></Td>
                <Td>{i.integrationType}</Td>
                <Td>{i.environment}</Td>
                <Td><Badge tone={STATUS_LABEL[i.status]?.tone}>{STATUS_LABEL[i.status]?.label ?? i.status}</Badge></Td>
                <Td><span className="text-neutral-500" title="Health checks chegam na Fase 8">Não monitorada</span></Td>
                <Td>{i.toolCount}</Td>
                <Td>
                  <Link href={`/integrations/${i.code}/catalog`} className="text-sky-800 underline">
                    {i.catalogCount > 0 ? `${i.catalogCount} entidade(s)` : 'sem nomes'}
                  </Link>
                </Td>
                <Td>
                  {i.agents.length === 0 ? '—' : (
                    <ul className="space-y-1">
                      {i.agents.map((a) => (
                        <li key={a.id}>
                          <Link href={`/agents/${a.id}`} className="text-sky-800 underline">{a.name}</Link>{' '}
                          <span className="text-xs text-neutral-500">
                            {CRITICALITY_LABEL[a.criticality] ?? a.criticality}{a.required ? ' · obrigatória' : ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
