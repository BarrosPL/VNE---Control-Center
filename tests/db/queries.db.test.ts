import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRegistry, productionVersion } from '../../src/domain/registry.ts';
import { importRegistry } from '../../src/server/registry/importer.ts';
import { getAgent, listAgents } from '../../src/server/queries/agents.ts';
import { listIntegrations } from '../../src/server/queries/integrations.ts';
import { getOverview } from '../../src/server/queries/overview.ts';
import { startTestDb, type TestDb } from './helpers.ts';

let t: TestDb;
const reg = parseRegistry(JSON.parse(readFileSync(join(__dirname, '..', '..', 'registry', 'vne.registry.json'), 'utf8')));
const srcOf = (slug: string) => reg.agents.find((a) => a.slug === slug)!;

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
  it('listAgents devolve todos os agentes com contagens coerentes com a versao de producao', async () => {
    const list = await listAgents(t.app);
    expect(list.map((a) => a.slug).sort()).toEqual(reg.agents.map((a) => a.slug).sort());
    for (const a of list) {
      const src = srcOf(a.slug);
      const pv = productionVersion(src)!;
      expect(a.toolCount).toBe(pv.tools.length);
      expect(a.absentToolCount).toBe(0);
      expect(a.integrationCount).toBe(src.integrations.length);
      expect(a.activeVersion).toBe(pv.version);
      expect(a.warningCount).toBeGreaterThan(0); // ha tools presentes com aviso no registro
    }
  });

  it('tool desabilitada pela POLITICA nao conta como em uso; tool AUSENTE do workflow e contada a parte', async () => {
    const src = reg.agents.find((a) => productionVersion(a)!.tools.includes('cancelar_reuniao_seguro'))!;
    await t.owner.query(`UPDATE acc_agent_tools SET permission_mode='disabled' WHERE tool_id=(SELECT id FROM acc_tools WHERE code='cancelar_reuniao_seguro') AND agent_id=(SELECT id FROM acc_agents WHERE slug=$1)`, [src.slug]);
    let a = (await listAgents(t.app)).find((x) => x.slug === src.slug)!;
    expect(a.toolCount).toBe(productionVersion(src)!.tools.length - 1);
    expect(a.absentToolCount).toBe(0);

    await t.owner.query(`UPDATE acc_agent_tools SET observed_state='absent', absent_since=now() WHERE tool_id=(SELECT id FROM acc_tools WHERE code='escalar_passagem_diogo') AND agent_id=(SELECT id FROM acc_agents WHERE slug=$1)`, [src.slug]);
    a = (await listAgents(t.app)).find((x) => x.slug === src.slug)!;
    expect(a.absentToolCount).toBe(1);
    expect(a.toolCount).toBe(productionVersion(src)!.tools.length - 2);

    const d = (await getAgent(t.app, a.id))!;
    const absent = d.tools.find((x) => x.code === 'escalar_passagem_diogo')!;
    expect(absent).toMatchObject({ observedState: 'absent', permissionMode: 'enabled' }); // observado != politica
    expect(absent.absentSince).toBeTruthy();
    expect(d.tools[d.tools.length - 1].observedState).toBe('absent'); // ausentes ao final da lista
    expect(d.tools.find((x) => x.code === 'cancelar_reuniao_seguro')).toMatchObject({ observedState: 'present', permissionMode: 'disabled' });
    // restaura
    await t.owner.query(`UPDATE acc_agent_tools SET permission_mode='enabled' WHERE permission_mode='disabled'`);
    await t.owner.query(`UPDATE acc_agent_tools SET observed_state='present', absent_since=NULL WHERE observed_state='absent'`);
  });

  it('getAgent traz tools (mutaveis primeiro), integracoes, capabilities, versoes e workflows', async () => {
    const list = await listAgents(t.app);
    const sophia = list.find((a) => a.slug === 'sophia')!;
    const d = (await getAgent(t.app, sophia.id))!;
    expect(d.agent.slug).toBe('sophia');
    expect(d.agent.workflows.map((w) => w.role).sort()).toEqual(['agent', 'candidate']);
    expect(d.versions).toHaveLength(srcOf('sophia').versions.length);
    const firstReadIdx = d.tools.findIndex((x) => x.mutationLevel === 'read');
    const lastMutableIdx = d.tools.map((x) => x.mutationLevel).lastIndexOf('write');
    expect(firstReadIdx === -1 || lastMutableIdx < firstReadIdx).toBe(true);
    expect(d.tools.some((x) => x.warnings.length > 0)).toBe(true);
    expect(d.integrations.some((i) => i.required)).toBe(true);
    expect(d.integrations.every((i) => i.observedState === 'present')).toBe(true);
  });

  it('versoes: producao selada com procedencia; candidata editavel com diff de tools vs a ativa', async () => {
    const sophia = (await listAgents(t.app)).find((a) => a.slug === 'sophia')!;
    const d = (await getAgent(t.app, sophia.id))!;
    const prod = d.versions.find((v) => v.status === 'active')!;
    const cand = d.versions.find((v) => v.status === 'candidate')!;
    expect(prod).toMatchObject({ sealed: true, diffVsActive: null });
    expect(prod.configHash).toMatch(/^[0-9a-f]{64}$/);
    expect(prod.sourceRevision).toMatch(/^n8n:/);
    expect(cand.sealed).toBe(false);
    const activeTools = productionVersion(srcOf('sophia'))!.tools;
    const candTools = srcOf('sophia').versions.find((v) => v.status === 'candidate')!.tools;
    expect(cand.diffVsActive?.added).toEqual(candTools.filter((c) => !activeTools.includes(c)).sort());
    expect(cand.diffVsActive?.removed).toEqual(activeTools.filter((c) => !candTools.includes(c)).sort());
    expect(cand.diffVsActive!.added.length).toBeGreaterThan(0);
    expect(cand.diffVsActive!.removed.length).toBeGreaterThan(0);
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
