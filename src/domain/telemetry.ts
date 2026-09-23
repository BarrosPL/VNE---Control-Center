import { z } from 'zod';

// CONTRATO de telemetria de agentes (schema_version 1). Agnostico de agente: quem produz (n8n, um
// coletor, um SDK) envia este envelope; nada aqui conhece um agente especifico.
//
// O que NUNCA entra: texto de mensagens/prompts, segredos, payloads brutos. Mensagens sao referenciadas
// por id (payload.message_ref -> vne_mensagens.id); resumos sao curtos e gerados por maquina.

export const EVENT_TYPES = [
  'MESSAGE_RECEIVED', 'RUN_STARTED', 'TOOL_CALLED', 'TOOL_SUCCEEDED', 'TOOL_FAILED',
  'MESSAGE_SENT', 'HUMAN_REQUESTED', 'RUN_SUCCEEDED', 'RUN_FAILED', 'ERROR',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const RUN_STATUSES = ['running', 'succeeded', 'failed', 'cancelled', 'timed_out'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const TRIGGER_TYPES = ['message', 'schedule', 'webhook', 'manual', 'system', 'other'] as const;

const slug = z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/);
const source = z.string().regex(/^[a-z][a-z0-9_.-]{1,40}$/);
const kind = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/);
const ts = z.string().datetime({ offset: true }).transform((s) => new Date(s));
/** Texto livre com cara de dado pessoal (espelha acc_text_looks_personal no banco): e-mail ou 9+ digitos. */
export function looksPersonal(t: string): boolean {
  return /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(t) || /(\+?\d[\s().-]?){9,}/.test(t);
}
const PERSONAL_MSG = 'texto livre com dado pessoal (e-mail/telefone/documento) e proibido';
const freeText = (max: number) => z.string().max(max).refine((t) => !looksPersonal(t), PERSONAL_MSG);
const summary = freeText(2000);

/** Fonte da coleta Nivel A (somente-leitura do n8n): NAO grava textos livres ate haver politica de sanitizacao. */
export const LEVEL_A_SOURCE_PREFIX = 'n8n.collector';

/** Chaves proibidas em qualquer nivel de payload/metadata (PII e segredos). */
export const FORBIDDEN_KEY = /^(text|texto|content|conteudo|body|message_text|message_body|prompt|system_prompt|completion|password|senha|secret|token|api[_-]?key|authorization|cookie|email|phone|telefone)$/i;
export function findForbiddenKeys(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => findForbiddenKeys(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
      ...(FORBIDDEN_KEY.test(k) ? [`${path}.${k}`] : []),
      ...findForbiddenKeys(v, `${path}.${k}`),
    ]);
  }
  return [];
}

const boundedRecord = z
  .record(z.string(), z.unknown())
  .default({})
  .superRefine((v, ctx) => {
    const bad = findForbiddenKeys(v);
    if (bad.length) ctx.addIssue({ code: 'custom', message: `chaves proibidas (PII/segredo): ${bad.join(', ')}` });
    if (JSON.stringify(v).length > 8_000) ctx.addIssue({ code: 'custom', message: 'payload excede 8 KB' });
  });

const entity = z.object({
  type: kind,
  id: z.string().min(1).max(128),
  /** atalho quando a entidade e um lead do Kommo (ID externo) */
  lead_id: z.union([z.number().int().positive(), z.string().regex(/^\d{1,18}$/)]).transform(String).optional(),
});

export const eventInput = z
  .object({
    type: z.enum(EVENT_TYPES),
    /** idempotencia opcional; sem ela a chave e derivada de forma deterministica */
    key: z.string().min(1).max(160).optional(),
    occurred_at: ts,
    level: z.enum(['info', 'warn', 'error']).optional(),
    tool: z.object({ code: z.string().min(1).max(128) }).optional(),
    integration: z.string().regex(/^[a-z][a-z0-9_.]{1,63}$/).optional(),
    payload: boundedRecord,
  })
  .superRefine((e, ctx) => {
    if (e.type.startsWith('TOOL_') && !e.tool) ctx.addIssue({ code: 'custom', message: `${e.type} exige tool.code` });
  });

