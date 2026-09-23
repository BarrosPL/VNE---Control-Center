import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, Card, EmptyState, Forbidden, PageHeader, Table, Td, Th } from '../../../../../components/ui.tsx';
import { LEAD_DATA_INTEGRATION } from '../../../../../domain/data-sources.ts';
import { formatDateTime } from '../../../../../domain/labels.ts';
import { findCatalogGaps, listCatalog } from '../../../../../server/catalog/resolver.ts';
import { getDb } from '../../../../../server/db.ts';
import { checkPermission } from '../../../../../server/guards.ts';

export const dynamic = 'force-dynamic';

const CODE = /^[a-z][a-z0-9_.]{1,63}$/;

export default async function CatalogPage({ params }: { params: Promise<{ code: string }> }) {
  const { allowed } = await checkPermission('integrations:read');
  if (!allowed) return <Forbidden permission="integrations:read" />;
  const { code } = await params;
  if (!CODE.test(code)) notFound();
  const db = getDb();
  const exists = await db.query(`SELECT name FROM acc_integrations WHERE code = $1 AND environment = 'production'`, [code]);
  if (!exists.rows[0]) notFound();

  const entities = await listCatalog(db, code);
  // o relatorio de IDs sem nome so faz sentido para a integracao dona dos IDs de vne_*
  let gaps = null;
  if (code === LEAD_DATA_INTEGRATION) {
    try {
      gaps = await findCatalogGaps(db, code);
    } catch {
      gaps = null;
    }
  }
  const byKind = new Map<string, number>();
  for (const e of entities) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
  const gapsByKind = new Map<string, typeof gaps>();
  for (const g of gaps ?? []) gapsByKind.set(g.kind, [...(gapsByKind.get(g.kind) ?? []), g]);

  return (
    <>
      <p className="mb-2 text-sm"><Link href="/integrations" className="text-sky-700 underline">← Integrações</Link></p>
      <PageHeader
        title={`Catálogo · ${String(exists.rows[0].name)}`}
        subtitle="Nomes das entidades externas (pipelines, etapas, usuários…). Usado para exibir nomes em vez de IDs. Não contém segredos."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Resumo do catálogo">
          {entities.length === 0 ? (
            <p className="text-sm text-neutral-600">Nenhuma entidade catalogada. As telas exibem apenas IDs.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {[...byKind].map(([k, n]) => <li key={k} className="flex justify-between"><span>{k}</span><span className="font-medium">{n}</span></li>)}
            </ul>
          )}
        </Card>
        <Card title="IDs observados nos dados sem nome no catálogo">
          {gaps === null ? (
            <p className="text-sm text-neutral-600">Não aplicável a esta integração (ou a fonte de dados não respondeu).</p>
          ) : gaps.length === 0 ? (
            <p className="text-sm text-emerald-700">Todos os IDs observados têm nome no catálogo.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {[...gapsByKind].map(([k, list]) => (
                <li key={k}>
                  <span className="font-medium">{k}</span> <Badge tone="warn">{list!.length} sem nome</Badge>
                  <div className="mt-1 break-words text-xs text-neutral-600">
                    {list!.slice(0, 40).map((g) => `${g.externalId} (${g.seenIn}×)`).join(' · ')}
                    {list!.length > 40 && ` … +${list!.length - 40}`}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-neutral-500">
            Para preencher: crie <code>registry/catalogs/{code}.json</code> e rode <code>npm run db:catalog:preview</code> /{' '}
            <code>db:catalog:apply</code>. Nenhum nome é inventado pelo sistema.
          </p>
        </Card>
      </div>

      <h2 className="mb-2 mt-8 text-lg font-semibold">Entidades ({entities.length})</h2>
      {entities.length === 0 ? <EmptyState title="Catálogo vazio" /> : (
        <Table>
          <thead><tr><Th>Tipo</Th><Th>ID externo</Th><Th>Nome</Th><Th>Pai</Th><Th>Estado</Th><Th>Origem</Th><Th>Sincronizado</Th></tr></thead>
          <tbody>
            {entities.map((e) => (
              <tr key={`${e.kind}:${e.externalId}:${e.parentExternalId ?? ''}`} className={e.isActive ? '' : 'text-neutral-400'}>
                <Td>{e.kind}</Td>
                <Td><code className="text-xs">{e.externalId}</code></Td>
                <Td className="font-medium">{e.name}</Td>
                <Td>{e.parentKind ? <code className="text-xs">{e.parentKind}:{e.parentExternalId}</code> : '—'}</Td>
                <Td>{e.isActive ? <Badge tone="ok">Ativo</Badge> : <Badge tone="neutral">Inativo</Badge>}</Td>
                <Td>{e.source}</Td>
                <Td>{formatDateTime(e.syncedAt)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
