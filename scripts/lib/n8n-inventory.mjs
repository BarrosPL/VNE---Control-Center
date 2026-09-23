// Analise ESTATICA de definicoes de workflows n8n (JSON de workflow_entity). Funcoes puras, sem I/O.
// Nunca retorna conteudo de prompts nem parametros: somente estrutura, nomes, hosts e HASHES.
import { createHash } from 'node:crypto';

const sha = (v) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');

/** Nome de node -> codigo estavel de tool (snake_case ascii). */
export function toolCode(nodeName) {
  return String(nodeName)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

const shortType = (t) => String(t).replace(/^n8n-nodes-base\./, '').replace(/^@n8n\/n8n-nodes-langchain\./, '');
const isAgentType = (t) => /langchain\.agent$/.test(t);

const kindOf = (type) => {
  const t = shortType(type);
  if (t === 'toolWorkflow') return 'n8n_workflow';
  if (t === 'httpRequestTool') return 'http_request';
  if (t === 'postgresTool') return 'postgres';
  if (t === 'googleCalendarTool') return 'google_calendar';
  return t;
};

/** Origens (por nome) ligadas a `target` por uma conexao do tipo `connType` (ai_tool, ai_languageModel...). */
function sourcesConnectedTo(connections, target, connType) {
  const out = [];
  for (const [source, byType] of Object.entries(connections ?? {})) {
    for (const branch of byType?.[connType] ?? []) {
      for (const link of branch ?? []) if (link?.node === target) out.push(source);
    }
  }
  return out;
}

const hostOf = (raw) => {
  try {
    return new URL(String(raw).replace(/^=/, '').replace(/\{\{[^}]*\}\}/g, 'x')).hostname || null;
  } catch {
    return null;
  }
};

/**
 * @typedef {{ node: string, code: string, kind: string, disabled: boolean,
 *   target?: { workflowId: string, name: string | null, active: boolean | null } | null,
 *   http?: { method: string, host: string | null },
 *   sql?: { operation: string | null, verbs: string[] },
 *   calendar?: { resource: string | null, operation: string | null } }} ToolDescription
 */

/**
 * @param {any} node
 * @param {Record<string, { name: string | null, active: boolean | null }>} workflowIndex
 * @returns {ToolDescription}
 */
function describeTool(node, workflowIndex) {
  const p = node.parameters ?? {};
  const base = { node: node.name, code: toolCode(node.name), kind: kindOf(node.type), disabled: node.disabled === true };
  const k = base.kind;
  if (k === 'n8n_workflow') {
    const w = p.workflowId;
    const id = typeof w === 'object' && w !== null ? (w.value ?? null) : (w ?? null);
    const t = id ? workflowIndex[id] : null;
    return { ...base, target: id ? { workflowId: String(id), name: t?.name ?? null, active: t?.active ?? null } : null };
  }
  if (k === 'http_request') {
    return { ...base, http: { method: String(p.method ?? 'GET').toUpperCase(), host: hostOf(p.url) } };
  }
  if (k === 'postgres') {
    const q = String(p.query ?? '');
    const verbs = [...new Set([...q.matchAll(/\b(SELECT|INSERT|UPDATE|DELETE)\b/gi)].map((m) => m[1].toUpperCase()))].sort();
    return { ...base, sql: { operation: p.operation ?? null, verbs } };
  }
  if (k === 'google_calendar') return { ...base, calendar: { resource: p.resource ?? null, operation: p.operation ?? null } };
  return base;
}

const modelOf = (node) => {
  const p = node.parameters ?? {};
  const m = p.model;
  const name = typeof m === 'string' ? m : (m?.value ?? m?.cachedResultName ?? p.modelName ?? null);
  return { node: node.name, type: shortType(node.type), model: name, disabled: node.disabled === true };
};

/**
 * @param {{ id: string, name: string, active?: boolean, versionId?: string | null, versionCounter?: number | null,
 *   activeVersionId?: string | null, updatedAt?: string | Date | null, nodes?: any[], connections?: any }} wf
 * @param {Record<string, { name: string | null, active: boolean | null }>} [workflowIndex] resolve alvos de toolWorkflow
 */