export const telemetryEnvelope = z
  .object({
    schema_version: z.literal(1),
    organization: slug,
    source,
    agent: slug, // slug do agente cadastrado (dado)
    /** como resolver a versao do agente; sem nenhum, a versao fica nao resolvida (sinalizado) */
    version: z
      .object({
        config_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
        workflow_external_id: z.string().max(100).optional(),
        workflow_version_id: z.string().max(100).optional(),
      })
      .optional(),
    correlation_id: z.string().min(1).max(128),
    entity: entity.optional(),
    /** cria/renova a sessao agente<->entidade (exige entity) */
    session: z.object({ start: z.boolean().default(true) }).optional(),
    run: z.object({
      key: z.string().min(1).max(200), // ex.: id da execucao no n8n
      trigger_type: z.enum(TRIGGER_TYPES),
      trigger_ref: freeText(200).optional(),
      started_at: ts,
      completed_at: ts.optional(),
      status: z.enum(RUN_STATUSES).optional(),
      model_provider: z.string().max(60).optional(),
      model_name: z.string().max(120).optional(),
      input_summary: summary.optional(),
      output_summary: summary.optional(),
      usage: z.object({
        input_tokens: z.number().int().min(0).optional(),
        output_tokens: z.number().int().min(0).optional(),
        estimated_cost: z.number().min(0).optional(),
      }).optional(),
      // message: SOMENTE tecnica/sanitizada (sem e-mail/telefone); vazia na coleta Nivel A
      error: z.object({ code: z.string().max(64), message: freeText(1000).optional() }).optional(),
      metadata: boundedRecord,
    }),
    events: z.array(eventInput).max(200).default([]),
  })
  .superRefine((e, ctx) => {
    if (e.session && !e.entity) ctx.addIssue({ code: 'custom', message: 'session exige entity' });
    const r = e.run;
    if (e.source.startsWith(LEVEL_A_SOURCE_PREFIX) && (r.input_summary != null || r.output_summary != null || r.error?.message != null)) {
      ctx.addIssue({ code: 'custom', message: 'coleta Nivel A nao grava input_summary, output_summary nem error.message' });
    }
    const terminal = r.status && r.status !== 'running';
    if (terminal && !r.completed_at) ctx.addIssue({ code: 'custom', message: 'run terminal exige completed_at' });
    if (!terminal && r.completed_at) ctx.addIssue({ code: 'custom', message: 'completed_at exige status terminal' });
    if (r.completed_at && r.completed_at < r.started_at) ctx.addIssue({ code: 'custom', message: 'completed_at anterior a started_at' });
    if (r.error && r.status !== 'failed' && r.status !== 'timed_out') ctx.addIssue({ code: 'custom', message: 'error so em run failed/timed_out' });
    const skew = Date.now() + 5 * 60_000;
    if (r.started_at.getTime() > skew) ctx.addIssue({ code: 'custom', message: 'started_at no futuro' });
  });

export type TelemetryEnvelope = z.infer<typeof telemetryEnvelope>;
export type TelemetryEventInput = z.infer<typeof eventInput>;

export function parseTelemetry(raw: unknown): TelemetryEnvelope {
  return telemetryEnvelope.parse(raw);
}

/** Nivel padrao por tipo (espelha acc_event_types.default_level). */
export const DEFAULT_LEVEL: Record<EventType, 'info' | 'warn' | 'error'> = {
  MESSAGE_RECEIVED: 'info', RUN_STARTED: 'info', TOOL_CALLED: 'info', TOOL_SUCCEEDED: 'info', TOOL_FAILED: 'error',
  MESSAGE_SENT: 'info', HUMAN_REQUESTED: 'warn', RUN_SUCCEEDED: 'info', RUN_FAILED: 'error', ERROR: 'error',
};
