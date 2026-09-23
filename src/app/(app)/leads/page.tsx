import Link from 'next/link';
import { EntityName } from '../../../components/entity-name.tsx';
import { Badge, EmptyState, Forbidden, PageHeader, Table, Td, Th } from '../../../components/ui.tsx';
import { KIND, LEAD_DATA_INTEGRATION } from '../../../domain/data-sources.ts';
import { formatDateTime, relativeAge } from '../../../domain/labels.ts';
import { can } from '../../../domain/rbac.ts';
import { getDb } from '../../../server/db.ts';
import { checkPermission } from '../../../server/guards.ts';
import { resolveEntities } from '../../../server/catalog/resolver.ts';
import { listLeads } from '../../../server/queries/leads.ts';

export const dynamic = 'force-dynamic';

export default async function LeadsPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const { user, allowed } = await checkPermission('entities:read');
  if (!allowed) return <Forbidden permission="entities:read" />;
  const sp = await searchParams;
  const q = typeof sp.q === 'string' ? sp.q : '';
  const { items, total, page, pageSize } = await listLeads(getDb(), { q, page: Number(sp.page) });
  const pages = Math.max(1, Math.ceil(total / pageSize));
  // nomes de pipeline/etapa via catalogo generico: UMA consulta em lote para a pagina inteira
  const catalog = await resolveEntities(getDb(), LEAD_DATA_INTEGRATION, items.flatMap((i) => [
    { kind: KIND.pipeline, id: i.pipelineId }, { kind: KIND.status, id: i.statusId },
  ]), { directory: can(user.role, 'directory:read') });
  const link = (p: number) => `/leads?${new URLSearchParams({ ...(q ? { q } : {}), page: String(p) })}`;

  return (
    <>
      <PageHeader title="Leads" subtitle="Leads acompanhados pelas automações (fonte: vne_leads_snapshot)." />
      <form method="get" action="/leads" className="mb-4 flex gap-2">
        <label htmlFor="q" className="sr-only">Buscar por nome ou ID do lead</label>
        <input
          id="q" name="q" defaultValue={q} placeholder="Nome ou ID do lead (Kommo)" maxLength={100}
          className="w-full max-w-sm rounded-md border border-neutral-300 px-3 py-2 text-sm"
        />
        <button type="submit" className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white">Buscar</button>
        {q && <Link href="/leads" className="self-center text-sm text-sky-700 underline">Limpar</Link>}
      </form>

      {items.length === 0 ? (
        <EmptyState title={q ? 'Nenhum lead encontrado' : 'Nenhum lead acompanhado ainda'}>
          {q ? 'Tente outro nome ou o ID numérico do lead no Kommo.' : 'Os leads aparecem conforme os workflows de captura os registram.'}
        </EmptyState>
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Lead</Th><Th>Pipeline / etapa</Th><Th>Mensagens (↓ / ↑)</Th><Th>Última msg do cliente</Th><Th>Última atividade</Th><Th>Último workflow registrado</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((l) => (
                <tr key={l.leadId} className="hover:bg-neutral-50">
                  <Td>
                    <Link href={`/leads/${l.leadId}`} className="font-medium text-sky-800 underline">
                      {l.name ?? `Lead ${l.leadId}`}
                    </Link>
                    <div className="text-xs text-neutral-500">
                      #{l.leadId}{l.isDeleted && <> · <Badge tone="danger">Excluído no Kommo</Badge></>}
                    </div>
                  </Td>
                  <Td>
                    {l.pipelineId || l.statusId ? (
                      <span className="text-xs"><EntityName map={catalog} kind={KIND.pipeline} id={l.pipelineId} /> / <EntityName map={catalog} kind={KIND.status} id={l.statusId} /></span>
                    ) : (
                      <Badge tone="warn" title="Ainda não há evento CRM registrado para este lead">Não sincronizado</Badge>
                    )}
                  </Td>
                  <Td>{l.totalIncoming} / {l.totalOutgoing}</Td>
                  <Td>
                    {formatDateTime(l.lastClientMessageAt)}
                    <div className="text-xs text-neutral-500">{relativeAge(l.lastClientMessageAt)}</div>
                  </Td>
                  <Td>{relativeAge(l.lastSeenAt)}</Td>
                  <Td>{l.lastWorkflow ?? <span className="text-neutral-400">—</span>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <nav aria-label="Paginação" className="mt-4 flex items-center justify-between text-sm">
            <span className="text-neutral-600">{total} lead(s) · página {page} de {pages}</span>
            <span className="flex gap-3">
              {page > 1 && <Link href={link(page - 1)} className="text-sky-700 underline">← Anterior</Link>}
              {page < pages && <Link href={link(page + 1)} className="text-sky-700 underline">Próxima →</Link>}
            </span>
          </nav>
        </>
      )}
    </>
  );
}
