import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, Card, EmptyState, Forbidden, InformationalNotice, PageHeader, Table, Td, Th } from '../../../../components/ui.tsx';
import {
  CRITICALITY_LABEL, MODE_LABEL, MUTATION_LABEL, OBSERVED_LABEL, PERMISSION_LABEL, RISK_LABEL, STATUS_LABEL, formatDateTime,
} from '../../../../domain/labels.ts';
import { getDb } from '../../../../server/db.ts';
import { checkPermission } from '../../../../server/guards.ts';
import { RunsTable, SessionsTable } from '../../../../components/telemetry-tables.tsx';
import { getAgent } from '../../../../server/queries/agents.ts';
import { listRuns, listSessions } from '../../../../server/queries/telemetry.ts';

export const dynamic = 'force-dynamic';

export default async function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { allowed } = await checkPermission('agents:read');
  if (!allowed) return <Forbidden permission="agents:read" />;
  const { id } = await params;
  const d = await getAgent(getDb(), id);
  if (!d) notFound();
  const { agent } = d;
  const mode = MODE_LABEL[agent.operationalMode];
  const status = STATUS_LABEL[agent.status];
  const active = d.versions.find((v) => v.status === 'active' && v.environment === 'production');
  const withWarnings = d.tools.filter((t) => t.warnings.length > 0 && t.observedState === 'present');
  const absentTools = d.tools.filter((t) => t.observedState === 'absent');
  // telemetria e opcional (tabelas podem nao existir ainda): indisponivel != zero
  const db = getDb();
  const [runs, sessions] = await Promise.all([
    listRuns(db, { agentId: agent.id, limit: 10 }).catch(() => null),
    listSessions(db, { agentId: agent.id, limit: 10 }).catch(() => null),
  ]);

  return (
    <>
      <p className="mb-2 text-sm"><Link href="/agents" className="text-sky-700 underline">← Agentes</Link></p>
      <PageHeader
        title={agent.name}
        subtitle={agent.description ?? 'Sem descrição.'}
        actions={
          <div className="flex gap-2">
            <Badge tone={status?.tone}>{status?.label ?? agent.status}</Badge>
            <Badge tone={mode?.tone} title={mode?.hint}>{mode?.label ?? agent.operationalMode}</Badge>
          </div>
        }
      />
      <InformationalNotice />

      {withWarnings.length > 0 && (
        <div role="alert" className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-medium">{withWarnings.length} tool(s) presente(s) no workflow com aviso de revisão:</p>
          <ul className="mt-1 list-disc pl-5">
            {withWarnings.map((t) => (
              <li key={t.id}><code>{t.code}</code>: {t.warnings.join(' ')}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Visão geral">
          <dl className="space-y-1 text-sm">
            <Item k="Tipo" v={agent.agentType} />
            <Item k="Versão ativa" v={active ? `${active.version} (${active.environment})` : '—'} />
            <Item k="Modelo" v={active?.modelName ? `${active.modelProvider ?? ''} ${active.modelName}`.trim() : '—'} />
            <Item k="Responsável" v={agent.ownerName ?? agent.ownerTeam ?? 'não definido'} />
            <Item k="Workflows n8n" v={agent.workflows.length ? agent.workflows.map((w) => `${w.id}${w.role ? ` (${w.role})` : ''}`).join(', ') : '—'} />
            <Item k="Cadastrado em" v={formatDateTime(agent.createdAt)} />
            <Item k="Atualizado em" v={formatDateTime(agent.updatedAt)} />
          </dl>
        </Card>
        <Card title={`Capabilities (${d.capabilities.length})`}>
          {d.capabilities.length === 0 ? <p className="text-sm text-neutral-600">Nenhuma capability declarada.</p> : (
            <ul className="space-y-2 text-sm">
              {d.capabilities.map((c) => (
                <li key={c.code}>
                  <span className="font-medium">{c.name}</span>{' '}
                  <Badge tone={RISK_LABEL[c.riskLevel]?.tone}>Risco {RISK_LABEL[c.riskLevel]?.label ?? c.riskLevel}</Badge>
                  {!c.enabled && <Badge tone="danger">Desabilitada</Badge>}
                  {c.description && <div className="text-xs text-neutral-500">{c.description}</div>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <h2 className="mb-1 mt-8 text-lg font-semibold">Tools ({d.tools.length})</h2>
      <p className="mb-2 text-xs text-neutral-500">
        <strong>Observado no workflow</strong> é o que foi lido do n8n (fato). <strong>Política</strong> é o que o Control Center
        permite (decisão). Uma tool retirada do workflow fica <em>Ausente</em>, sem apagar o vínculo nem a política.
        {absentTools.length > 0 && <> Hoje há {absentTools.length} ausente(s).</>}
      </p>
      {d.tools.length === 0 ? <EmptyState title="Nenhuma tool vinculada" /> : (
        <Table>
          <thead>
            <tr><Th>Tool</Th><Th>Tipo</Th><Th>Operação</Th><Th>Risco</Th><Th>Integração</Th><Th>Observado no workflow</Th><Th>Política (Control Center)</Th></tr>
          </thead>
          <tbody>
            {d.tools.map((t) => {
              const obs = OBSERVED_LABEL[t.observedState];
              return (
                <tr key={t.id} className={t.observedState === 'absent' ? 'bg-neutral-50 text-neutral-500' : ''}>
                  <Td>
                    <div className="font-medium">{t.name}</div>
                    <code className="text-xs text-neutral-500">{t.code}</code>
                    {t.warnings.length > 0 && t.observedState === 'present' && <div className="mt-1"><Badge tone="warn">Revisar</Badge></div>}
                  </Td>
                  <Td>{t.toolType}</Td>
                  <Td><Badge tone={MUTATION_LABEL[t.mutationLevel]?.tone}>{MUTATION_LABEL[t.mutationLevel]?.label ?? t.mutationLevel}</Badge></Td>
                  <Td><Badge tone={RISK_LABEL[t.riskLevel]?.tone}>{RISK_LABEL[t.riskLevel]?.label ?? t.riskLevel}</Badge></Td>
                  <Td>{t.integrationCode ?? '—'}</Td>
                  <Td>
                    <Badge tone={obs?.tone} title={obs?.hint}>{obs?.label ?? t.observedState}</Badge>
                    {t.observedState === 'absent' && t.absentSince && (
                      <div className="mt-1 text-xs">desde {formatDateTime(t.absentSince)}</div>
                    )}
                    {t.observedSource && <div className="mt-1 text-xs text-neutral-400" title="Revisão do workflow observada">{t.observedSource}</div>}
                  </Td>
                  <Td>
                    <Badge tone={PERMISSION_LABEL[t.permissionMode]?.tone}>{PERMISSION_LABEL[t.permissionMode]?.label ?? t.permissionMode}</Badge>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      <h2 className="mb-2 mt-8 text-lg font-semibold">Integrações ({d.integrations.length})</h2>
      {d.integrations.length === 0 ? <EmptyState title="Nenhuma integração declarada" /> : (
        <Table>
          <thead><tr><Th>Integração</Th><Th>Ambiente</Th><Th>Estado</Th><Th>Observada no workflow</Th><Th>Criticidade</Th><Th>Obrigatória</Th></tr></thead>
          <tbody>
            {d.integrations.map((i) => {
              const obs = OBSERVED_LABEL[i.observedState];
              return (
                <tr key={i.id} className={i.observedState === 'absent' ? 'bg-neutral-50 text-neutral-500' : ''}>
                  <Td><div className="font-medium">{i.name}</div><code className="text-xs text-neutral-500">{i.code}</code></Td>
                  <Td>{i.environment}</Td>
                  <Td><Badge tone={STATUS_LABEL[i.status]?.tone}>{STATUS_LABEL[i.status]?.label ?? i.status}</Badge></Td>
                  <Td>
                    <Badge tone={obs?.tone} title={obs?.hint}>{obs?.label ?? i.observedState}</Badge>
                    {i.observedState === 'absent' && i.absentSince && <div className="mt-1 text-xs">desde {formatDateTime(i.absentSince)}</div>}
                  </Td>
                  <Td>{CRITICALITY_LABEL[i.criticality] ?? i.criticality}</Td>
                  <Td>{i.required ? 'Sim' : 'Não'}</Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      <h2 className="mb-1 mt-8 text-lg font-semibold">Versões ({d.versions.length})</h2>
      <p className="mb-2 text-xs text-neutral-500">
        Uma versão <strong>selada</strong> (já liberada ou usada por execuções) tem configuração imutável: mudanças viram uma nova versão.
      </p>
      {d.versions.length === 0 ? <EmptyState title="Nenhuma versão registrada" /> : (
        <Table>
          <thead><tr><Th>Versão</Th><Th>Ambiente</Th><Th>Status</Th><Th>Modelo</Th><Th>Procedência</Th><Th>Diferenças vs. ativa</Th><Th>Changelog</Th></tr></thead>
          <tbody>
            {d.versions.map((v) => (
              <tr key={v.id}>
                <Td>
                  <div className="font-medium">{v.version}</div>
                  {v.sealed ? <Badge tone="info" title={`Selada em ${formatDateTime(v.sealedAt)}`}>Selada</Badge> : <Badge tone="neutral" title="Ainda editável: nunca liberada nem usada">Editável</Badge>}
                </Td>
                <Td>{v.environment}</Td>
                <Td><Badge tone={STATUS_LABEL[v.status]?.tone}>{STATUS_LABEL[v.status]?.label ?? v.status}</Badge></Td>
                <Td>{v.modelName ?? '—'}</Td>
                <Td>
                  <code className="text-xs">{v.workflowExternalId ?? '—'}</code>
                  {v.sourceRevision && <div className="mt-1 break-all text-xs text-neutral-500">{v.sourceRevision}</div>}
                  {v.configHash && <div className="mt-1 text-xs text-neutral-400" title={v.configHash}>config {v.configHash.slice(0, 12)}</div>}
                  {!v.configHash && <div className="mt-1 text-xs text-amber-700">sem procedência</div>}
                </Td>
                <Td className="text-xs">
                  {v.diffVsActive ? (
                    <>
                      {v.diffVsActive.added.length > 0 && <div className="text-emerald-700">+ {v.diffVsActive.added.join(', ')}</div>}
                      {v.diffVsActive.removed.length > 0 && <div className="text-red-700">− {v.diffVsActive.removed.join(', ')}</div>}
                      {v.diffVsActive.added.length === 0 && v.diffVsActive.removed.length === 0 && <span className="text-neutral-400">mesmas tools</span>}
                    </>
                  ) : <span className="text-neutral-400">—</span>}
                </Td>
                <Td className="max-w-md text-neutral-600">{v.changelog ?? '—'}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <h2 className="mb-2 mt-8 text-lg font-semibold">Execuções recentes</h2>
      {runs === null ? <EmptyState title="Telemetria indisponível">As tabelas de telemetria ainda não existem neste ambiente.</EmptyState> : <RunsTable runs={runs} showAgent={false} />}
      <h2 className="mb-2 mt-8 text-lg font-semibold">Sessões recentes</h2>
      {sessions === null ? <EmptyState title="Telemetria indisponível" /> : <SessionsTable sessions={sessions} showAgent={false} />}
    </>
  );
}

function Item({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-neutral-600">{k}</dt>
      <dd className="text-right font-medium">{v}</dd>
    </div>
  );
}
