import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRegistry, productionVersion } from '../../src/domain/registry.ts';
import { parseTelemetry } from '../../src/domain/telemetry.ts';
import type { Queryable } from '../../src/server/auth/db.ts';
import { getTelemetryOverview, listEvents, listRuns, listSessions } from '../../src/server/queries/telemetry.ts';
import { importRegistry } from '../../src/server/registry/importer.ts';
import { TelemetryError, endSession, expireIdleSessions, ingestTelemetry } from '../../src/server/telemetry/ingest.ts';
import { collectN8nExecutions } from '../../src/server/telemetry/n8n-collector.ts';
import { startTestDb, type TestDb } from './helpers.ts';

let t: TestDb;
const reg = parseRegistry(JSON.parse(readFileSync(join(__dirname, '..', '..', 'registry', 'vne.registry.json'), 'utf8')));
const sophia = reg.agents.find((a) => a.slug === 'sophia')!;
const prod = productionVersion(sophia)!;
const min = 60_000;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const n = async (sql: string, p?: unknown[]) => Number((await t.owner.query(sql, p)).rows[0].n);
const row = async (sql: string, p?: unknown[]) => (await t.owner.query(sql, p)).rows[0];
let seq = 0;
const env = (over: Record<string, unknown> = {}) =>
  parseTelemetry({
    schema_version: 1, organization: 'vne', source: 'test', agent: 'sophia', correlation_id: `corr-${++seq}`,
    entity: { type: 'lead', id: '1001', lead_id: 1001 }, session: { start: true },
    version: { config_hash: prod.config_hash },
    run: { key: `run-${seq}`, trigger_type: 'message', started_at: at(-5 * min) },
    events: [], ...over,
  });
async function ingest(e = env(), db: Queryable = t.app) {
  await t.app.query('BEGIN');
  try {
    const r = await ingestTelemetry(db, e);
    await t.app.query('COMMIT');
    return r;
  } catch (err) {
    await t.app.query('ROLLBACK');
    throw err;
  }
}
const ids = async () => ({
  sophia: (await row(`SELECT id FROM acc_agents WHERE slug='sophia'`)).id as string,
  higor: (await row(`SELECT id FROM acc_agents WHERE slug='higor'`)).id as string,
  org: (await row(`SELECT id FROM acc_organizations WHERE slug='vne'`)).id as string,
});

beforeAll(async () => {
  t = await startTestDb('acc-telemetry-');
  await t.app.query('BEGIN');
  await importRegistry(t.app, reg);
  await t.app.query('COMMIT');
});
afterAll(async () => {
  await t?.stop();
});

describe('esquema: taxonomia e permissoes', () => {
  it('taxonomia inicial semeada com os 10 tipos; a aplicacao so le (mudar = migration)', async () => {
    const codes = (await t.owner.query(`SELECT code FROM acc_event_types ORDER BY code`)).rows.map((r) => r.code);
    expect(codes).toEqual(['ERROR', 'HUMAN_REQUESTED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT', 'RUN_FAILED', 'RUN_STARTED', 'RUN_SUCCEEDED', 'TOOL_CALLED', 'TOOL_FAILED', 'TOOL_SUCCEEDED']);
    await expect(t.app.query(`INSERT INTO acc_event_types (code, category, description) VALUES ('NOVO_TIPO','run','x')`)).rejects.toMatchObject({ code: '42501' });
    const { sophia } = await ids();
    await expect(t.owner.query(`INSERT INTO acc_agent_events (event_type, agent_id, source, occurred_at) VALUES ('TEXTO_LIVRE',$1,'test',now())`, [sophia])).rejects.toMatchObject({ code: '23503' });
  });

  it('privilegios da aplicacao: le/insere; eventos append-only; sem DELETE', async () => {
    await expect(t.app.query(`UPDATE acc_agent_events SET level='info'`)).rejects.toMatchObject({ code: '42501' });
    await expect(t.app.query(`DELETE FROM acc_agent_events`)).rejects.toMatchObject({ code: '42501' });
    await expect(t.app.query(`DELETE FROM acc_agent_runs`)).rejects.toMatchObject({ code: '42501' });
    await expect(t.app.query(`DELETE FROM acc_agent_sessions`)).rejects.toMatchObject({ code: '42501' });
  });
});

