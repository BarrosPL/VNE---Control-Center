import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRegistry } from '../../src/domain/registry.ts';
import { FORBIDDEN_KEY, findForbiddenKeys, looksPersonal, parseTelemetry } from '../../src/domain/telemetry.ts';
import { importRegistry } from '../../src/server/registry/importer.ts';
import { ingestTelemetry } from '../../src/server/telemetry/ingest.ts';
import { collectN8nExecutions } from '../../src/server/telemetry/n8n-collector.ts';
import { startTestDb, type TestDb } from './helpers.ts';

let t: TestDb;
const root = join(__dirname, '..', '..');
const reg = parseRegistry(JSON.parse(readFileSync(join(root, 'registry', 'vne.registry.json'), 'utf8')));
const one = async (sql: string, p?: unknown[]) => (await t.owner.query(sql, p)).rows[0];
const ids = async () => ({ sophia: (await one(`SELECT id FROM acc_agents WHERE slug='sophia'`)).id as string });

beforeAll(async () => {
  t = await startTestDb('acc-hardening-');
  await t.app.query('BEGIN');
  await importRegistry(t.app, reg);
  await t.app.query('COMMIT');
});
afterAll(async () => {
  await t?.stop();
});

describe('1. anti-PII: banco e contrato dizem exatamente a mesma coisa', () => {
  it('a lista de chaves proibidas e IDENTICA no SQL (migration 0007) e no Zod', () => {
    const sql = readFileSync(join(root, 'migrations', '0007_agent_telemetry.up.sql'), 'utf8');
    const m = /k ~\* '(\^\([^']+\)\$)'/.exec(sql);
    expect(m, 'regex de chaves no SQL').toBeTruthy();
    expect(m![1]).toBe(FORBIDDEN_KEY.source);
  });

  const docs: [string, unknown][] = [
    ['text', { text: 'x' }], ['Text (caixa)', { Text: 'x' }], ['nested', { a: { b: [{ Prompt: 'x' }] } }],
    ['api-key', { 'api-key': 1 }], ['apikey', { apikey: 1 }], ['api_key', { api_key: 1 }], ['email', { email: 'a' }],
    ['telefone', { telefone: 1 }], ['profundo', { a: { b: { c: { d: { e: { password: 'x' } } } } } }], ['array de arrays', [[{ token: 't' }]]],
    ['message_ref ok', { message_ref: 1 }], ['emails ok', { emails: 1 }], ['context ok', { context: 1 }], ['tokens ok', { tokens: 5 }],
    ['input_tokens ok', { input_tokens: 1 }], ['phone_number ok', { phone_number: 1 }], ['vazio', {}], ['array vazio', []], ['string', 'texto'],
    ['numero', 42], ['null', null],
  ];
  it.each(docs)('funcao do banco == Zod: %s', async (_label, doc) => {
    const db = (await one(`SELECT acc_jsonb_has_forbidden_keys($1::jsonb) AS r`, [JSON.stringify(doc)])).r as boolean;
    expect(db).toBe(findForbiddenKeys(doc).length > 0);
  });

  it('o banco REJEITA chaves proibidas em events.payload, runs.metadata e sessions.metadata (mesmo sem passar pelo contrato)', async () => {
    const { sophia } = await ids();
    const org = (await one(`SELECT id FROM acc_organizations WHERE slug='vne'`)).id;
    for (const bad of [{ text: 'oi' }, { nested: { Content: 'x' } }, { l: [{ prompt: 'p' }] }, { email: 'a@b.com' }, { authorization: 'Bearer x' }]) {
      const j = JSON.stringify(bad);
      await expect(t.owner.query(`INSERT INTO acc_agent_events (event_type, agent_id, source, occurred_at, payload) VALUES ('ERROR',$1,'test',now(),$2::jsonb)`, [sophia, j]), `event ${j}`).rejects.toMatchObject({ code: '23514' });
      await expect(t.owner.query(`INSERT INTO acc_agent_runs (agent_id, correlation_id, trigger_type, source, metadata) VALUES ($1,'c','manual','test',$2::jsonb)`, [sophia, j]), `run ${j}`).rejects.toMatchObject({ code: '23514' });
      await expect(t.owner.query(`INSERT INTO acc_agent_sessions (agent_id, organization_id, entity_type, entity_id, source, metadata) VALUES ($1,$2,'lead','S','test',$3::jsonb)`, [sophia, org, j]), `session ${j}`).rejects.toMatchObject({ code: '23514' });
    }
    // referencia por id e metadados tecnicos continuam permitidos
    await t.owner.query(`INSERT INTO acc_agent_events (event_type, agent_id, source, occurred_at, payload) VALUES ('ERROR',$1,'test',now(),'{"message_ref":77,"error_code":"TIMEOUT","chars":40}'::jsonb)`, [sophia]);
  });

  const probes = ['a@b.com', 'user.name+tag@example.co.uk', 'ligue 11 91234-5678', '+55 (11) 91234-5678', '12345678901', 'cpf 123.456.789-09',
    'timeout after 30000 ms', 'HTTP 502 upstream', 'N8N_ERROR', 'exec 123456 failed', 'id 12345678', 'TOOL_ERROR: tool consultar_agenda'];
  it.each(probes)('texto livre: funcao do banco == Zod: %s', async (text) => {
    const db = (await one(`SELECT acc_text_looks_personal($1) AS r`, [text])).r as boolean;
    expect(db).toBe(looksPersonal(text));
  });

  it('o banco REJEITA e-mail/telefone em TODOS os textos livres e aceita texto tecnico', async () => {
    const { sophia } = await ids();
    const org = (await one(`SELECT id FROM acc_organizations WHERE slug='vne'`)).id;
    const run = (col: string, v: string) => t.owner.query(`INSERT INTO acc_agent_runs (agent_id, correlation_id, trigger_type, source, ${col}) VALUES ($1,'c','manual','test',$2)`, [sophia, v]);
    for (const col of ['input_summary', 'output_summary', 'error_message', 'trigger_ref']) {
      await expect(run(col, 'contato: maria@example.com'), col).rejects.toMatchObject({ code: '23514' });
      await expect(run(col, 'telefone +55 11 91234 5678'), col).rejects.toMatchObject({ code: '23514' });
      await run(col, 'timeout after 30000 ms'); // tecnico: ok
    }
    await expect(t.owner.query(`INSERT INTO acc_agent_sessions (agent_id, organization_id, entity_type, entity_id, source, status, ended_at, end_reason) VALUES ($1,$2,'lead','E','test','ended',now(),'cliente joao@x.com')`, [sophia, org])).rejects.toMatchObject({ code: '23514' });
  });
});

