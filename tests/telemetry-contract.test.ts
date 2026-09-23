import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, findForbiddenKeys, parseTelemetry } from '../src/domain/telemetry.ts';
import { mapStatus, toEnvelope } from '../src/server/telemetry/n8n-collector.ts';

const minute = 60_000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const base = () => ({
  schema_version: 1, organization: 'vne', source: 'n8n', agent: 'agente_x', correlation_id: 'corr-1',
  entity: { type: 'lead', id: '1001', lead_id: 1001 },
  run: { key: 'exec-1', trigger_type: 'message', started_at: at(-2 * minute) },
  events: [],
});
const clone = () => structuredClone(base()) as ReturnType<typeof base> & Record<string, any>;

describe('contrato de telemetria v1', () => {
  it('aceita um envelope minimo e normaliza datas e lead_id', () => {
    const e = parseTelemetry(base());
    expect(e.run.started_at).toBeInstanceOf(Date);
    expect(e.entity?.lead_id).toBe('1001');
    expect(e.events).toEqual([]);
  });

  it('a taxonomia inicial tem exatamente os 10 tipos combinados', () => {
    expect([...EVENT_TYPES].sort()).toEqual([
      'ERROR', 'HUMAN_REQUESTED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT', 'RUN_FAILED', 'RUN_STARTED', 'RUN_SUCCEEDED',
      'TOOL_CALLED', 'TOOL_FAILED', 'TOOL_SUCCEEDED',
    ]);
  });

  it('nao conhece agentes especificos: o agente e apenas um slug (dado)', () => {
    expect(parseTelemetry({ ...base(), agent: 'qualquer_agente_novo' }).agent).toBe('qualquer_agente_novo');
    expect(() => parseTelemetry({ ...base(), agent: 'Agente Com Espaco' })).toThrow();
  });

  it('exige schema_version 1, correlation_id e run.key', () => {
    expect(() => parseTelemetry({ ...base(), schema_version: 2 })).toThrow();
    expect(() => parseTelemetry({ ...base(), correlation_id: '' })).toThrow();
    const e = clone();
    delete (e.run as any).key;
    expect(() => parseTelemetry(e)).toThrow();
  });

  it('consistencia da run: terminal exige completed_at; completed_at exige terminal; ordem temporal', () => {
    let e = clone();
    (e.run as any).status = 'succeeded';
    expect(() => parseTelemetry(e)).toThrow(/completed_at/);
    e = clone();
    (e.run as any).completed_at = at(-1 * minute);
    expect(() => parseTelemetry(e)).toThrow(/status terminal/);
    e = clone();
    Object.assign(e.run, { status: 'succeeded', completed_at: at(-10 * minute) });
    expect(() => parseTelemetry(e)).toThrow(/anterior/);
    e = clone();
    Object.assign(e.run, { status: 'succeeded', completed_at: at(-1 * minute) });
    expect(parseTelemetry(e).run.status).toBe('succeeded');
  });

  it('error so em run falha; started_at nao pode estar no futuro', () => {
    const e = clone();
    Object.assign(e.run, { status: 'succeeded', completed_at: at(-1 * minute), error: { code: 'X' } });
    expect(() => parseTelemetry(e)).toThrow(/error so em run/);
    const f = clone();
    (f.run as any).started_at = at(2 * 60 * minute);
    expect(() => parseTelemetry(f)).toThrow(/futuro/);
  });

  it('sessao exige entidade; eventos TOOL_* exigem tool.code', () => {
    const e = clone();
    delete (e as any).entity;
    (e as any).session = { start: true };
    expect(() => parseTelemetry(e)).toThrow(/session exige entity/);
    const t = clone();
    (t as any).events = [{ type: 'TOOL_CALLED', occurred_at: at(-1 * minute) }];
    expect(() => parseTelemetry(t)).toThrow(/tool\.code/);
    (t as any).events = [{ type: 'TOOL_CALLED', occurred_at: at(-1 * minute), tool: { code: 'consultar_agenda' } }];
    expect(parseTelemetry(t).events[0].tool?.code).toBe('consultar_agenda');
  });

  it('tipos de evento fora da taxonomia sao rejeitados (nada de texto livre como event_type)', () => {
    const e = clone();
    (e as any).events = [{ type: 'ALGO_LIVRE', occurred_at: at(-1 * minute) }];
    expect(() => parseTelemetry(e)).toThrow();
  });

  it('PII e segredos sao proibidos em payload/metadata, em qualquer profundidade', () => {
    for (const bad of [{ text: 'oi' }, { nested: { content: 'x' } }, { list: [{ prompt: 'p' }] }, { email: 'a@b.com' }, { api_key: 'k' }, { Authorization: 'Bearer x' }]) {
      const e = clone();
      (e as any).events = [{ type: 'MESSAGE_RECEIVED', occurred_at: at(-1 * minute), payload: bad }];
      expect(() => parseTelemetry(e), JSON.stringify(bad)).toThrow(/proibidas/);
      const m = clone();
      (m.run as any).metadata = bad;
      expect(() => parseTelemetry(m), JSON.stringify(bad)).toThrow(/proibidas/);
    }
    expect(findForbiddenKeys({ message_ref: 123, lengths: { chars: 40 } })).toEqual([]); // referencia por id e permitida
  });

  it('limites: payload de 8 KB, resumo de 2000 caracteres, no maximo 200 eventos', () => {
    const big = clone();
    (big as any).events = [{ type: 'ERROR', occurred_at: at(-1 * minute), payload: { blob: 'x'.repeat(9000) } }];
    expect(() => parseTelemetry(big)).toThrow(/8 KB/);
    const sum = clone();
    (sum.run as any).input_summary = 'x'.repeat(2001);
    expect(() => parseTelemetry(sum)).toThrow();
    const many = clone();
    (many as any).events = Array.from({ length: 201 }, () => ({ type: 'ERROR', occurred_at: at(-1 * minute) }));
    expect(() => parseTelemetry(many)).toThrow();
  });
});