describe('esquema: sessoes', () => {
  it('uma sessao ATIVA por agente+entidade; encerrada libera nova; checks de estado', async () => {
    const { sophia, org } = await ids();
    const ins = (status = 'active', ended = 'NULL') =>
      t.owner.query(`INSERT INTO acc_agent_sessions (agent_id, organization_id, entity_type, entity_id, source, status, ended_at) VALUES ($1,$2,'lead','S1','test','${status}',${ended})`, [sophia, org]);
    await ins();
    await expect(ins()).rejects.toMatchObject({ code: '23505' });
    await expect(ins('ended')).rejects.toMatchObject({ code: '23514' }); // ended sem ended_at
    await expect(ins('active', 'now()')).rejects.toMatchObject({ code: '23514' }); // active com ended_at
    await t.owner.query(`UPDATE acc_agent_sessions SET status='ended', ended_at=now() WHERE entity_id='S1'`);
    await ins(); // agora pode
  });

  it('agente e organizacao precisam ser coerentes (FK composta) e entity_type valido', async () => {
    const { sophia } = await ids();
    const org2 = (await t.owner.query(`INSERT INTO acc_organizations (slug, name) VALUES ('outra','Outra') RETURNING id`)).rows[0].id;
    await expect(t.owner.query(`INSERT INTO acc_agent_sessions (agent_id, organization_id, entity_type, entity_id, source) VALUES ($1,$2,'lead','X','test')`, [sophia, org2])).rejects.toMatchObject({ code: '23503' });
    const { org } = await ids();
    await expect(t.owner.query(`INSERT INTO acc_agent_sessions (agent_id, organization_id, entity_type, entity_id, source) VALUES ($1,$2,'Lead Ruim','X','test')`, [sophia, org])).rejects.toMatchObject({ code: '23514' });
  });
});

describe('esquema: runs', () => {
  const insRun = (agent: string, key: string | null, extra = '') =>
    t.owner.query(`INSERT INTO acc_agent_runs (agent_id, correlation_id, run_key, trigger_type, source ${extra ? ', ' + extra.split('|')[0] : ''}) VALUES ($1,'c',$2,'manual','test' ${extra ? ', ' + extra.split('|')[1] : ''}) RETURNING id`, [agent, key]);

  it('run_key e unico por agente (idempotencia); sem chave nao ha limite', async () => {
    const { sophia, higor } = await ids();
    await insRun(sophia, 'K1');
    await expect(insRun(sophia, 'K1')).rejects.toMatchObject({ code: '23505' });
    await insRun(higor, 'K1'); // outro agente pode reutilizar a chave
    await insRun(sophia, null);
    await insRun(sophia, null);
  });

  it('estado e conclusao consistentes; resumos e metadata limitados (sem blobs)', async () => {
    const { sophia } = await ids();
    await expect(insRun(sophia, 'K2', `status|'succeeded'`)).rejects.toMatchObject({ code: '23514' }); // terminal sem completed_at
    await expect(insRun(sophia, 'K3', `input_summary|'${'x'.repeat(2001)}'`)).rejects.toMatchObject({ code: '23514' });
    await expect(insRun(sophia, 'K4', `error_message|'${'x'.repeat(1001)}'`)).rejects.toMatchObject({ code: '23514' });
    await expect(insRun(sophia, 'K5', `metadata|'{"b":"${'x'.repeat(17000)}"}'::jsonb`)).rejects.toMatchObject({ code: '23514' });
    await expect(insRun(sophia, 'K6', `input_tokens|-1`)).rejects.toMatchObject({ code: '23514' });
    await expect(insRun(sophia, 'K7', `entity_type|'lead'`)).rejects.toMatchObject({ code: '23514' }); // entity_type sem entity_id
  });

  it('estado terminal e FINAL; identidade imutavel; duration_ms calculado pelo banco', async () => {
    const { sophia } = await ids();
    const id = (await insRun(sophia, 'K8')).rows[0].id;
    await expect(t.owner.query(`UPDATE acc_agent_runs SET correlation_id='outra' WHERE id=$1`, [id])).rejects.toMatchObject({ code: '23001' });
    await expect(t.owner.query(`UPDATE acc_agent_runs SET run_key='trocada' WHERE id=$1`, [id])).rejects.toMatchObject({ code: '23001' });
    await t.owner.query(`UPDATE acc_agent_runs SET status='succeeded', completed_at = started_at + interval '2.5 seconds' WHERE id=$1`, [id]);
    expect((await row(`SELECT duration_ms FROM acc_agent_runs WHERE id=$1`, [id])).duration_ms).toBe(2500);
    await expect(t.owner.query(`UPDATE acc_agent_runs SET status='failed' WHERE id=$1`, [id])).rejects.toMatchObject({ code: '23001' });
    await expect(t.owner.query(`UPDATE acc_agent_runs SET output_summary='x' WHERE id=$1`, [id])).rejects.toMatchObject({ code: '23001' });
  });

  it('a sessao de uma run precisa ser do MESMO agente (FK composta)', async () => {
    const { sophia, higor, org } = await ids();
    const sid = (await t.owner.query(`INSERT INTO acc_agent_sessions (agent_id, organization_id, entity_type, entity_id, source) VALUES ($1,$2,'lead','H1','test') RETURNING id`, [higor, org])).rows[0].id;
    await expect(t.owner.query(`INSERT INTO acc_agent_runs (agent_id, session_id, correlation_id, trigger_type, source) VALUES ($1,$2,'c','manual','test')`, [sophia, sid])).rejects.toMatchObject({ code: '23503' });
  });
});

