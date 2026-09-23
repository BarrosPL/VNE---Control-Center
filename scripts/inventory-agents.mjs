// Inventario READ-ONLY dos workflows de agentes no n8n. Uso:
//   node --env-file=.env.admin scripts/inventory-agents.mjs [--registry=registry/vne.registry.json]
//        [--workflows=id1,id2] [--out=docs/inventory/agents-YYYY-MM-DD.json] [--confirm-host=<host>]
// Le a definicao dos workflows (workflow_entity) numa transacao READ ONLY. NAO altera o n8n.
// Saida: estrutura, hosts e hashes. NUNCA grava prompts, parametros, credenciais nem payloads.
import pg from 'pg';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { analyzeWorkflow, diffAgentTools } from './lib/n8n-inventory.mjs';
import { assertTargetAllowed, parseArgs } from './lib/migrations.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));

try {
  const e = process.env;
  const url = e.DATABASE_URL || (e.PGHOST ? `postgres://${encodeURIComponent(e.PGUSER)}:${encodeURIComponent(e.PGPASSWORD)}@${e.PGHOST}:${e.PGPORT || 5432}/${e.PGDATABASE}` : null);
  if (!url) throw new Error('Defina DATABASE_URL (ou PG*) de LEITURA do banco do n8n, ex.: --env-file=.env.admin');
  const { host, remote } = assertTargetAllowed(url, flags['confirm-host'] ?? new URL(url).hostname);

  const registry = JSON.parse(readFileSync(typeof flags.registry === 'string' ? flags.registry : 'registry/vne.registry.json', 'utf8'));
  const declaredIds = registry.agents.flatMap((a) => (a.metadata?.workflows ?? []).map((w) => w.id));
  const ids = typeof flags.workflows === 'string' ? flags.workflows.split(',') : declaredIds;

  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await client.connect();
  let inventory;
  try {
    await client.query('BEGIN READ ONLY');
    const all = (await client.query('SELECT id, name, active FROM workflow_entity')).rows;
    const index = Object.fromEntries(all.map((r) => [r.id, { name: r.name, active: r.active }]));
    const rows = (await client.query(
      `SELECT id, name, active, "versionId", "versionCounter", "activeVersionId", "updatedAt", nodes, connections
         FROM workflow_entity WHERE id = ANY($1) ORDER BY name`, [ids])).rows;
    // candidatos: workflows com node de agente cujo nome sugere ser a proxima versao de um agente cadastrado
    const slugs = registry.agents.map((a) => a.slug);
    const candidateRows = (await client.query(
      `SELECT id, name, active, "versionId", "versionCounter", "activeVersionId", "updatedAt", nodes, connections
         FROM workflow_entity
        WHERE NOT (id = ANY($1)) AND NOT "isArchived"
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(nodes::jsonb) n WHERE n->>'type' LIKE '%langchain.agent')
          AND name ~* ANY($2)
        ORDER BY "updatedAt" DESC`, [ids, slugs])).rows;
    await client.query('ROLLBACK');

    const analyze = (r) => analyzeWorkflow({ ...r, nodes: r.nodes, connections: r.connections }, index);
    const observed = rows.map(analyze);
    const candidates = candidateRows.map(analyze);
    const diffs = registry.agents.map((a) => {
      const wfIds = (a.metadata?.workflows ?? []).filter((w) => w.role === 'agent').map((w) => w.id);
      const wf = observed.find((o) => wfIds.includes(o.workflow.id));
      const obsAgent = wf?.agents[0];
      return {
        agent: a.slug,
        workflowId: wfIds[0] ?? null,
        registryVersion: a.version.version,
        registryWorkflowRevision: a.version.source_revision ?? null,
        observedVersionCounter: wf?.workflow.versionCounter ?? null,
        observedVersionId: wf?.workflow.versionId ?? null,
        workflowActive: wf?.workflow.active ?? null,
        modelRegistry: a.version.model_name ?? null,
        modelObserved: obsAgent?.models.filter((m) => !m.disabled).map((m) => m.model) ?? null,
        tools: obsAgent ? diffAgentTools(a.tools, obsAgent) : null,
      };
    });
    inventory = {
      generatedAt: new Date().toISOString(), source: { host, readOnly: true }, registry: registry.source,
      workflows: observed, candidates, diffs,
    };
  } finally {
    await client.end();
  }

  const out = typeof flags.out === 'string' ? flags.out : `docs/inventory/agents-${new Date().toISOString().slice(0, 10)}.json`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(inventory, null, 2)}\n`);
  log('info', 'inventory_written', { out, host, remote, workflows: inventory.workflows.length, candidates: inventory.candidates.length });
  for (const d of inventory.diffs) log('info', 'agent_diff', d);
} catch (err) {
  log('error', 'failed', { message: err.message });
  process.exit(1);
}
