import { z } from 'zod';

// Registro declarativo de agentes/tools/integracoes ("agents are data"), FORMATO v2.
// Este esquema NAO conhece nenhum agente especifico: nomes vem do arquivo de dados.
//
// v2: cada agente tem VERSOES. Cada versao carrega o que foi OBSERVADO no workflow (tools, integracoes,
// modelo, hashes de prompt/configuracao, revisao de origem). A POLITICA do Control Center
// (permission_mode, status, modo operacional) nunca vem deste arquivo depois da criacao.

const code = z.string().regex(/^[a-z][a-z0-9_.]{1,63}$/, 'codigo deve ser snake_case ascii');
const level = z.enum(['low', 'medium', 'high', 'critical']);
const meta = z.record(z.string(), z.unknown()).default({});
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'hash deve ser sha256 hexadecimal minusculo');

const integration = z.object({
  code,
  name: z.string().min(1),
  integration_type: z.string().min(1),
  metadata: meta,
});
const capability = z.object({
  code,
  name: z.string().min(1),
  description: z.string().optional(),
  risk_level: level,
});
const tool = z.object({
  code,
  name: z.string().min(1),
  description: z.string().optional(),
  tool_type: z.string().min(1),
  mutation_level: z.enum(['read', 'write', 'destructive']),
  risk_level: level,
  integration: code.optional(),
  external_reference: z.string().optional(),
  metadata: meta,
});

const version = z.object({
  version: z.string().min(1).max(100),
  environment: z.enum(['development', 'staging', 'production']),
  status: z.enum(['draft', 'candidate', 'active', 'deprecated', 'archived']),
  model_provider: z.string().optional(),
  model_name: z.string().optional(),
  workflow_external_id: z.string().optional(),
  // procedencia OBRIGATORIA: sem ela nao ha como provar de onde veio a configuracao
  source_revision: z.string().min(3).max(300),
  prompt_hash: sha256,
  config_hash: sha256,
  changelog: z.string().optional(),
  // OBSERVADO no workflow desta versao
  tools: z.array(code).default([]),
  disabled_tools: z.array(code).default([]),
  integrations: z.array(code).default([]),
});

const agent = z.object({
  slug: code,
  name: z.string().min(1),
  description: z.string().optional(),
  agent_type: z.string().min(1),
  // valores INICIAIS (so na criacao): depois disso pertencem ao Control Center
  status: z.enum(['draft', 'active', 'archived']),
  operational_mode: z.enum(['active', 'read_only', 'paused', 'degraded', 'disabled']),
  metadata: meta,
  versions: z.array(version).min(1),
  capabilities: z.array(code).default([]),
  // dependencias declaradas (politica: criticidade/obrigatoriedade)
  integrations: z.array(
    z.object({ code, criticality: z.enum(['low', 'normal', 'high', 'critical']), required: z.boolean() }),
  ).default([]),
});

export const registrySchema = z
  .object({
    schema: z.literal(2),
    organization: code,
    source: z.string().min(1),
    integrations: z.array(integration),
    capabilities: z.array(capability),
    tools: z.array(tool),
    agents: z.array(agent),
  })
  .superRefine((r, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    const dup = (label: string, values: string[]) => {
      const seen = new Set<string>();
      for (const v of values) {
        if (seen.has(v)) issue(`${label} duplicado: ${v}`);
        seen.add(v);
      }
    };
    dup('integration', r.integrations.map((i) => i.code));
    dup('capability', r.capabilities.map((c) => c.code));
    dup('tool', r.tools.map((t) => t.code));
    dup('agent', r.agents.map((a) => a.slug));

    const integrations = new Set(r.integrations.map((i) => i.code));
    const capabilities = new Set(r.capabilities.map((c) => c.code));
    const tools = new Map(r.tools.map((t) => [t.code, t]));
    for (const t of r.tools)
      if (t.integration && !integrations.has(t.integration)) issue(`tool ${t.code}: integracao inexistente ${t.integration}`);

    for (const a of r.agents) {
      for (const c of a.capabilities) if (!capabilities.has(c)) issue(`agente ${a.slug}: capability inexistente ${c}`);
      for (const i of a.integrations) if (!integrations.has(i.code)) issue(`agente ${a.slug}: integracao inexistente ${i.code}`);
      dup(`agente ${a.slug}: integracao declarada`, a.integrations.map((i) => i.code));
      dup(`agente ${a.slug}: versao`, a.versions.map((v) => `${v.environment}/${v.version}`));
      dup(`agente ${a.slug}: config_hash por ambiente`, a.versions.map((v) => `${v.environment}/${v.config_hash}`));

      const declared = new Set(a.integrations.map((i) => i.code));
      for (const v of a.versions) {
        const where = `agente ${a.slug} versao ${v.environment}/${v.version}`;
        dup(`${where}: tool`, v.tools);
        for (const tc of [...v.tools, ...v.disabled_tools]) {
          const def = tools.get(tc);
          if (!def) {
            issue(`${where}: tool inexistente ${tc}`);
            continue;
          }
          // a tool exige que a versao OBSERVE a integracao que ela usa
          if (def.integration && v.tools.includes(tc) && !v.integrations.includes(def.integration))
            issue(`${where}: tool ${tc} usa ${def.integration}, ausente em integrations da versao`);
        }
        for (const t of v.disabled_tools) if (v.tools.includes(t)) issue(`${where}: tool ${t} nao pode estar ativa e desabilitada`);
        for (const i of v.integrations) {
          if (!integrations.has(i)) issue(`${where}: integracao inexistente ${i}`);
          if (!declared.has(i)) issue(`${where}: integracao ${i} nao declarada em agents[].integrations`);
        }
      }
      // no maximo UMA versao ativa por ambiente (espelha o indice unico do banco)
      for (const env of ['development', 'staging', 'production'] as const) {
        const actives = a.versions.filter((v) => v.environment === env && v.status === 'active');
        if (actives.length > 1) issue(`agente ${a.slug}: mais de uma versao ativa em ${env}`);
      }
    }
  });

export type Registry = z.infer<typeof registrySchema>;
export type RegistryVersion = Registry['agents'][number]['versions'][number];

/** Segredos nunca entram no registro: rejeita chaves com aparencia de credencial. */
const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|authorization|credential/i;
export function findSecretKeys(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => findSecretKeys(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
      ...(SECRET_KEY.test(k) ? [`${path}.${k}`] : []),
      ...findSecretKeys(v, `${path}.${k}`),
    ]);
  }
  return [];
}

export function parseRegistry(raw: unknown): Registry {
  const leaked = findSecretKeys(raw);
  if (leaked.length) throw new Error(`Registro contem chaves com aparencia de segredo: ${leaked.join(', ')}`);
  return registrySchema.parse(raw);
}

/** Versao "de producao em vigor" declarada no registro (ativa no ambiente production), se houver. */
export function productionVersion(a: Registry['agents'][number]): RegistryVersion | undefined {
  return a.versions.find((v) => v.environment === 'production' && v.status === 'active');
}