describe('esquema: eventos', () => {
  const insEv = (cols: string, vals: unknown[]) =>
    t.owner.query(`INSERT INTO acc_agent_events (${cols}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id, seq`, vals);

  it('append-only: UPDATE, DELETE e TRUNCATE rejeitados ate para o dono', async () => {
    const { sophia } = await ids();
    await insEv('event_type, agent_id, source, occurred_at', ['RUN_STARTED', sophia, 'test', new Date()]);
    await expect(t.owner.query(`UPDATE acc_agent_events SET level='error'`)).rejects.toMatchObject({ code: '23001' });
    await expect(t.owner.query(`DELETE FROM acc_agent_events`)).rejects.toMatchObject({ code: '23001' });
    await expect(t.owner.query(`TRUNCATE acc_agent_events`)).rejects.toMatchObject({ code: '23001' });
  });

  it('TOOL_* exige a tool; sessao/run/versao exigem agente; run de outro agente e rejeitada', async () => {
    const { sophia, higor, org } = await ids();
    await expect(insEv('event_type, agent_id, source, occurred_at', ['TOOL_CALLED', sophia, 'test', new Date()])).rejects.toMatchObject({ code: '23514' });
    await insEv('event_type, agent_id, source, occurred_at, tool_code', ['TOOL_CALLED', sophia, 'test', new Date(), 'tool_nao_cadastrada']); // tool observada, sem cadastro: permitido
    const runId = (await t.owner.query(`INSERT INTO acc_agent_runs (agent_id, correlation_id, trigger_type, source) VALUES ($1,'c','manual','test') RETURNING id`, [higor])).rows[0].id;
    await expect(insEv('event_type, agent_id, run_id, source, occurred_at', ['RUN_STARTED', sophia, runId, 'test', new Date()])).rejects.toMatchObject({ code: '23503' });
    await expect(insEv('event_type, run_id, source, occurred_at', ['RUN_STARTED', runId, 'test', new Date()])).rejects.toMatchObject({ code: '23514' }); // run sem agente
    void org;
  });

  it('idempotencia por (source, event_key); seq monotonico; payload limitado; entidade coerente', async () => {
    const { sophia } = await ids();
    const a = await insEv('event_type, agent_id, source, occurred_at, event_key', ['ERROR', sophia, 'src1', new Date(), 'K']);
    await expect(insEv('event_type, agent_id, source, occurred_at, event_key', ['ERROR', sophia, 'src1', new Date(), 'K'])).rejects.toMatchObject({ code: '23505' });
    await insEv('event_type, agent_id, source, occurred_at, event_key', ['ERROR', sophia, 'src2', new Date(), 'K']); // outra origem: ok
    const b = await insEv('event_type, agent_id, source, occurred_at', ['ERROR', sophia, 'src1', new Date()]);
    expect(BigInt(b.rows[0].seq)).toBeGreaterThan(BigInt(a.rows[0].seq));
    await expect(t.owner.query(`INSERT INTO acc_agent_events (event_type, agent_id, source, occurred_at, payload) VALUES ('ERROR',$1,'test',now(),$2::jsonb)`, [sophia, JSON.stringify({ b: 'x'.repeat(17000) })])).rejects.toMatchObject({ code: '23514' });
    await expect(insEv('event_type, agent_id, source, occurred_at, entity_type', ['ERROR', sophia, 'test', new Date(), 'lead'])).rejects.toMatchObject({ code: '23514' });
  });

  it('evento atualiza a atividade da sessao (nunca retrocede)', async () => {
    const { sophia, org } = await ids();
    const s = (await t.owner.query(`INSERT INTO acc_agent_sessions (agent_id, organization_id, entity_type, entity_id, source, started_at, last_activity_at) VALUES ($1,$2,'lead','ACT','test', now() - interval '1 hour', now() - interval '1 hour') RETURNING id`, [sophia, org])).rows[0].id;
    await insEv('event_type, agent_id, session_id, source, occurred_at', ['MESSAGE_RECEIVED', sophia, s, 'test', new Date(Date.now() - 10 * min)]);
    const after1 = new Date((await row(`SELECT last_activity_at FROM acc_agent_sessions WHERE id=$1`, [s])).last_activity_at).getTime();
    expect(Date.now() - after1).toBeLessThan(11 * min);
    await insEv('event_type, agent_id, session_id, source, occurred_at', ['MESSAGE_SENT', sophia, s, 'test', new Date(Date.now() - 50 * min)]); // evento antigo
    expect(new Date((await row(`SELECT last_activity_at FROM acc_agent_sessions WHERE id=$1`, [s])).last_activity_at).getTime()).toBe(after1);
  });

  it('usar uma versao a SELA: a primeira sessao/run/evento que a referencia', async () => {
    const cand = await row(`SELECT v.id, v.agent_id FROM acc_agent_versions v WHERE v.status='candidate'`);
    expect((await row(`SELECT sealed_at FROM acc_agent_versions WHERE id=$1`, [cand.id])).sealed_at).toBeNull();
    await t.app.query(`INSERT INTO acc_agent_events (event_type, agent_id, agent_version_id, source, occurred_at) VALUES ('RUN_STARTED',$1,$2,'test',now())`, [cand.agent_id, cand.id]);
    expect((await row(`SELECT sealed_at FROM acc_agent_versions WHERE id=$1`, [cand.id])).sealed_at).toBeTruthy();
    await expect(t.owner.query(`UPDATE acc_agent_versions SET model_name='outro' WHERE id=$1`, [cand.id])).rejects.toMatchObject({ code: '23001' });
  });
});

