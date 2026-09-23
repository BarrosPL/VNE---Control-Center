import { z } from 'zod';

// Registro declarativo de agentes/tools/integracoes ("agents are data").
// Este esquema NAO conhece nenhum agente especifico: nomes vem do arquivo de dados.

const code = z.string().regex(/^[a-z][a-z0-9_.]{1,63}$/, 'codigo deve ser snake_case ascii');
const level = z.enum(['low', 'medium', 'high', 'critical']);
const meta = z.record(z.string(), z.unknown()).default({});

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
const agent = z.object({
  slug: code,
  name: z.string().min(1),
  description: z.string().optional(),
  agent_type: z.string().min(1),
  status: z.enum(['draft', 'active', 'archived']),
  operational_mode: z.enum(['active', 'read_only', 'paused', 'degraded', 'disabled']),
  metadata: meta,
  version: z.object({
    version: z.string().min(1),
    environment: z.enum(['development', 'staging', 'production']),
    status: z.enum(['draft', 'candidate', 'active', 'deprecated', 'archived']),
    model_provider: z.string().optional(),
    model_name: z.string().optional(),
    workflow_external_id: z.string().optional(),
    prompt_hash: z.string().optional(),
    changelog: z.string().optional(),
  }),
  capabilities: z.array(code).default([]),
  tools: z.array(code).default([]),
  integrations: z.array(
    z.object({ code, criticality: z.enum(['low', 'normal', 'high', 'critical']), required: z.boolean() }),
  ).default([]),
});

export const registrySchema = z
  .object({
    organization: code,
    source: z.string().min(1),
    integrations: z.array(integration),
    capabilities: z.array(capability),
    tools: z.array(tool),
    agents: z.array(agent),
  })
  .superRefine((r, ctx) => {
    const dup = (label: string, values: string[]) => {
      const seen = new Set<string>();
      for (const v of values) {
        if (seen.has(v)) ctx.addIssue({ code: 'custom', message: `${label} duplicado: ${v}` });
        seen.add(v);
      }
    };
    dup('integration', r.integrations.map((i) => i.code));
    dup('capability', r.capabilities.map((c) => c.code));
    dup('tool', r.tools.map((t) => t.code));
    dup('agent', r.agents.map((a) => a.slug));

    const integrations = new Set(r.integrations.map((i) => i.code));
    const capabilities = new Set(r.capabilities.map((c) => c.code));
    const tools = new Set(r.tools.map((t) => t.code));
    for (const t of r.tools)
      if (t.integration && !integrations.has(t.integration))
        ctx.addIssue({ code: 'custom', message: `tool ${t.code}: integracao inexistente ${t.integration}` });
    for (const a of r.agents) {
      for (const c of a.capabilities)
        if (!capabilities.has(c)) ctx.addIssue({ code: 'custom', message: `agente ${a.slug}: capability inexistente ${c}` });
      for (const t of a.tools)
        if (!tools.has(t)) ctx.addIssue({ code: 'custom', message: `agente ${a.slug}: tool inexistente ${t}` });
      for (const i of a.integrations)
        if (!integrations.has(i.code)) ctx.addIssue({ code: 'custom', message: `agente ${a.slug}: integracao inexistente ${i.code}` });
      dup(`agente ${a.slug}: tool`, a.tools);
      // toda tool do agente deve estar coberta por uma integracao declarada pelo agente
      const declared = new Set(a.integrations.map((i) => i.code));
      for (const tc of a.tools) {
        const integ = r.tools.find((t) => t.code === tc)?.integration;
        if (integ && !declared.has(integ))
          ctx.addIssue({ code: 'custom', message: `agente ${a.slug}: tool ${tc} usa ${integ}, nao declarada em integrations` });
      }
    }
  });

export type Registry = z.infer<typeof registrySchema>;

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
