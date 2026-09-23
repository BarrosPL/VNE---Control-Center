import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRegistry, productionVersion, type Registry } from '../../src/domain/registry.ts';
import { VersionImmutableError, importRegistry } from '../../src/server/registry/importer.ts';
import { startTestDb, type TestDb } from './helpers.ts';

let t: TestDb;
const hex = (s: string) => createHash('sha256').update(s).digest('hex');
const load = () => parseRegistry(JSON.parse(readFileSync(join(__dirname, '..', '..', 'registry', 'vne.registry.json'), 'utf8')));
const n = async (sql: string, p?: unknown[]) => Number((await t.owner.query(sql, p)).rows[0].n);
const row = async (sql: string, p?: unknown[]) => (await t.owner.query(sql, p)).rows[0];

beforeAll(async () => {
  t = await startTestDb('acc-registry-');
});
afterAll(async () => {
  await t?.stop();
});

/** Importa como o role da aplicacao, em transacao (como scripts/seed-registry.mjs). */
async function run(r: Registry = load(), commit = true) {
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

/** Declara uma NOVA versao de producao (o workflow mudou): a anterior passa a deprecated no arquivo. */
function releaseNewVersion(r: Registry, slug: string, name: string, patch: { tools?: string[]; disabled?: string[] } = {}): Registry {
  const out = structuredClone(r);
  const a = out.agents.find((x) => x.slug === slug)!;
  const cur = productionVersion(a)!;
  const next = {
    ...structuredClone(cur), version: name, status: 'active' as const,
    config_hash: hex(`${name}:config`), prompt_hash: hex(`${name}:prompt`), source_revision: `test:${slug}@${name}`,
    tools: patch.tools ?? cur.tools, disabled_tools: patch.disabled ?? [],
  };
  cur.status = 'deprecated';
  a.versions.push(next);
  return parseRegistry(out);
}
const sophiaProd = (r: Registry) => productionVersion(r.agents.find((a) => a.slug === 'sophia')!)!;
const link = (agent: string, tool: string) =>
  row(`SELECT t.permission_mode, t.observed_state, t.absent_since, t.observed_source
         FROM acc_agent_tools t JOIN acc_agents a ON a.id = t.agent_id JOIN acc_tools x ON x.id = t.tool_id
        WHERE a.slug = $1 AND x.code = $2`, [agent, tool]);

describe('importacao do registro v2 (como role acc_app)', () => {
  it('preview (rollback) nao deixa nada no banco', async () => {
    const s = await run(load(), false);
    expect(s.created.agents).toBe(2);
    expect(await n('SELECT count(*)::int n FROM acc_agents')).toBe(0);
    expect(await n(`SELECT count(*)::int n FROM acc_audit_log WHERE action LIKE 'AGENT%' OR action = 'REGISTRY_IMPORTED'`)).toBe(0);
  });

  it('primeira importacao cria tudo, sela a versao de producao e deixa a candidata solta', async () => {
    const r = load();
    const s = await run(r);
    const prodTools = r.agents.reduce((acc, a) => acc + productionVersion(a)!.tools.length, 0);
    expect(s.created).toMatchObject({
      integrations: r.integrations.length, capabilities: r.capabilities.length, tools: r.tools.length,
      agents: r.agents.length, versions: r.agents.reduce((acc, a) => acc + a.versions.length, 0),
      agent_tools: prodTools, agent_capabilities: r.agents.reduce((acc, a) => acc + a.capabilities.length, 0),
    });
    // producao ativa => selada; candidata (nunca usada) => editavel
    expect(await n(`SELECT count(*)::int n FROM acc_agent_versions WHERE status='active' AND sealed_at IS NOT NULL`)).toBe(r.agents.length);
    expect(await n(`SELECT count(*)::int n FROM acc_agent_versions WHERE status='candidate' AND sealed_at IS NULL`)).toBe(1);
    // procedencia gravada
    const v = await row(`SELECT config_hash, source_revision, config_snapshot FROM acc_agent_versions WHERE version='baseline-2026-09-23' AND agent_id=(SELECT id FROM acc_agents WHERE slug='sophia')`);
    expect(v.config_hash).toBe(sophiaProd(r).config_hash);
    expect(v.source_revision).toBe(sophiaProd(r).source_revision);
    expect(v.config_snapshot.tools).toEqual([...sophiaProd(r).tools].sort());
    expect(JSON.stringify(v.config_snapshot)).not.toMatch(/systemMessage|prompt_content/);
    // tools observadas na producao ficam 'present'; as exclusivas do candidato NAO sao vinculadas
    expect(await n(`SELECT count(*)::int n FROM acc_agent_tools WHERE observed_state <> 'present'`)).toBe(0);
    expect(await n(`SELECT count(*)::int n FROM acc_agent_integrations WHERE observed_state <> 'present'`)).toBe(0);
    expect(await link('sophia', 'salvar_plano_recomendado')).toBeUndefined();
    expect(await n(`SELECT count(*)::int n FROM acc_audit_log WHERE action='AGENT_VERSION_REGISTERED'`)).toBe(3);
    expect(await n(`SELECT count(*)::int n FROM acc_audit_log WHERE action='REGISTRY_IMPORTED'`)).toBe(1);
  });

  it('agentes compartilham tools: uma linha em acc_tools, varias em acc_agent_tools', async () => {
    expect(await n(`SELECT count(*)::int n FROM (SELECT tool_id FROM acc_agent_tools GROUP BY 1 HAVING count(*) > 1) x`)).toBeGreaterThan(0);
    expect(await n('SELECT count(*)::int n FROM acc_tools')).toBe(load().tools.length);
  });

  it('segunda importacao e idempotente: nada muda, nada e auditado', async () => {
    const auditBefore = await n('SELECT count(*)::int n FROM acc_audit_log');
    const s = await run();
    expect(Object.values(s.created).every((v) => v === 0)).toBe(true);
    expect(Object.values(s.updated).every((v) => v === 0)).toBe(true);
    expect(s.observation.changes).toEqual([]);
    expect(await n('SELECT count(*)::int n FROM acc_audit_log')).toBe(auditBefore);
  });

  it('NAO sobrescreve estados de CONTROLE (agente, tool, integracao, versao)', async () => {
    await t.owner.query(`UPDATE acc_agents SET operational_mode='paused', status='draft' WHERE slug='sophia'`);
    await t.owner.query(`UPDATE acc_agent_tools SET permission_mode='approval_required' WHERE tool_id=(SELECT id FROM acc_tools WHERE code='cancelar_reuniao_seguro')`);
    await t.owner.query(`UPDATE acc_integrations SET status='degraded' WHERE code='kommo'`);
    await run();
    expect(await row(`SELECT operational_mode, status FROM acc_agents WHERE slug='sophia'`)).toEqual({ operational_mode: 'paused', status: 'draft' });
    expect((await link('sophia', 'cancelar_reuniao_seguro')).permission_mode).toBe('approval_required');
    expect((await row(`SELECT status FROM acc_integrations WHERE code='kommo'`)).status).toBe('degraded');
  });
});

describe('estado OBSERVADO x politica do Control Center', () => {
  it('tool retirada do workflow vira observed_state=absent SEM apagar o vinculo nem a politica', async () => {
    const r = load();
    const keep = sophiaProd(r).tools.filter((c) => c !== 'escalar_passagem_diogo' && c !== 'cancelar_reuniao_seguro');
    const s = await run(releaseNewVersion(r, 'sophia', 'v2', { tools: keep }));
    const gone = await link('sophia', 'escalar_passagem_diogo');
    expect(gone).toMatchObject({ observed_state: 'absent', permission_mode: 'enabled', observed_source: 'test:sophia@v2' });
    expect(gone.absent_since).toBeTruthy();
    // a politica definida pelo Control Center (approval_required) sobrevive a ausencia
    expect(await link('sophia', 'cancelar_reuniao_seguro')).toMatchObject({ observed_state: 'absent', permission_mode: 'approval_required' });
    expect(s.observation.changes.filter((c) => c.to === 'absent').map((c) => c.code).sort()).toEqual(['cancelar_reuniao_seguro', 'escalar_passagem_diogo']);
    // historico/vinculo preservados: nada foi apagado
    expect(await n(`SELECT count(*)::int n FROM acc_agent_tools WHERE agent_id=(SELECT id FROM acc_agents WHERE slug='sophia')`)).toBe(14);
    expect(await n(`SELECT count(*)::int n FROM acc_audit_log WHERE action='TOOL_OBSERVATION_CHANGED'`)).toBe(2);
    // a versao anterior foi deprecada e permanece IMUTAVEL (mesma configuracao registrada)
    expect(s.versions.deprecated).toEqual(['sophia/production/baseline-2026-09-23']);
    expect((await row(`SELECT status, config_hash FROM acc_agent_versions WHERE version='baseline-2026-09-23' AND agent_id=(SELECT id FROM acc_agents WHERE slug='sophia')`)).config_hash).toBe(sophiaProd(r).config_hash);
  });

  it('a tool volta ao workflow: present de novo, absent_since limpo, politica intacta', async () => {
    const r = load();
    const back = sophiaProd(r).tools.filter((c) => c !== 'escalar_passagem_diogo'); // cancelar_reuniao volta
    await run(releaseNewVersion(load(), 'sophia', 'v3', { tools: back }));
    expect(await link('sophia', 'cancelar_reuniao_seguro')).toMatchObject({ observed_state: 'present', absent_since: null, permission_mode: 'approval_required' });
    expect((await link('sophia', 'escalar_passagem_diogo')).observed_state).toBe('absent');
  });

  it('tool desabilitada no workflow => disabled_in_workflow (politica inalterada)', async () => {
    const r = load();
    const tools = sophiaProd(r).tools.filter((c) => c !== 'consultar_agenda' && c !== 'escalar_passagem_diogo');
    await run(releaseNewVersion(load(), 'sophia', 'v4', { tools, disabled: ['consultar_agenda'] }));
    expect(await link('sophia', 'consultar_agenda')).toMatchObject({ observed_state: 'disabled_in_workflow', permission_mode: 'enabled' });
  });

  it('tool NOVA no workflow ganha vinculo com politica inicial coerente e nao afeta as demais', async () => {
    const r = load();
    const tools = [...sophiaProd(r).tools.filter((c) => c !== 'escalar_passagem_diogo' && c !== 'consultar_agenda'), 'salvar_plano_recomendado'];
    await run(releaseNewVersion(load(), 'sophia', 'v5', { tools }));
    expect(await link('sophia', 'salvar_plano_recomendado')).toMatchObject({ observed_state: 'present', permission_mode: 'enabled' });
    expect((await link('sophia', 'consultar_agenda')).observed_state).toBe('absent');
  });

  it('o BANCO impede alterar estado observado e politica no mesmo UPDATE (defesa em profundidade)', async () => {
    await expect(
      t.owner.query(`UPDATE acc_agent_tools SET observed_state='absent', absent_since=now(), permission_mode='disabled'
                      WHERE tool_id=(SELECT id FROM acc_tools WHERE code='preencher_nome_lead') AND agent_id=(SELECT id FROM acc_agents WHERE slug='higor')`),
    ).rejects.toMatchObject({ code: '23001' });
    // separados, cada um e permitido
    await t.owner.query(`UPDATE acc_agent_tools SET permission_mode='read_only' WHERE tool_id=(SELECT id FROM acc_tools WHERE code='preencher_nome_lead') AND agent_id=(SELECT id FROM acc_agents WHERE slug='higor')`);
    await t.owner.query(`UPDATE acc_agent_tools SET permission_mode='enabled' WHERE tool_id=(SELECT id FROM acc_tools WHERE code='preencher_nome_lead') AND agent_id=(SELECT id FROM acc_agents WHERE slug='higor')`);
  });

  it('integracao que deixa de ser observada vira absent (politica de criticidade intacta)', async () => {
    const r = load();
    const higor = r.agents.find((a) => a.slug === 'higor')!;
    const p = productionVersion(higor)!;
    const next = releaseNewVersion(r, 'higor', 'v2', {
      tools: p.tools.filter((c) => c !== 'consultar_agenda'),
    });
    productionVersion(next.agents.find((a) => a.slug === 'higor')!)!.integrations = p.integrations.filter((i) => i !== 'google_calendar');
    const s = await run(parseRegistry(next));
    expect(s.observation.changes).toContainEqual({ agent: 'higor', kind: 'integration', code: 'google_calendar', from: 'present', to: 'absent' });
    expect(await row(`SELECT observed_state, criticality, required FROM acc_agent_integrations WHERE agent_id=(SELECT id FROM acc_agents WHERE slug='higor') AND integration_id=(SELECT id FROM acc_integrations WHERE code='google_calendar')`))
      .toMatchObject({ observed_state: 'absent', criticality: 'high', required: false });
  });
});

describe('versoes: procedencia e imutabilidade', () => {
  it('versao selada NAO pode ser reescrita pelo importador (configuracao mudou => nova versao)', async () => {
    const r = load();
    const bad = structuredClone(r);
    const v = bad.agents[1].versions.find((x) => x.version === 'baseline-2026-09-23')!; // higor baseline (selada)
    v.config_hash = hex('config-alterada-silenciosamente');
    await expect(run(parseRegistry(bad))).rejects.toBeInstanceOf(VersionImmutableError);
    await expect(run(parseRegistry(bad))).rejects.toMatchObject({ code: 'VERSION_IMMUTABLE' });
    // e atomico: o hash original continua no banco
    expect((await row(`SELECT config_hash FROM acc_agent_versions WHERE version='baseline-2026-09-23' AND agent_id=(SELECT id FROM acc_agents WHERE slug='higor')`)).config_hash)
      .toBe(r.agents[1].versions.find((x) => x.version === 'baseline-2026-09-23')!.config_hash);
  });

  it('o BANCO tambem impede reescrever/remover versao selada, mesmo para o dono', async () => {
    const id = (await row(`SELECT id FROM acc_agent_versions WHERE version='baseline-2026-09-23' AND agent_id=(SELECT id FROM acc_agents WHERE slug='higor')`)).id;
    for (const sql of [
      `UPDATE acc_agent_versions SET model_name='outro' WHERE id=$1`,
      `UPDATE acc_agent_versions SET prompt_hash='x' WHERE id=$1`,
      `UPDATE acc_agent_versions SET workflow_external_id='x' WHERE id=$1`,
      `UPDATE acc_agent_versions SET config_hash='${'0'.repeat(64)}' WHERE id=$1`,
      `UPDATE acc_agent_versions SET source_revision='x' WHERE id=$1`,
      `UPDATE acc_agent_versions SET changelog='reescrito' WHERE id=$1`,
      `UPDATE acc_agent_versions SET sealed_at=NULL WHERE id=$1`,
      `UPDATE acc_agent_versions SET status='draft' WHERE id=$1`,
      `DELETE FROM acc_agent_versions WHERE id=$1`,
    ]) await expect(t.owner.query(sql, [id]), sql).rejects.toMatchObject({ code: '23001' });
    // rollback legitimo: com OUTRA versao ativa, reativar a antiga e barrado pelo indice unico...
    const agentId = (await row(`SELECT agent_id FROM acc_agent_versions WHERE id=$1`, [id])).agent_id;
    await expect(t.owner.query(`UPDATE acc_agent_versions SET status='active' WHERE id=$1`, [id])).rejects.toMatchObject({ code: '23505' });
    // ...entao primeiro se depreca a atual e depois se reativa a antiga (mesma configuracao imutavel)
    const current = (await row(`SELECT id FROM acc_agent_versions WHERE agent_id=$1 AND status='active'`, [agentId])).id;
    await t.owner.query(`UPDATE acc_agent_versions SET status='deprecated' WHERE id=$1`, [current]);
    await t.owner.query(`UPDATE acc_agent_versions SET status='active' WHERE id=$1`, [id]);
    // restaura o estado para os cenarios seguintes
    await t.owner.query(`UPDATE acc_agent_versions SET status='deprecated' WHERE id=$1`, [id]);
    await t.owner.query(`UPDATE acc_agent_versions SET status='active' WHERE id=$1`, [current]);
    // ciclo de vida: archived e definitivo (nao volta)
    await t.owner.query(`UPDATE acc_agent_versions SET status='archived' WHERE id=$1`, [id]);
    await expect(t.owner.query(`UPDATE acc_agent_versions SET status='active' WHERE id=$1`, [id])).rejects.toMatchObject({ code: '23001' });
  });

  it('versao LEGADA (sem procedencia) tem a procedencia completada UMA vez; depois e imutavel', async () => {
    const org = (await row(`SELECT id FROM acc_organizations WHERE slug='vne'`)).id;
    const base = load();
    const src = structuredClone(base.agents.find((a) => a.slug === 'higor')!);
    src.slug = 'legado';
    src.name = 'Legado';
    src.versions = [{ ...productionVersion(src)!, version: 'baseline-legado', config_hash: hex('legado:config'), source_revision: 'test:legado' }];
    const pv = src.versions[0];
    const aid = (await t.owner.query(
      `INSERT INTO acc_agents (organization_id, slug, name, agent_type) VALUES ($1,'legado','Legado','x') RETURNING id`, [org])).rows[0].id;
    await t.owner.query(
      `INSERT INTO acc_agent_versions (agent_id, version, environment, status, model_provider, model_name, workflow_external_id)
       VALUES ($1,'baseline-legado','production','active',$2,$3,$4)`,
      [aid, pv.model_provider, pv.model_name, pv.workflow_external_id]);
    expect((await row(`SELECT sealed_at FROM acc_agent_versions WHERE version='baseline-legado'`)).sealed_at).toBeTruthy(); // ativa => selada
    const withLegacy: Registry = { ...base, agents: [...base.agents, src] };

    const s = await run(parseRegistry(withLegacy));
    expect(s.versions.provenanceRecorded).toEqual(['legado/production/baseline-legado']);
    expect((await row(`SELECT config_hash FROM acc_agent_versions WHERE version='baseline-legado'`)).config_hash).toBe(pv.config_hash);
    expect(await n(`SELECT count(*)::int n FROM acc_audit_log WHERE action='AGENT_VERSION_PROVENANCE_RECORDED'`)).toBe(1);

    // segunda vez com hash diferente: recusado (a procedencia ja foi registrada)
    const tampered = structuredClone(withLegacy);
    tampered.agents[2].versions[0].config_hash = hex('outro');
    await expect(run(parseRegistry(tampered))).rejects.toBeInstanceOf(VersionImmutableError);
  });

  it('versao legada com configuracao INCONSISTENTE (modelo diferente) e recusada', async () => {
    const org = (await row(`SELECT id FROM acc_organizations WHERE slug='vne'`)).id;
    const base = load();
    const src = structuredClone(base.agents.find((a) => a.slug === 'higor')!);
    src.slug = 'legado2';
    src.name = 'Legado 2';
    src.versions = [{ ...productionVersion(src)!, version: 'b', config_hash: hex('l2:config'), source_revision: 'test:l2', model_name: 'modelo-declarado' }];
    const aid = (await t.owner.query(`INSERT INTO acc_agents (organization_id, slug, name, agent_type) VALUES ($1,'legado2','Legado 2','x') RETURNING id`, [org])).rows[0].id;
    await t.owner.query(`INSERT INTO acc_agent_versions (agent_id, version, environment, status, model_name, workflow_external_id) VALUES ($1,'b','production','active','modelo-gravado',$2)`, [aid, src.versions[0].workflow_external_id]);
    await expect(run(parseRegistry({ ...base, agents: [...base.agents, src] }))).rejects.toThrow(/NOVA versao/);
  });

  it('a mesma configuracao nao pode ser cadastrada duas vezes no mesmo agente/ambiente (indice unico)', async () => {
    const dup = await row(`SELECT v.agent_id, v.environment, v.config_hash FROM acc_agent_versions v WHERE v.version='baseline-2026-09-23' LIMIT 1`);
    await expect(
      t.owner.query(`INSERT INTO acc_agent_versions (agent_id, version, environment, status, config_hash) VALUES ($1,'copia',$2,'draft',$3)`, [dup.agent_id, dup.environment, dup.config_hash]),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe('demais garantias', () => {
  it('itens ausentes do arquivo sao reportados como orfaos e NUNCA removidos', async () => {
    await t.owner.query(`INSERT INTO acc_tools (code, name, tool_type) VALUES ('tool_orfa','Orfa','http')`);
    const s = await run(load());
    expect(s.orphans.tools).toContain('tool_orfa');
    expect(await n(`SELECT count(*)::int n FROM acc_tools WHERE code='tool_orfa'`)).toBe(1);
  });

  it('falha atomica: organizacao inexistente aborta sem efeitos', async () => {
    const r = load();
    r.organization = 'inexistente';
    await expect(run(r)).rejects.toThrow(/Organizacao inexistente/);
  });

  it('o role da aplicacao nao consegue apagar nada do registro', async () => {
    for (const tbl of ['acc_agents', 'acc_tools', 'acc_agent_versions', 'acc_agent_tools']) {
      await expect(t.app.query(`DELETE FROM ${tbl}`), tbl).rejects.toMatchObject({ code: '42501' });
    }
  });
});

describe('candidata: editavel ate o primeiro uso', () => {
  it('candidata NUNCA usada pode ser atualizada e auditada; depois de usada e selada', async () => {
    const r = load();
    const cand = r.agents.find((a) => a.slug === 'sophia')!.versions.find((v) => v.status === 'candidate')!;
    // ainda editavel
    const edited = structuredClone(r);
    edited.agents.find((a) => a.slug === 'sophia')!.versions.find((v) => v.status === 'candidate')!.config_hash = hex('candidata-editada');
    const s = await run(parseRegistry(edited));
    expect(s.versions.updated).toEqual([`sophia/development/${cand.version}`]);
    expect(await n(`SELECT count(*)::int n FROM acc_audit_log WHERE action='AGENT_VERSION_UPDATED'`)).toBe(1);

    // primeiro USO (uma execucao referenciando a versao) sela
    const ids = await row(`SELECT v.id vid, a.id aid FROM acc_agent_versions v JOIN acc_agents a ON a.id=v.agent_id WHERE a.slug='sophia' AND v.status='candidate'`);
    expect((await row(`SELECT sealed_at FROM acc_agent_versions WHERE id=$1`, [ids.vid])).sealed_at).toBeNull();
    await t.app.query(
      `INSERT INTO acc_agent_runs (agent_id, agent_version_id, correlation_id, trigger_type, source) VALUES ($1,$2,'corr-1','manual','test')`,
      [ids.aid, ids.vid]);
    expect((await row(`SELECT sealed_at FROM acc_agent_versions WHERE id=$1`, [ids.vid])).sealed_at).toBeTruthy();

    const again = structuredClone(r);
    again.agents.find((a) => a.slug === 'sophia')!.versions.find((v) => v.status === 'candidate')!.config_hash = hex('depois-de-usada');
    await expect(run(parseRegistry(again))).rejects.toBeInstanceOf(VersionImmutableError);
  });
});