describe('indices: consultas por agente, entidade, sessao, run, correlacao e tempo', () => {
  it('cada consulta tipica tem indice disponivel (planner com seqscan desligado)', async () => {
    const plan = async (sql: string) => {
      await t.owner.query('BEGIN');
      await t.owner.query('SET LOCAL enable_seqscan = off');
      const r = await t.owner.query(`EXPLAIN ${sql}`);
      await t.owner.query('ROLLBACK');
      return r.rows.map((x) => x['QUERY PLAN']).join('\n');
    };
    const u = '00000000-0000-0000-0000-000000000001';
    const cases: [string, string][] = [
      [`SELECT * FROM acc_agent_events WHERE agent_id='${u}' ORDER BY occurred_at DESC, seq DESC LIMIT 20`, 'ix_acc_agent_events_agent'],
      [`SELECT * FROM acc_agent_events WHERE entity_type='lead' AND entity_id='1' ORDER BY occurred_at DESC LIMIT 20`, 'ix_acc_agent_events_entity'],
      [`SELECT * FROM acc_agent_events WHERE lead_id=1 ORDER BY occurred_at DESC LIMIT 20`, 'ix_acc_agent_events_lead'],
      [`SELECT * FROM acc_agent_events WHERE session_id='${u}' ORDER BY occurred_at`, 'ix_acc_agent_events_session'],
      [`SELECT * FROM acc_agent_events WHERE run_id='${u}' ORDER BY seq`, 'ix_acc_agent_events_run'],
      [`SELECT * FROM acc_agent_events WHERE correlation_id='c'`, 'ix_acc_agent_events_correlation'],
      [`SELECT * FROM acc_agent_events ORDER BY occurred_at DESC, seq DESC LIMIT 20`, 'ix_acc_agent_events_time'],
      [`SELECT * FROM acc_agent_events WHERE event_type='ERROR' ORDER BY occurred_at DESC LIMIT 20`, 'ix_acc_agent_events_type'],
      [`SELECT * FROM acc_agent_runs WHERE agent_id='${u}' ORDER BY started_at DESC LIMIT 20`, 'ix_acc_agent_runs_agent'],
      [`SELECT * FROM acc_agent_runs WHERE entity_type='lead' AND entity_id='1' ORDER BY started_at DESC`, 'ix_acc_agent_runs_entity'],
      [`SELECT * FROM acc_agent_runs WHERE session_id='${u}'`, 'ix_acc_agent_runs_session'],
      [`SELECT * FROM acc_agent_runs WHERE correlation_id='c'`, 'ix_acc_agent_runs_correlation'],
      [`SELECT * FROM acc_agent_runs ORDER BY started_at DESC LIMIT 20`, 'ix_acc_agent_runs_started'],
      [`SELECT * FROM acc_agent_sessions WHERE agent_id='${u}' AND status='active' ORDER BY last_activity_at DESC`, 'ix_acc_agent_sessions_agent'],
      [`SELECT * FROM acc_agent_sessions WHERE entity_type='lead' AND entity_id='1'`, 'ix_acc_agent_sessions_entity'],
      [`SELECT * FROM acc_agent_sessions WHERE lead_id=1`, 'ix_acc_agent_sessions_lead'],
    ];
    for (const [sql, index] of cases) expect(await plan(sql), sql).toContain(index);
  });
});

