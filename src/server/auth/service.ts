import { normalizeEmail } from '../../domain/credentials.ts';
import { isRole, type Role } from '../../domain/rbac.ts';
import type { Queryable } from './db.ts';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password.ts';
import { generateSessionToken, hashIdentifier, hashToken } from './tokens.ts';

export const SESSION_ABSOLUTE_SECONDS = 12 * 60 * 60; // expira em 12h, independente de uso
export const SESSION_IDLE_SECONDS = 2 * 60 * 60; // expira apos 2h sem atividade
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_WINDOW_MINUTES = 15;
const TOUCH_INTERVAL_SECONDS = 60;

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export type LoginResult =
  | { ok: true; token: string; expiresAt: Date; user: SessionUser }
  | { ok: false; reason: 'invalid' | 'locked' };

const str = (v: unknown) => String(v);

/**
 * Login com rate limit por e-mail, hash em tempo (quase) constante e auditoria atomica:
 * a sessao e o registro de auditoria sao gravados no MESMO statement (CTE).
 */
export async function login(
  db: Queryable,
  input: { email: string; password: string; userAgent?: string | null; correlationId?: string | null },
): Promise<LoginResult> {
  const email = normalizeEmail(input.email);
  const idHash = hashIdentifier(email);

  const failures = await db.query(
    `SELECT count(*)::int AS n FROM acc_login_attempts
      WHERE identifier_hash = $1 AND NOT succeeded
        AND attempted_at > now() - make_interval(mins => $2)
        AND attempted_at > COALESCE(
              (SELECT max(attempted_at) FROM acc_login_attempts WHERE identifier_hash = $1 AND succeeded),
              '-infinity')`,
    [idHash, LOGIN_WINDOW_MINUTES],
  );
  if (Number(failures.rows[0].n) >= LOGIN_MAX_FAILURES) return { ok: false, reason: 'locked' };

  const found = await db.query(
    `SELECT u.id, u.name, u.email, u.role, c.password_hash
       FROM acc_users u JOIN acc_user_credentials c ON c.user_id = u.id
      WHERE lower(u.email) = $1 AND u.status = 'active'`,
    [email],
  );
  const row = found.rows[0];
  const valid = row
    ? await verifyPassword(input.password, str(row.password_hash))
    : await verifyAgainstDummy(input.password);

  await db.query('INSERT INTO acc_login_attempts (identifier_hash, succeeded) VALUES ($1, $2)', [
    idHash,
    valid,
  ]);
  if (!valid || !row || !isRole(row.role)) return { ok: false, reason: 'invalid' };

  const token = generateSessionToken();
  const created = await db.query(
    `WITH s AS (
       INSERT INTO acc_sessions (user_id, token_hash, expires_at, user_agent)
       VALUES ($1, $2, now() + make_interval(secs => $3), $4)
       RETURNING id, expires_at
     ), a AS (
       INSERT INTO acc_audit_log (actor_type, actor_id, action, target_type, target_id, correlation_id, after_state)
       SELECT 'human', $1::uuid, 'AUTH_LOGIN', 'session', s.id::text, $5::text,
              jsonb_build_object('expires_at', s.expires_at)
         FROM s
     )
     SELECT expires_at FROM s`,
    [row.id, hashToken(token), SESSION_ABSOLUTE_SECONDS, input.userAgent?.slice(0, 300) ?? null, input.correlationId ?? null],
  );
  return {
    ok: true,
    token,
    expiresAt: new Date(str(created.rows[0].expires_at)),
    user: { id: str(row.id), name: str(row.name), email: str(row.email), role: row.role },
  };
}

/** Resolve o token para o usuario (ou null): valida expiracao, inatividade, revogacao e status. */
export async function resolveSession(
  db: Queryable,
  token: string | undefined,
): Promise<(SessionUser & { sessionId: string }) | null> {
  if (!token || token.length > 200) return null;
  const { rows } = await db.query(
    `SELECT s.id AS session_id, u.id, u.name, u.email, u.role,
            (s.last_seen_at < now() - make_interval(secs => $3)) AS stale
       FROM acc_sessions s JOIN acc_users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND s.last_seen_at > now() - make_interval(secs => $2) AND u.status = 'active'`,
    [hashToken(token), SESSION_IDLE_SECONDS, TOUCH_INTERVAL_SECONDS],
  );
  const r = rows[0];
  if (!r || !isRole(r.role)) return null;
  if (r.stale) await db.query('UPDATE acc_sessions SET last_seen_at = now() WHERE id = $1', [r.session_id]);
  return { sessionId: str(r.session_id), id: str(r.id), name: str(r.name), email: str(r.email), role: r.role };
}

/** Revoga a sessao do token e audita (atomico). Idempotente. */
export async function logout(db: Queryable, token: string | undefined, reason = 'logout'): Promise<void> {
  if (!token) return;
  await db.query(
    `WITH r AS (
       UPDATE acc_sessions SET revoked_at = now(), revoked_reason = $2
        WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id, user_id
     )
     INSERT INTO acc_audit_log (actor_type, actor_id, action, target_type, target_id, reason)
     SELECT 'human', user_id, 'AUTH_LOGOUT', 'session', id::text, $2::text FROM r`,
    [hashToken(token), reason],
  );
}

/** Revoga todas as sessoes de um usuario (ex.: desativacao, troca de senha). */
export async function revokeAllSessions(
  db: Queryable,
  userId: string,
  actor: { type: 'human' | 'system'; id?: string | null },
  reason: string,
): Promise<number> {
  const res = await db.query(
    `WITH r AS (
       UPDATE acc_sessions SET revoked_at = now(), revoked_reason = $2
        WHERE user_id = $1 AND revoked_at IS NULL RETURNING id
     ), a AS (
       INSERT INTO acc_audit_log (actor_type, actor_id, action, target_type, target_id, reason, after_state)
       SELECT $3::text, $4::uuid, 'AUTH_SESSIONS_REVOKED', 'user', $1::text, $2::text, jsonb_build_object('count', count(*)) FROM r
        HAVING count(*) > 0
     )
     SELECT count(*)::int AS n FROM r`,
    [userId, reason, actor.type, actor.id ?? null],
  );
  return Number(res.rows[0].n);
}

/**
 * Cria usuario com senha (bootstrap/administracao). Requer que o chamador ja tenha autorizado
 * a acao (`users:manage`) — a autorizacao vive em guards.ts, nao aqui.
 */
export async function createUserWithPassword(
  db: Queryable,
  input: {
    name: string;
    email: string;
    role: Role;
    password: string;
    actor: { type: 'human' | 'system'; id?: string | null };
    mustChangePassword?: boolean;
  },
): Promise<{ id: string }> {
  const hash = await hashPassword(input.password);
  const email = normalizeEmail(input.email);
  const res = await db.query(
    `WITH u AS (
       INSERT INTO acc_users (name, email, role) VALUES ($1, $2, $3) RETURNING id
     ), c AS (
       INSERT INTO acc_user_credentials (user_id, password_hash, must_change_password)
       SELECT id, $4, $5 FROM u
     ), a AS (
       INSERT INTO acc_audit_log (actor_type, actor_id, action, target_type, target_id, after_state)
       SELECT $6::text, $7::uuid, 'USER_CREATED', 'user', id::text,
              jsonb_build_object('email', $2::text, 'role', $3::text)
         FROM u
     )
     SELECT id FROM u`,
    [input.name, email, input.role, hash, input.mustChangePassword ?? false, input.actor.type, input.actor.id ?? null],
  );
  return { id: str(res.rows[0].id) };
}
