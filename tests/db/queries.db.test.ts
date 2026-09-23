import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRegistry } from '../../src/domain/registry.ts';
import { importRegistry } from '../../src/server/registry/importer.ts';
import { getAgent, listAgents } from '../../src/server/queries/agents.ts';
import { listIntegrations } from '../../src/server/queries/integrations.ts';
import { getOverview } from '../../src/server/queries/overview.ts';
import { startTestDb, type TestDb } from './helpers.ts';

let t: TestDb;
const reg = parseRegistry(JSON.parse(readFileSync(join(__dirname, '..', '..', 'registry', 'vne.registry.json'), 'utf8')));

beforeAll(async () => {
  t = await startTestDb('acc-queries-');
  await t.app.query('BEGIN');
  await importRegistry(t.app, reg);
  await t.app.query('COMMIT');
});
afterAll(async () => {
  await t?.stop();
});

describe('queries de leitura (como role acc_app)', () => {
  it('listAgents devolve todos os agentes com contagens coerentes', async () => {
    const list = await listAgents(t.app);
    expect(list.map((a) => a.slug).sort()).toEqual(reg.agents.map((a) => a.slug).sort());
    for (const a of list) {
      const src = reg.agents.find((x) => x.slug === a.slug)!;
      expect(a.toolCount).toBe(src.tools.length);
      expect(a.integrationCount).toBe(src.integrations.length);
      expect(a.activeVersion).toBe(src.version.version);
      expect(a.warningCount).toBeGreaterThan(0); // ha tools com aviso no registro
    }
  });

  it('tools desabilitadas nao contam como tools ativas do agente', async () => {
    await t.owner.query(`UPDATE acc_agent_tools SET permission_mode='disabled' WHERE tool_id=(SELECT id FROM acc_tools WHERE code='cancelar_reuniao_seguro')`);
    const list = await listAgents(t.app);
    const src = reg.agents.find((x) => x.tools.includes('cancelar_reuniao_seguro'))!;
    expect(list.find((a) => a.slug === src.slug)!.toolCount).toBe(src.tools.length - 1);
    await t.owner.query(`UPDATE acc_agent_tools SET permission_mode='enabled'`);
  });

  it('getAgent traz tools (mutaveis primeiro), integracoes, capabilities, versoes e workflows', async () => {
    const [first] = await listAgents(t.app);
    const d = (await getAgent(t.app, first.id))!;
    expect(d.agent.slug).toBe(first.slug);
    expect(d.agent.workflows.length).toBeGreaterThan(0);
    expect(d.versions).toHaveLength(1);
    expect(d.tools.length).toBeGreaterThan(0);
    const firstReadIdx = d.tools.findIndex((x) => x.mutationLevel === 'read');
    const lastMutableIdx = d.tools.map((x) => x.mutationLevel).lastIndexOf('write');
    expect(firstReadIdx === -1 || lastMutableIdx < firstReadIdx).toBe(true);
    expect(d.tools.some((x) => x.warnings.length > 0)).toBe(true);
    expect(d.integrations.some((i) => i.required)).toBe(true);
  });

  it('getAgent: id invalido ou inexistente => null (sem consultar / sem erro)', async () => {
    expect(await getAgent(t.app, 'nao-e-uuid')).toBeNull();
    expect(await getAgent(t.app, "1' OR '1'='1")).toBeNull();
    expect(await getAgent(t.app, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('listIntegrations lista dependentes e nunca expoe metadata de segredos', async () => {
    const items = await listIntegrations(t.app);
    const kommo = items.find((i) => i.code === 'kommo')!;
    expect(kommo.agents.length).toBe(reg.agents.length);
    expect(kommo.toolCount).toBeGreaterThan(0);
    expect(kommo.lastHealth).toBeNull();
    expect(JSON.stringify(items)).not.toMatch(/metadata/i);
  });

  it('overview: sem tabelas vne_* => dataPlane null (indisponivel, nunca zero falso)', async () => {
    const o = await getOverview(t.app);
    expect(o.dataPlane).toBeNull();
    expect(o.agents.total).toBe(reg.agents.length);
    expect(o.agents.byMode.active).toBe(reg.agents.length);
    expect(o.registry.mutableTools).toBeGreaterThan(0);
    expect(o.agents.withWarnings).toBe(reg.agents.length);
  });

  it('overview: com tabelas vne_* le contagens reais (somente leitura)', async () => {
    await t.owner.query(`CREATE TABLE vne_mensagens (id int, created_at_kommo timestamptz)`);
    await t.owner.query(`CREATE TABLE vne_eventos_crm (id int, received_at timestamptz)`);
    await t.owner.query(`CREATE TABLE vne_leads_snapshot (lead_id int)`);
    await t.owner.query(`INSERT INTO vne_mensagens VALUES (1, now()), (2, now() - interval '2 days')`);
    await t.owner.query(`INSERT INTO vne_eventos_crm VALUES (1, now())`);
    await t.owner.query(`INSERT INTO vne_leads_snapshot VALUES (10), (11), (12)`);
    await t.owner.query(`GRANT SELECT ON vne_mensagens, vne_eventos_crm, vne_leads_snapshot TO acc_app`);
    const o = await getOverview(t.app);
    expect(o.dataPlane).toMatchObject({ messages24h: 1, crmEvents24h: 1, leadsTracked: 3 });
    expect(o.dataPlane?.lastMessageAt).toBeTruthy();
  });

  it('agentes arquivados nao entram nas metricas de modo', async () => {
    await t.owner.query(`UPDATE acc_agents SET status='archived' WHERE slug=$1`, [reg.agents[0].slug]);
    const o = await getOverview(t.app);
    expect(o.agents.total).toBe(reg.agents.length - 1);
  });
});