describe('ingestao (servico)', () => {
  it('cria sessao, run e eventos de ciclo de vida derivados; resolve a versao por config_hash', async () => {
    const t0 = Date.now(); // UM unico instante de referencia: duration_ms exato e deterministico
    const r = await ingest(env({ run: { key: 'ING-1', trigger_type: 'message', started_at: new Date(t0 - 5 * min).toISOString(), completed_at: new Date(t0 - 4 * min).toISOString(), status: 'succeeded', model_name: 'gpt-x', usage: { input_tokens: 10, output_tokens: 5, estimated_cost: 0.0012 }, output_summary: 'ok' } }));
    expect(r).toMatchObject({ runCreated: true, runStatus: 'succeeded', versionUnresolved: false, eventsInserted: 2 });
    expect(r.versionId).toBeTruthy();
    const run = await row(`SELECT status, duration_ms, input_tokens, agent_version_id, session_id, lead_id FROM acc_agent_runs WHERE id=$1`, [r.runId]);
    expect(run).toMatchObject({ status: 'succeeded', duration_ms: 60000, input_tokens: 10, lead_id: '1001' });
    expect(run.agent_version_id).toBe(r.versionId);
    expect(run.session_id).toBe(r.sessionId);
    const types = (await t.owner.query(`SELECT event_type FROM acc_agent_events WHERE run_id=$1 ORDER BY occurred_at`, [r.runId])).rows.map((x) => x.event_type);
    expect(types).toEqual(['RUN_STARTED', 'RUN_SUCCEEDED']);
  });

  it('reenvio do mesmo envelope e idempotente (nada duplica)', async () => {
    const e = env({ run: { key: 'ING-2', trigger_type: 'webhook', started_at: at(-3 * min) }, events: [
      { type: 'MESSAGE_RECEIVED', occurred_at: at(-3 * min), payload: { message_ref: 77 } },
      { type: 'TOOL_CALLED', occurred_at: at(-2 * min), tool: { code: 'consultar_agenda' } },
    ] });
    const first = await ingest(e);
    expect(first).toMatchObject({ runCreated: true, eventsInserted: 3, eventsDuplicate: 0 });
    const again = await ingest(e);
    expect(again).toMatchObject({ runCreated: false, eventsInserted: 0, eventsDuplicate: 3, runId: first.runId, sessionId: first.sessionId });
    expect(await n(`SELECT count(*)::int n FROM acc_agent_runs WHERE run_key='ING-2'`)).toBe(1);
    expect(await n(`SELECT count(*)::int n FROM acc_agent_events WHERE run_id=$1`, [first.runId])).toBe(3);
  });

  it('a run e concluida em um envio posterior; terminal e final (conclusao contraditoria ignorada)', async () => {
    const start = env({ run: { key: 'ING-3', trigger_type: 'message', started_at: at(-4 * min) } });
    const r1 = await ingest(start);
    expect(r1.runStatus).toBe('running');
    const done = env({ run: { key: 'ING-3', trigger_type: 'message', started_at: at(-4 * min), completed_at: at(-3 * min), status: 'failed', error: { code: 'BOOM', message: 'falhou' } } });
    const r2 = await ingest(done);
    expect(r2).toMatchObject({ runCreated: false, runStatus: 'failed' });
    expect(await row(`SELECT status, error_code FROM acc_agent_runs WHERE run_key='ING-3'`)).toMatchObject({ status: 'failed', error_code: 'BOOM' });
    const contradictory = env({ run: { key: 'ING-3', trigger_type: 'message', started_at: at(-4 * min), completed_at: at(-1 * min), status: 'succeeded' } });
    expect((await ingest(contradictory)).runStatus).toBe('failed');
    expect((await row(`SELECT status FROM acc_agent_runs WHERE run_key='ING-3'`)).status).toBe('failed');
    const failedEvt = await row(`SELECT level, payload FROM acc_agent_events WHERE run_id=$1 AND event_type='RUN_FAILED'`, [r2.runId]);
    expect(failedEvt.level).toBe('error');
    expect(failedEvt.payload.error_code).toBe('BOOM');
  });

  it('uma sessao ATIVA por agente+entidade e reaproveitada entre runs; endSession e expireIdleSessions', async () => {
    const a = await ingest(env({ entity: { type: 'lead', id: '2002', lead_id: 2002 }, run: { key: 'SES-1', trigger_type: 'message', started_at: at(-30 * min) } }));
    const b = await ingest(env({ entity: { type: 'lead', id: '2002', lead_id: 2002 }, run: { key: 'SES-2', trigger_type: 'message', started_at: at(-20 * min) } }));
    expect(b.sessionId).toBe(a.sessionId);
    expect(await n(`SELECT count(*)::int n FROM acc_agent_sessions WHERE entity_id='2002'`)).toBe(1);
    expect(await expireIdleSessions(t.app, 60)).toBeGreaterThanOrEqual(0);
    expect(await expireIdleSessions(t.app, 5)).toBeGreaterThan(0); // inativa ha 20+ min
    expect((await row(`SELECT status, end_reason FROM acc_agent_sessions WHERE entity_id='2002'`))).toMatchObject({ status: 'expired', end_reason: 'idle' });
    const c = await ingest(env({ entity: { type: 'lead', id: '2002', lead_id: 2002 }, run: { key: 'SES-3', trigger_type: 'message', started_at: at(-1 * min) } }));
    expect(c.sessionId).not.toBe(a.sessionId); // nova sessao apos expirar
    const { sophia } = await ids();
    expect(await endSession(t.app, { agentId: sophia, entityType: 'lead', entityId: '2002', reason: 'fim do atendimento' })).toBe(true);
    expect(await endSession(t.app, { agentId: sophia, entityType: 'lead', entityId: '2002', reason: 'de novo' })).toBe(false);
  });

  it('versao: por workflow_version_id (revisao do n8n), por workflow_external_id; desconhecida fica sinalizada', async () => {
    const rev = prod.source_revision.split('#')[1];
    const byRev = await ingest(env({ version: { workflow_version_id: rev }, run: { key: 'VER-1', trigger_type: 'webhook', started_at: at(-2 * min) } }));
    expect(byRev.versionId).toBeTruthy();
    const byWf = await ingest(env({ version: { workflow_external_id: prod.workflow_external_id }, run: { key: 'VER-2', trigger_type: 'webhook', started_at: at(-2 * min) } }));
    expect(byWf.versionId).toBe(byRev.versionId);
    const unknown = await ingest(env({ version: { workflow_version_id: 'versao-antiga-nao-cadastrada' }, run: { key: 'VER-3', trigger_type: 'webhook', started_at: at(-2 * min) } }));
    expect(unknown).toMatchObject({ versionId: null, versionUnresolved: true });
    expect((await row(`SELECT metadata FROM acc_agent_runs WHERE run_key='VER-3'`)).metadata.version_unresolved).toBe(true);
    const none = await ingest(env({ version: undefined, run: { key: 'VER-4', trigger_type: 'manual', started_at: at(-2 * min) } }));
    expect(none).toMatchObject({ versionId: null, versionUnresolved: false });
  });

  it('tools: liga ao cadastro quando existe; mantem o nome observado quando nao existe; integracao resolvida', async () => {
    const r = await ingest(env({ run: { key: 'TOOL-1', trigger_type: 'message', started_at: at(-2 * min) }, events: [
      { type: 'TOOL_CALLED', occurred_at: at(-100_000), tool: { code: 'consultar_agenda' }, integration: 'google_calendar' },
      { type: 'TOOL_FAILED', occurred_at: at(-90_000), tool: { code: 'tool_fantasma' }, payload: { error_code: 'TIMEOUT' } },
    ] }));
    const evs = (await t.owner.query(`SELECT event_type, tool_id, tool_code, integration_id, level FROM acc_agent_events WHERE run_id=$1 AND event_type LIKE 'TOOL_%' ORDER BY occurred_at`, [r.runId])).rows;
    expect(evs[0].tool_id).toBeTruthy();
    expect(evs[0].integration_id).toBeTruthy();
    expect(evs[1]).toMatchObject({ tool_id: null, tool_code: 'tool_fantasma', level: 'error' });
  });

  it('agente inexistente => TelemetryError estavel; efeitos revertidos', async () => {
    await expect(ingest(env({ agent: 'agente_inexistente' }))).rejects.toBeInstanceOf(TelemetryError);
    await expect(ingest(env({ agent: 'agente_inexistente' }))).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
    await expect(ingest(env({ organization: 'outra_org' }))).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
  });

  it('funciona para QUALQUER agente cadastrado (sem codigo por agente)', async () => {
    const r = await ingest(env({ agent: 'higor', version: undefined, entity: { type: 'lead', id: '3003', lead_id: 3003 }, run: { key: 'HG-1', trigger_type: 'schedule', started_at: at(-2 * min) } }));
    expect(r.runCreated).toBe(true);
    expect((await row(`SELECT a.slug FROM acc_agent_runs r JOIN acc_agents a ON a.id=r.agent_id WHERE r.id=$1`, [r.runId])).slug).toBe('higor');
  });

  it('PII/segredos nunca chegam ao banco: o contrato rejeita antes de gravar', async () => {
    expect(() => env({ events: [{ type: 'MESSAGE_RECEIVED', occurred_at: at(-1 * min), payload: { text: 'ola, meu cpf e 123' } }] })).toThrow(/proibidas/);
    expect(await n(`SELECT count(*)::int n FROM acc_agent_events WHERE payload::text ILIKE '%cpf%'`)).toBe(0);
  });
});