describe('1b. coleta Nivel A: nenhum texto livre (imposto no contrato E no banco)', () => {
  const base = (over: Record<string, unknown> = {}) => ({
    schema_version: 1, organization: 'vne', source: 'n8n.collector', agent: 'sophia', correlation_id: 'n8n:1',
    run: { key: 'n8n:1', trigger_type: 'webhook', started_at: new Date(Date.now() - 60_000).toISOString() }, ...over,
  });
  const withRun = (r: Record<string, unknown>) => base({ run: { key: 'n8n:1', trigger_type: 'webhook', started_at: new Date(Date.now() - 60_000).toISOString(), ...r } });

  it('contrato: source n8n.collector rejeita input_summary, output_summary e error.message', () => {
    expect(() => parseTelemetry(withRun({ input_summary: 'resumo' }))).toThrow(/Nivel A/);
    expect(() => parseTelemetry(withRun({ output_summary: 'resumo' }))).toThrow(/Nivel A/);
    expect(() => parseTelemetry(withRun({ status: 'failed', completed_at: new Date().toISOString(), error: { code: 'X', message: 'tecnica' } }))).toThrow(/Nivel A/);
    expect(parseTelemetry(withRun({ status: 'failed', completed_at: new Date().toISOString(), error: { code: 'N8N_ERROR' } })).run.error?.code).toBe('N8N_ERROR');
    // outras fontes (futuras, com politica) podem enviar resumos SEM dado pessoal
    expect(parseTelemetry(base({ source: 'n8n.emitter', run: { key: 'k', trigger_type: 'webhook', started_at: new Date(Date.now() - 1000).toISOString(), input_summary: 'msg de 40 caracteres' } })).run.input_summary).toBeTruthy();
  });

  it('contrato: dado pessoal em resumo/error.message/trigger_ref e rejeitado para qualquer fonte', () => {
    const other = (r: Record<string, unknown>) => base({ source: 'n8n.emitter', run: { key: 'k', trigger_type: 'webhook', started_at: new Date(Date.now() - 1000).toISOString(), ...r } });
    expect(() => parseTelemetry(other({ input_summary: 'fale com a@b.com' }))).toThrow(/dado pessoal/);
    expect(() => parseTelemetry(other({ output_summary: 'ligar 11 91234-5678' }))).toThrow(/dado pessoal/);
    expect(() => parseTelemetry(other({ trigger_ref: 'cliente@x.com' }))).toThrow(/dado pessoal/);
    expect(() => parseTelemetry(other({ status: 'failed', completed_at: new Date().toISOString(), error: { code: 'X', message: 'falhou para a@b.com' } }))).toThrow(/dado pessoal/);
  });

  it('banco: run com source n8n.collector NAO aceita resumos nem error_message (mesmo contornando o contrato)', async () => {
    const { sophia } = await ids();
    for (const src of ['n8n.collector', 'n8n.collector.v2']) {
      for (const col of ['input_summary', 'output_summary', 'error_message']) {
        await expect(t.owner.query(`INSERT INTO acc_agent_runs (agent_id, correlation_id, trigger_type, source, ${col}) VALUES ($1,'c','webhook',$2,'texto tecnico')`, [sophia, src]), `${src}.${col}`)
          .rejects.toMatchObject({ code: '23514' });
      }
      await t.owner.query(`INSERT INTO acc_agent_runs (agent_id, correlation_id, trigger_type, source, error_code) VALUES ($1,'c','webhook',$2,'N8N_ERROR')`, [sophia, src]); // so codigo: ok
    }
    await t.owner.query(`INSERT INTO acc_agent_runs (agent_id, correlation_id, trigger_type, source, input_summary) VALUES ($1,'c','webhook','n8n.emitter','resumo tecnico')`, [sophia]); // outra fonte: ok
  });

  it('coletor real: toda run coletada tem resumos e error_message NULOS e so o codigo do erro', async () => {
    await t.owner.query(`CREATE TABLE execution_entity (id int PRIMARY KEY, finished boolean NOT NULL DEFAULT false, mode varchar NOT NULL,
      "startedAt" timestamptz, "stoppedAt" timestamptz, status varchar NOT NULL, "workflowId" varchar NOT NULL, "deletedAt" timestamptz, "workflowVersionId" varchar)`);
    const wf = reg.agents.find((a) => a.slug === 'sophia')!.versions.find((v) => v.status === 'active')!.workflow_external_id!;
    await t.owner.query(`INSERT INTO execution_entity (id, mode, "startedAt", "stoppedAt", status, "workflowId") VALUES
      (1,'webhook', now() - interval '30 minutes', now() - interval '29 minutes', 'error', $1),
      (2,'webhook', now() - interval '20 minutes', now() - interval '19 minutes', 'success', $1),
      (3,'webhook', now() - interval '10 minutes', now() - interval '9 minutes', 'crashed', $1)`, [wf]);
    await t.app.query('BEGIN');
    await collectN8nExecutions({ query: (s, p) => t.owner.query(s, p) as never }, t.app, { organization: 'vne', since: new Date(Date.now() - 3600_000) });
    await t.app.query('COMMIT');
    const rows = (await t.owner.query(`SELECT run_key, status, error_code, error_message, input_summary, output_summary, source FROM acc_agent_runs WHERE run_key LIKE 'n8n:%' ORDER BY run_key`)).rows;
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.source).toBe('n8n.collector');
      expect(r.input_summary).toBeNull();
      expect(r.output_summary).toBeNull();
      expect(r.error_message).toBeNull();
    }
    expect(rows.find((r) => r.run_key === 'n8n:1')).toMatchObject({ status: 'failed', error_code: 'N8N_ERROR' });
    expect(rows.find((r) => r.run_key === 'n8n:3')).toMatchObject({ status: 'failed', error_code: 'N8N_CRASHED' });
  });

  it('ingestao via servico tambem respeita as regras (contrato antes do banco)', async () => {
    const env = parseTelemetry({ ...base({ source: 'n8n.emitter' }), run: { key: 'ok-1', trigger_type: 'webhook', started_at: new Date(Date.now() - 1000).toISOString(), input_summary: 'resumo tecnico' } });
    await t.app.query('BEGIN');
    const r = await ingestTelemetry(t.app, env);
    await t.app.query('COMMIT');
    expect(r.runCreated).toBe(true);
  });
});