describe('mapeamento das execucoes do n8n (coletor somente-leitura)', () => {
  it('traduz o status do n8n para o status da run', () => {
    expect(mapStatus('success', null)).toEqual({ status: 'succeeded' });
    expect(mapStatus('error', new Date())).toEqual({ status: 'failed', errorCode: 'N8N_ERROR' });
    expect(mapStatus('crashed', new Date())).toEqual({ status: 'failed', errorCode: 'N8N_CRASHED' });
    expect(mapStatus('canceled', new Date())).toEqual({ status: 'cancelled' });
    for (const s of ['running', 'new', 'waiting']) expect(mapStatus(s, null).status).toBe('running');
    expect(mapStatus('unknown', null).status).toBe('running'); // sem fim registrado: nao presume falha
    expect(mapStatus('unknown', new Date()).status).toBe('failed');
  });

  const map = { agentSlug: 'agente_x', workflowId: 'wf1' };
  it('gera envelope valido, sem entidade e sem conteudo; modo webhook vira trigger webhook', () => {
    const e = toEnvelope({ id: 42, workflowId: 'wf1', status: 'success', mode: 'webhook', startedAt: at(-5 * minute), stoppedAt: at(-4 * minute), workflowVersionId: 'v-1' }, map, 'vne')!;
    expect(e.run).toMatchObject({ key: 'n8n:42', trigger_type: 'webhook', status: 'succeeded' });
    expect(e.entity).toBeUndefined();
    expect(e.version).toEqual({ workflow_external_id: 'wf1', workflow_version_id: 'v-1' });
    expect(JSON.stringify(e)).not.toMatch(/texto|content|prompt/i);
  });

  it('execucao em andamento gera run running; sem startedAt e ignorada', () => {
    const r = toEnvelope({ id: 1, workflowId: 'wf1', status: 'running', mode: 'trigger', startedAt: at(-1 * minute), stoppedAt: null, workflowVersionId: null }, map, 'vne')!;
    expect(r.run.status).toBeUndefined();
    expect(r.run.completed_at).toBeUndefined();
    expect(r.run.trigger_type).toBe('other');
    expect(toEnvelope({ id: 2, workflowId: 'wf1', status: 'new', mode: 'webhook', startedAt: null, stoppedAt: null, workflowVersionId: null }, map, 'vne')).toBeNull();
  });
});