describe('coletor n8n (somente leitura; sem alterar workflows)', () => {
  const rev = prod.source_revision.split('#')[1];
  const wf = prod.workflow_external_id!;
  const spy: string[] = [];
  const src: Queryable = { query: (sql, params) => { spy.push(sql); return t.owner.query(sql, params) as ReturnType<Queryable['query']>; } };

  beforeAll(async () => {
    // fixture com as colunas de metadados de execution_entity (nunca execution_data)
    await t.owner.query(`CREATE TABLE execution_entity (id int PRIMARY KEY, finished boolean NOT NULL DEFAULT false, mode varchar NOT NULL,
      "startedAt" timestamptz, "stoppedAt" timestamptz, status varchar NOT NULL, "workflowId" varchar NOT NULL, "deletedAt" timestamptz,
      "workflowVersionId" varchar)`);
    const ex = (id: number, w: string, status: string, mode: string, startMin: number, stopMin: number | null, ver: string | null, del = false) =>
      t.owner.query(`INSERT INTO execution_entity (id, mode, "startedAt", "stoppedAt", status, "workflowId", "workflowVersionId", "deletedAt") VALUES ($1,$2,now() + ($3 || ' minutes')::interval, ${stopMin === null ? 'NULL' : `now() + ($4 || ' minutes')::interval`}, $5, $6, $7, ${del ? 'now()' : 'NULL'})`,
        stopMin === null ? [id, mode, startMin, status, w, ver].map((v, i) => (i === 3 ? v : v)) as unknown[] : [id, mode, startMin, stopMin, status, w, ver] as unknown[]);
    await t.owner.query(`INSERT INTO execution_entity (id, mode, "startedAt", "stoppedAt", status, "workflowId", "workflowVersionId") VALUES
      (9001,'webhook', now() - interval '50 minutes', now() - interval '49 minutes', 'success', '${wf}', '${rev}'),
      (9002,'webhook', now() - interval '45 minutes', now() - interval '44 minutes', 'error', '${wf}', '${rev}'),
      (9003,'webhook', now() - interval '40 minutes', now() - interval '39 minutes', 'canceled', '${wf}', 'versao-antiga'),
      (9004,'trigger', now() - interval '3 minutes', NULL, 'running', '${wf}', '${rev}'),
      (9005,'webhook', now() - interval '30 minutes', now() - interval '29 minutes', 'success', 'workflow-de-outro-sistema', NULL),
      (9006,'webhook', now() - interval '20 minutes', now() - interval '19 minutes', 'success', '${wf}', '${rev}')`);
    await t.owner.query(`UPDATE execution_entity SET "deletedAt" = now() WHERE id = 9006`);
    void ex;
  });

  it('observa somente workflows de agentes cadastrados: ignora outros e execucoes excluidas', async () => {
    await t.app.query('BEGIN');
    const s = await collectN8nExecutions(src, t.app, { organization: 'vne', since: new Date(Date.now() - 2 * 60 * min) });
    await t.app.query('COMMIT');
    expect(s).toMatchObject({ seen: 4, newRuns: 4, skipped: 0 });
    expect(await n(`SELECT count(*)::int n FROM acc_agent_runs WHERE run_key LIKE 'n8n:%'`)).toBe(4);
    expect(await n(`SELECT count(*)::int n FROM acc_agent_runs WHERE run_key IN ('n8n:9005','n8n:9006')`)).toBe(0);
    const by = Object.fromEntries((await t.owner.query(`SELECT run_key, status, error_code, trigger_type FROM acc_agent_runs WHERE run_key LIKE 'n8n:%'`)).rows.map((r) => [r.run_key, r]));
    expect(by['n8n:9001']).toMatchObject({ status: 'succeeded', trigger_type: 'webhook' });
    expect(by['n8n:9002']).toMatchObject({ status: 'failed', error_code: 'N8N_ERROR' });
    expect(by['n8n:9003'].status).toBe('cancelled');
    expect(by['n8n:9004']).toMatchObject({ status: 'running', trigger_type: 'other' });
  });

  it('atribui a run a VERSAO exata do workflow (workflowVersionId); versao antiga fica sinalizada', async () => {
    const v = await row(`SELECT v.version FROM acc_agent_runs r JOIN acc_agent_versions v ON v.id = r.agent_version_id WHERE r.run_key = 'n8n:9001'`);
    expect(v.version).toBe(prod.version);
    const old = await row(`SELECT agent_version_id, metadata FROM acc_agent_runs WHERE run_key = 'n8n:9003'`);
    expect(old.agent_version_id).toBeNull();
    expect(old.metadata.version_unresolved).toBe(true);
    expect(old.metadata.workflow_version_id).toBe('versao-antiga'); // rastreabilidade preservada
  });

  it('e idempotente e completa runs que estavam em andamento na coleta seguinte', async () => {
    await t.owner.query(`UPDATE execution_entity SET status='success', "stoppedAt"=now() - interval '1 minute', finished=true WHERE id=9004`);
    await t.app.query('BEGIN');
    const s = await collectN8nExecutions(src, t.app, { organization: 'vne', since: new Date(Date.now() + 60 * min) }); // cursor no futuro: so as abertas
    await t.app.query('COMMIT');
    expect(s.seen).toBe(1); // reconsultou apenas a run aberta
    expect((await row(`SELECT status FROM acc_agent_runs WHERE run_key='n8n:9004'`)).status).toBe('succeeded');
    expect(await n(`SELECT count(*)::int n FROM acc_agent_events WHERE event_type='RUN_SUCCEEDED' AND run_id=(SELECT id FROM acc_agent_runs WHERE run_key='n8n:9004')`)).toBe(1);
    await t.app.query('BEGIN');
    await collectN8nExecutions(src, t.app, { organization: 'vne', since: new Date(Date.now() - 2 * 60 * min) });
    await t.app.query('COMMIT');
    expect(await n(`SELECT count(*)::int n FROM acc_agent_runs WHERE run_key LIKE 'n8n:%'`)).toBe(4); // nada duplicou
  });

  it('LE apenas metadados: so SELECT, nunca execution_data, nunca escreve na origem', async () => {
    expect(spy.length).toBeGreaterThan(0);
    for (const sql of spy) {
      expect(sql, sql).toMatch(/^\s*SELECT/i);
      expect(sql).not.toMatch(/execution_data|workflowData|\bdata\b\s*(,|FROM)/i);
    }
    expect(await n('SELECT count(*)::int n FROM execution_entity')).toBe(6); // origem intacta
  });

  it('runs coletadas nao carregam conteudo nem entidade (limitacao documentada)', async () => {
    const r = await row(`SELECT entity_type, entity_id, lead_id, input_summary, output_summary, metadata FROM acc_agent_runs WHERE run_key='n8n:9001'`);
    expect(r).toMatchObject({ entity_type: null, entity_id: null, lead_id: null, input_summary: null, output_summary: null });
    expect(Object.keys(r.metadata).sort()).toEqual(['n8n_mode', 'n8n_status', 'workflow_id', 'workflow_version_id']);
  });
});