describe('2. observacao x politica: guardas equivalentes em tools E integracoes', () => {
  const toolRow = (col: string, val: string, extra = '') =>
    t.owner.query(`UPDATE acc_agent_tools SET ${col} = ${val} ${extra} WHERE agent_id=(SELECT id FROM acc_agents WHERE slug='higor') AND tool_id=(SELECT id FROM acc_tools WHERE code='preencher_nome_lead')`);
  const intRow = (sets: string) =>
    t.owner.query(`UPDATE acc_agent_integrations SET ${sets} WHERE agent_id=(SELECT id FROM acc_agents WHERE slug='higor') AND integration_id=(SELECT id FROM acc_integrations WHERE code='google_calendar')`);

  // cada coluna de observacao x cada coluna de politica, na MESMA instrucao
  const OBS_SETS_TOOL = [`observed_source = 'x'`, `observed_at = now() - interval '1 day'`, `observed_state = 'disabled_in_workflow'`, `observed_state = 'absent', absent_since = now()`];
  const POL_SETS_TOOL = [`permission_mode = 'read_only'`, `approval_required = NOT approval_required`, `configuration = '{"k":1}'::jsonb`];
  for (const o of OBS_SETS_TOOL) {
    for (const p of POL_SETS_TOOL) {
      it(`tools: {${o}} + {${p}} no mesmo UPDATE => rejeitado`, async () => {
        await expect(t.owner.query(`UPDATE acc_agent_tools SET ${o}, ${p} WHERE agent_id=(SELECT id FROM acc_agents WHERE slug='higor') AND tool_id=(SELECT id FROM acc_tools WHERE code='preencher_nome_lead')`)).rejects.toMatchObject({ code: '23001' });
      });
    }
  }

  it('tools: cada grupo isoladamente e permitido (incluindo observed_at/observed_source sozinhos)', async () => {
    await toolRow('observed_source', `'nova-revisao'`);
    await toolRow('observed_at', `now()`);
    await toolRow('permission_mode', `'read_only'`);
    await toolRow('approval_required', `true`);
    await toolRow('configuration', `'{"k":2}'::jsonb`);
    await toolRow('permission_mode', `'enabled'`, `, approval_required = false, configuration = '{}'::jsonb`);
    await toolRow('observed_state', `'absent'`, `, absent_since = now()`);
    await toolRow('observed_state', `'present'`, `, absent_since = NULL`);
  });

  const OBS_SETS_INT = [`observed_source = 'x'`, `observed_at = now() - interval '1 day'`, `observed_state = 'disabled_in_workflow'`, `observed_state = 'absent', absent_since = now()`];
  const POL_SETS_INT = [`criticality = 'low'`, `required = NOT required`, `configuration = '{"k":1}'::jsonb`];
  for (const o of OBS_SETS_INT) {
    for (const p of POL_SETS_INT) {
      it(`integracoes: {${o}} + {${p}} no mesmo UPDATE => rejeitado`, async () => {
        await expect(intRow(`${o}, ${p}`)).rejects.toMatchObject({ code: '23001' });
      });
    }
  }

  it('integracoes: cada grupo isoladamente e permitido', async () => {
    await intRow(`observed_source = 'nova-revisao'`);
    await intRow(`observed_at = now()`);
    await intRow(`criticality = 'critical'`);
    await intRow(`required = true`);
    await intRow(`configuration = '{"k":2}'::jsonb`);
    await intRow(`criticality = 'high', required = false, configuration = '{}'::jsonb`);
    await intRow(`observed_state = 'absent', absent_since = now()`);
    await intRow(`observed_state = 'present', absent_since = NULL`);
  });

  it('INSERT (criacao do vinculo) continua podendo definir observacao e politica juntas', async () => {
    const agent = (await one(`SELECT id FROM acc_agents WHERE slug='sophia'`)).id;
    const tool = (await one(`INSERT INTO acc_tools (code, name, tool_type) VALUES ('tool_guard_insert','G','http') RETURNING id`)).id;
    await t.owner.query(`INSERT INTO acc_agent_tools (agent_id, tool_id, permission_mode, observed_state, observed_source) VALUES ($1,$2,'enabled','present','rev')`, [agent, tool]);
  });
});
