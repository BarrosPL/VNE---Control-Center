import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRegistry } from '../../src/domain/registry.ts';
import { importRegistry } from '../../src/server/registry/importer.ts';
import { startTestDb, type TestDb } from './helpers.ts';

let t: TestDb;
const reg = () => parseRegistry(JSON.parse(readFileSync(join(__dirname, '..', '..', 'registry', 'vne.registry.json'), 'utf8')));
const n = async (sql: string, p?: unknown[]) => Number((await t.owner.query(sql, p)).rows[0].n);

beforeAll(async () => {
  t = await startTestDb('acc-registry-');
});
afterAll(async () => {
  await t?.stop();
});

/** Executa a importacao como o role da aplicacao, em transacao (como o script faz). */
async function run(r = reg(), commit = true) {
  await t.app.query('BEGIN');
  try {
    const s = await importRegistry(t.app, r);
    await t.app.query(commit ? 'COMMIT' : 'ROLLBACK');
    return s;
  } catch (e) {
    await t.app.query('ROLLBACK');
    throw e;
  }
}

describe('importacao do registro (como role acc_app)', () => {
  it('preview (rollback) nao deixa nada no banco', async () => {
    const s = await run(reg(), false);
    expect(s.created.agents).toBe(2);
    expect(await n('SELECT count(*)::int n FROM acc_agents')).toBe(0);
    expect(await n('SELECT count(*)::int n FROM acc_audit_log WHERE action IN (\'REGISTRY_IMPORTED\',\'AGENT_REGISTERED\')')).toBe(0);
  });

  it('primeira importacao cria tudo e audita', async () => {
    const r = reg();
    const s = await run(r);
    expect(s.created).toMatchObject({
      integrations: r.integrations.length, capabilities: r.capabilities.length, tools: r.tools.length,
      agents: r.agents.length, versions: r.agents.length,
      agent_tools: r.agents.reduce((a, x) => a + x.tools.length, 0),
      agent_capabilities: r.agents.reduce((a, x) => a + x.capabilities.length, 0),
      agent_integrations: r.agents.reduce((a, x) => a + x.integrations.length, 0),
    });
    expect(await n(`SELECT count(*)::int n FROM acc_audit_log WHERE action='AGENT_REGISTERED'`)).toBe(r.agents.length);
    expect(await n(`SELECT count(*)::int n FROM acc_audit_log WHERE action='REGISTRY_IMPORTED'`)).toBe(1);
  });

  it('agentes compartilham tools: uma linha em acc_tools, varias em acc_agent_tools', async () => {
    const shared = await n(`SELECT count(*)::int n FROM (SELECT tool_id FROM acc_agent_tools GROUP BY 1 HAVING count(*) > 1) x`);
    expect(shared).toBeGreaterThan(0);
    expect(await n('SELECT count(*)::int n FROM acc_tools')).toBe(reg().tools.length);
  });

  it('segunda importacao e idempotente: nada muda e nada e auditado', async () => {
    const auditBefore = await n('SELECT count(*)::int n FROM acc_audit_log');
    const s = await run();
    expect(Object.values(s.created).every((v) => v === 0)).toBe(true);
    expect(Object.values(s.updated).every((v) => v === 0)).toBe(true);
    expect(await n('SELECT count(*)::int n FROM acc_audit_log')).toBe(auditBefore);
  });

  it('NAO sobrescreve estados de controle definidos no Control Center', async () => {
    await t.owner.query(`UPDATE acc_agents SET operational_mode='paused', status='draft' WHERE slug='sophia'`);
    await t.owner.query(`UPDATE acc_agent_tools SET permission_mode='disabled' WHERE tool_id=(SELECT id FROM acc_tools WHERE code='cancelar_reuniao_seguro')`);
    await t.owner.query(`UPDATE acc_integrations SET status='degraded' WHERE code='kommo'`);
    await t.owner.query(`UPDATE acc_agent_versions SET status='deprecated' WHERE agent_id=(SELECT id FROM acc_agents WHERE slug='sophia')`);
    await run();
    const a = (await t.owner.query(`SELECT operational_mode, status FROM acc_agents WHERE slug='sophia'`)).rows[0];
    expect(a).toEqual({ operational_mode: 'paused', status: 'draft' });
    expect(await n(`SELECT count(*)::int n FROM acc_agent_tools WHERE permission_mode='disabled' AND tool_id=(SELECT id FROM acc_tools WHERE code='cancelar_reuniao_seguro')`)).toBeGreaterThan(0);
    expect((await t.owner.query(`SELECT status FROM acc_integrations WHERE code='kommo'`)).rows[0].status).toBe('degraded');
    expect(await n(`SELECT count(*)::int n FROM acc_agent_versions WHERE status='deprecated'`)).toBeGreaterThan(0);
  });

  it('mudanca de configuracao no arquivo e aplicada e auditada', async () => {
    const r = reg();
    r.agents[0].name = 'Nome Alterado';
    r.tools[0].risk_level = 'critical';
    const before = await n(`SELECT count(*)::int n FROM acc_audit_log WHERE action='REGISTRY_IMPORTED'`);
    const s = await run(r);
    expect(s.updated).toMatchObject({ agents: 1, tools: 1 });
    expect((await t.owner.query(`SELECT name FROM acc_agents WHERE slug=$1`, [r.agents[0].slug])).rows[0].name).toBe('Nome Alterado');
    expect(await n(`SELECT count(*)::int n FROM acc_audit_log WHERE action='REGISTRY_IMPORTED'`)).toBe(before + 1);
  });

  it('itens ausentes do arquivo sao reportados como orfaos e NUNCA removidos', async () => {
    await t.owner.query(`INSERT INTO acc_tools (code, name, tool_type) VALUES ('tool_orfa','Orfa','http')`);
    const s = await run();
    expect(s.orphans.tools).toContain('tool_orfa');
    expect(await n(`SELECT count(*)::int n FROM acc_tools WHERE code='tool_orfa'`)).toBe(1);
  });

  it('falha atomica: organizacao inexistente aborta sem efeitos', async () => {
    const r = reg();
    r.organization = 'inexistente';
    await expect(run(r)).rejects.toThrow(/Organizacao inexistente/);
  });

  it('o role da aplicacao nao consegue apagar nada do registro', async () => {
    await expect(t.app.query('DELETE FROM acc_agents')).rejects.toMatchObject({ code: '42501' });
    await expect(t.app.query('DELETE FROM acc_tools')).rejects.toMatchObject({ code: '42501' });
  });
});