describe('consultas de leitura', () => {
  it('listRuns/listSessions/listEvents com filtros; entradas invalidas sao ignoradas', async () => {
    const { sophia } = await ids();
    const runs = await listRuns(t.app, { agentId: sophia, limit: 500 });
    expect(runs.length).toBeGreaterThan(3);
    expect(runs.length).toBeLessThanOrEqual(200);
    expect(runs.every((r) => r.agentId === sophia)).toBe(true);
    expect(runs[0].startedAt >= runs[runs.length - 1].startedAt).toBe(true);
    expect((await listRuns(t.app, { leadId: '1001' })).every((r) => r.leadId === '1001')).toBe(true);
    expect((await listSessions(t.app, { onlyActive: true })).every((s) => s.status === 'active')).toBe(true);
    // filtros malformados/maliciosos nao quebram nem filtram indevidamente
    const bad = await listEvents(t.app, { agentId: "x'; DROP TABLE acc_agent_events;--", eventType: 'nao valido', leadId: 'abc', level: 'critical' as never });
    expect(bad.items.length).toBeGreaterThan(0);
    expect(await n('SELECT count(*)::int n FROM acc_agent_events')).toBeGreaterThan(0);
  });

  it('TODAS as consultas ignoram filtros malformados em vez de falhar (parametros de URL nunca causam 500)', async () => {
    const junk = ["x'; DROP TABLE acc_agent_runs;--", 'nao-e-uuid', '', '00000000-0000-0000-0000-00000000000Z', '1 OR 1=1', 'a'.repeat(500)];
    const total = await n('SELECT count(*)::int n FROM acc_agent_runs');
    for (const v of junk) {
      expect((await listRuns(t.app, { agentId: v, leadId: v })).length, `runs ${v}`).toBeGreaterThan(0); // filtro ignorado => sem filtro
      expect((await listSessions(t.app, { agentId: v })).length, `sessions ${v}`).toBeGreaterThan(0);
      await expect(listEvents(t.app, { agentId: v, leadId: v, runId: v, eventType: v, level: v as never })).resolves.toBeTruthy();
    }
    expect(await n('SELECT count(*)::int n FROM acc_agent_runs')).toBe(total);
  });

  it('paginacao por cursor (occurred_at, seq): sem repeticao e sem buracos', async () => {
    const all: string[] = [];
    let before: { occurredAt: string; seq: string } | undefined;
    for (let i = 0; i < 100; i++) {
      const page = await listEvents(t.app, { limit: 7, before });
      all.push(...page.items.map((e) => e.id));
      if (!page.hasMore) break;
      before = page.items[page.items.length - 1].cursor;
    }
    expect(new Set(all).size).toBe(all.length); // sem repeticao
    expect(all.length).toBe(await n('SELECT count(*)::int n FROM acc_agent_events'));
  });

  it('filtro por tipo, nivel, lead e run', async () => {
    const errors = await listEvents(t.app, { level: 'error', limit: 200 });
    expect(errors.items.every((e) => e.level === 'error')).toBe(true);
    const tools = await listEvents(t.app, { eventType: 'TOOL_CALLED', limit: 200 });
    expect(tools.items.every((e) => e.eventType === 'TOOL_CALLED')).toBe(true);
    const lead = await listEvents(t.app, { leadId: '1001', limit: 200 });
    expect(lead.items.length).toBeGreaterThan(0);
    expect(lead.items.every((e) => e.leadId === '1001')).toBe(true);
    const run = (await t.owner.query(`SELECT id FROM acc_agent_runs WHERE run_key='ING-2'`)).rows[0].id;
    expect((await listEvents(t.app, { runId: run })).items.every((e) => e.runId === run)).toBe(true);
  });

  it('overview: distingue sem dados, so sintetico e dados reais; conta erros e runs 24h', async () => {
    const o = await getTelemetryOverview(t.app);
    expect(o).toMatchObject({ hasData: true, onlySynthetic: false });
    expect(o.runs24h).toBeGreaterThan(3);
    expect(o.failedRuns24h).toBeGreaterThan(0);
    expect(o.errorEvents24h).toBeGreaterThan(0);
  });
});
