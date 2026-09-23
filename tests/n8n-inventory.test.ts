import { describe, expect, it } from 'vitest';
import { analyzeWorkflow, diffAgentTools, toolCode } from '../scripts/lib/n8n-inventory.mjs';

// Workflow SINTETICO no formato do n8n (nodes + connections). Nenhum dado real.
const SECRET_PROMPT = 'PROMPT_SECRETO_NAO_PODE_VAZAR';
const wf = (over: Record<string, unknown> = {}) => ({
  id: 'wfA', name: 'Agente X', active: true, versionId: 'ver-1', versionCounter: 7, activeVersionId: 'ver-1',
  updatedAt: '2026-09-23T10:00:00Z',
  nodes: [
    { name: 'Agente IA', type: '@n8n/n8n-nodes-langchain.agent', parameters: { text: 'oi', options: { systemMessage: SECRET_PROMPT } } },
    { name: 'LLM', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', parameters: { model: { value: 'gpt-x' } } },
    { name: 'Memoria', type: '@n8n/n8n-nodes-langchain.memoryPostgresChat', parameters: {} },
    { name: 'reservar_reunião', type: '@n8n/n8n-nodes-langchain.toolWorkflow', parameters: { workflowId: { value: 'wfT' } } },
    { name: 'salvar_x', type: '@n8n/n8n-nodes-langchain.httpRequestTool', parameters: { method: 'PATCH', url: '=https://crm.exemplo.com/api/{{ $json.id }}', headerParameters: 'TOKEN_SECRETO' } },
    { name: 'consulta_pg', type: '@n8n/n8n-nodes-langchain.postgresTool', parameters: { operation: 'executeQuery', query: 'SELECT 1; UPDATE t SET a=1' } },
    { name: 'tool_desligada', type: '@n8n/n8n-nodes-langchain.httpRequestTool', disabled: true, parameters: { url: 'https://x.com' } },
    { name: 'tool_solta', type: '@n8n/n8n-nodes-langchain.httpRequestTool', parameters: { url: 'https://y.com' } },
    { name: 'nao_e_tool', type: 'n8n-nodes-base.set', parameters: {} },
  ],
  connections: {
    LLM: { ai_languageModel: [[{ node: 'Agente IA', type: 'ai_languageModel', index: 0 }]] },
    Memoria: { ai_memory: [[{ node: 'Agente IA', type: 'ai_memory', index: 0 }]] },
    'reservar_reunião': { ai_tool: [[{ node: 'Agente IA', type: 'ai_tool', index: 0 }]] },
    salvar_x: { ai_tool: [[{ node: 'Agente IA', type: 'ai_tool', index: 0 }]] },
    consulta_pg: { ai_tool: [[{ node: 'Agente IA', type: 'ai_tool', index: 0 }]] },
    tool_desligada: { ai_tool: [[{ node: 'Agente IA', type: 'ai_tool', index: 0 }]] },
  },
  ...over,
});
const index = { wfT: { name: 'Tool Reservar', active: false } };

describe('toolCode', () => {
  it('normaliza acentos e simbolos para snake_case ascii estavel', () => {
    expect(toolCode('cancelar_reunião_seguro')).toBe('cancelar_reuniao_seguro');
    expect(toolCode('Salvar Plano (Confirmado)!')).toBe('salvar_plano_confirmado');
    expect(toolCode('  __x__ ')).toBe('x');
  });
});

describe('analyzeWorkflow', () => {
  const r = analyzeWorkflow(wf(), index);
  const agent = r.agents[0];

  it('usa as conexoes ai_tool: so tools LIGADAS ao agente contam; soltas ficam como orfas', () => {
    expect(agent.tools.map((t: { code: string }) => t.code)).toEqual(['consulta_pg', 'reservar_reuniao', 'salvar_x', 'tool_desligada']);
    expect(r.orphanTools.map((t: { code: string }) => t.code)).toEqual(['tool_solta']);
  });

  it('respeita disabled: tool desabilitada aparece como tal e nao entra no toolSet do hash', () => {
    expect(agent.tools.find((t: { code: string }) => t.code === 'tool_desligada')!.disabled).toBe(true);
    const without = analyzeWorkflow(wf({ nodes: wf().nodes.filter((n) => n.name !== 'tool_desligada') }), index).agents[0];
    expect(without.configHash).toBe(agent.configHash); // desabilitada nao altera a configuracao efetiva
  });

  it('descreve alvo de sub-workflow (incluindo inativo), host/metodo HTTP e verbos SQL', () => {
    const t = (c: string) => agent.tools.find((x: { code: string }) => x.code === c)!;
    expect(t('reservar_reuniao').target).toEqual({ workflowId: 'wfT', name: 'Tool Reservar', active: false });
    expect(t('salvar_x').http).toEqual({ method: 'PATCH', host: 'crm.exemplo.com' });
    expect(t('consulta_pg').sql?.verbs).toEqual(['SELECT', 'UPDATE']);
  });

  it('modelo e memoria via conexoes ai_languageModel/ai_memory', () => {
    expect(agent.models).toEqual([{ node: 'LLM', type: 'lmChatOpenAi', model: 'gpt-x', disabled: false }]);
    expect(agent.memory[0].type).toBe('memoryPostgresChat');
  });

  it('NUNCA vaza prompt, tokens ou parametros: somente hashes e estrutura', () => {
    const json = JSON.stringify(r);
    expect(json).not.toContain(SECRET_PROMPT);
    expect(json).not.toContain('TOKEN_SECRETO');
    expect(agent.promptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes: prompt alterado muda promptHash e configHash; ruido irrelevante nao muda', () => {
    const edited = wf();
    (edited.nodes[0].parameters as { options: { systemMessage: string } }).options.systemMessage = 'novo prompt';
    const a2 = analyzeWorkflow(edited, index).agents[0];
    expect(a2.promptHash).not.toBe(agent.promptHash);
    expect(a2.configHash).not.toBe(agent.configHash);
    const renamed = analyzeWorkflow(wf({ name: 'Outro nome', updatedAt: '2030-01-01T00:00:00Z', versionCounter: 999 }), index).agents[0];
    expect(renamed.configHash).toBe(agent.configHash); // nome/versao do n8n nao sao configuracao do agente
  });

  it('trocar o modelo ou o alvo de uma tool muda o configHash', () => {
    const m = wf();
    (m.nodes[1].parameters as { model: { value: string } }).model.value = 'gpt-y';
    expect(analyzeWorkflow(m, index).agents[0].configHash).not.toBe(agent.configHash);
    const t = wf();
    (t.nodes[3].parameters as { workflowId: { value: string } }).workflowId.value = 'wfOutro';
    expect(analyzeWorkflow(t, index).agents[0].configHash).not.toBe(agent.configHash);
  });

  it('workflow sem agente devolve agents vazio (ex.: dispatcher)', () => {
    expect(analyzeWorkflow(wf({ nodes: [{ name: 'a', type: 'n8n-nodes-base.set', parameters: {} }], connections: {} }), index).agents).toEqual([]);
  });
});

describe('diffAgentTools', () => {
  const agent = analyzeWorkflow(wf(), index).agents[0];
  it('separa adicionadas, removidas e desabilitadas em relacao ao registry', () => {
    const d = diffAgentTools(['reservar_reuniao', 'salvar_x', 'tool_que_saiu', 'tool_desligada'], agent);
    expect(d).toEqual({ added: ['consulta_pg'], removed: ['tool_que_saiu'], disabledInWorkflow: ['tool_desligada'] });
  });
  it('sem diferencas => tudo vazio', () => {
    expect(diffAgentTools(['consulta_pg', 'reservar_reuniao', 'salvar_x'], agent)).toEqual({ added: [], removed: [], disabledInWorkflow: [] });
  });
});