export function analyzeWorkflow(wf, workflowIndex = {}) {
  const nodes = wf.nodes ?? [];
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const agents = nodes.filter((n) => isAgentType(n.type)).map((agent) => {
    const tools = sourcesConnectedTo(wf.connections, agent.name, 'ai_tool')
      .map((name) => byName.get(name)).filter(Boolean)
      .map((n) => describeTool(n, workflowIndex))
      .sort((a, b) => a.code.localeCompare(b.code));
    const models = sourcesConnectedTo(wf.connections, agent.name, 'ai_languageModel')
      .map((name) => byName.get(name)).filter(Boolean).map(modelOf);
    const memory = sourcesConnectedTo(wf.connections, agent.name, 'ai_memory')
      .map((name) => byName.get(name)).filter(Boolean)
      .map((n) => ({ node: n.name, type: shortType(n.type), disabled: n.disabled === true }));
    const p = agent.parameters ?? {};
    // hash do prompt (texto + system message). O CONTEUDO nunca sai desta funcao.
    const promptHash = sha({ text: p.text ?? null, system: p.options?.systemMessage ?? null });
    const active = tools.filter((t) => !t.disabled);
    const toolSet = active.map((t) => ({ code: t.code, kind: t.kind, target: t.target?.workflowId ?? null, method: t.http?.method ?? null, host: t.http?.host ?? null }));
    const activeModels = models.filter((m) => !m.disabled).map((m) => ({ type: m.type, model: m.model }));
    const configHash = sha({ workflowId: wf.id, promptHash, models: activeModels, tools: toolSet });
    return { node: agent.name, disabled: agent.disabled === true, promptHash, models, memory, tools, toolSetHash: sha(toolSet), configHash };
  });

  const connectedTools = new Set(agents.flatMap((a) => a.tools.map((t) => t.node)));
  const orphanTools = nodes
    .filter((n) => /Tool$/.test(shortType(n.type)) && !connectedTools.has(n.name))
    .map((n) => ({ node: n.name, code: toolCode(n.name), kind: kindOf(n.type), disabled: n.disabled === true }));

  return {
    workflow: {
      id: wf.id, name: wf.name, active: wf.active === true, versionId: wf.versionId ?? null,
      versionCounter: wf.versionCounter ?? null, activeVersionId: wf.activeVersionId ?? null,
      updatedAt: wf.updatedAt ? new Date(wf.updatedAt).toISOString() : null, nodeCount: nodes.length,
    },
    agents,
    orphanTools,
  };
}

/**
 * Compara um agente do registry (data) com o inventario observado de seus workflows.
 * `registryAgent.tools` = codigos declarados; `observed` = analyzeWorkflow(...).agents[0].
 */
export function diffAgentTools(registryToolCodes, observedAgent) {
  const declared = new Set(registryToolCodes);
  const live = observedAgent.tools.filter((t) => !t.disabled).map((t) => t.code);
  const disabled = observedAgent.tools.filter((t) => t.disabled).map((t) => t.code);
  const liveSet = new Set(live);
  return {
    added: live.filter((c) => !declared.has(c)).sort(), // no workflow, nao no registry
    removed: [...declared].filter((c) => !liveSet.has(c) && !disabled.includes(c)).sort(), // no registry, ausentes do workflow
    disabledInWorkflow: disabled.filter((c) => declared.has(c)).sort(),
  };
}

export const hashOf = sha;

/**
 * Monta a entrada de VERSAO do registry a partir do inventario (nada digitado a mao).
 * @param {{ workflow: any, agent: any }} obs  saida de analyzeWorkflow (workflow + agents[0])
 * @param {{ version: string, environment: string, status: string, changelog?: string,
 *   toolIntegrations: Record<string, string | null>, modelProvider?: string, extraIntegrations?: string[] }} opts
 *   toolIntegrations: codigo da tool -> codigo da integracao (do registry ou de mapeamento por host)
 */
export function buildVersionEntry(obs, opts) {
  const { workflow, agent } = obs;
  const live = agent.tools.filter((t) => !t.disabled);
  const model = agent.models.find((m) => !m.disabled);
  const integrations = new Set([...(opts.extraIntegrations ?? []), ...(model ? [opts.modelProvider ?? 'openai'] : [])]);
  for (const t of live) {
    const code = opts.toolIntegrations[t.code];
    if (code) integrations.add(code);
  }
  return {
    version: opts.version,
    environment: opts.environment,
    status: opts.status,
    model_provider: model ? (opts.modelProvider ?? 'openai') : undefined,
    model_name: model?.model ?? undefined,
    workflow_external_id: workflow.id,
    source_revision: `n8n:${workflow.id}@${workflow.versionCounter}#${workflow.versionId}`,
    prompt_hash: agent.promptHash,
    config_hash: agent.configHash,
    changelog: opts.changelog,
    tools: live.map((t) => t.code).sort(),
    disabled_tools: agent.tools.filter((t) => t.disabled).map((t) => t.code).sort(),
    integrations: [...integrations].sort(),
  };
}
