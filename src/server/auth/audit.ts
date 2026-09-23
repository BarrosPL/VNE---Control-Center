import type { Queryable } from './db.ts';

export type ActorType = 'human' | 'agent' | 'system';

export interface AuditEntry {
  organizationId?: string | null;
  actorType: ActorType;
  actorId?: string | null;
  action: string;
  targetType: string;
  targetId: string;
  correlationId?: string | null;
  reason?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

const SECRET_KEY = /pass(word)?|secret|token|hash|api[_-]?key|authorization|cookie/i;

/** Remove recursivamente qualquer chave que pareca segredo antes de gravar em before/after. */
export function sanitizeForAudit<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => sanitizeForAudit(v)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SECRET_KEY.test(k) ? '[REDACTED]' : sanitizeForAudit(v),
      ]),
    ) as T;
  }
  return value;
}

export async function recordAudit(db: Queryable, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO acc_audit_log
       (organization_id, actor_type, actor_id, action, target_type, target_id,
        correlation_id, reason, before_state, after_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)`,
    [
      e.organizationId ?? null,
      e.actorType,
      e.actorId ?? null,
      e.action,
      e.targetType,
      e.targetId,
      e.correlationId ?? null,
      e.reason ?? null,
      e.before ? JSON.stringify(sanitizeForAudit(e.before)) : null,
      e.after ? JSON.stringify(sanitizeForAudit(e.after)) : null,
    ],
  );
}

/**
 * Registra a visualizacao de dados pessoais (conteudo de conversa) de uma entidade.
 * Deduplica por usuario+entidade em 10 minutos para nao inundar a trilha com refreshes.
 */
export async function recordEntityView(
  db: Queryable,
  e: { actorId: string; entityType: string; entityId: string; reason: string },
): Promise<void> {
  await db.query(
    `INSERT INTO acc_audit_log (actor_type, actor_id, action, target_type, target_id, reason)
     SELECT 'human', $1::uuid, 'ENTITY_VIEWED', $2::text, $3::text, $4::text
      WHERE NOT EXISTS (
        SELECT 1 FROM acc_audit_log
         WHERE action = 'ENTITY_VIEWED' AND actor_id = $1::uuid AND target_type = $2::text
           AND target_id = $3::text AND created_at > now() - interval '10 minutes')`,
    [e.actorId, e.entityType, e.entityId, e.reason],
  );
}
