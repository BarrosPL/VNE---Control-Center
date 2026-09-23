import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { can, type Permission } from '../domain/rbac.ts';
import { resolveSession, type SessionUser } from './auth/service.ts';
import { getDb } from './db.ts';
import { readSessionToken } from './session-cookie.ts';

export class ForbiddenError extends Error {
  readonly code = 'FORBIDDEN';
  constructor(readonly permission: Permission) {
    super(`Permissao negada: ${permission}`);
  }
}

/** Sessao valida do request atual (memoizada por request) ou null. */
export const getSession = cache(async (): Promise<(SessionUser & { sessionId: string }) | null> =>
  resolveSession(getDb(), await readSessionToken()),
);

/** Data Access Layer: TODA pagina/acao protegida chama isto (o proxy e apenas otimista). */
export async function requireUser(): Promise<SessionUser & { sessionId: string }> {
  const session = await getSession();
  if (!session) redirect('/login');
  return session;
}

/** Autorizacao no backend. Server Actions e Route Handlers devem chamar antes de qualquer mutacao. */
export async function requirePermission(
  permission: Permission,
): Promise<SessionUser & { sessionId: string }> {
  const user = await requireUser();
  if (!can(user.role, permission)) throw new ForbiddenError(permission);
  return user;
}

/** Para paginas: retorna o usuario e se ele tem a permissao (a pagina renderiza <Forbidden/> se nao). */
export async function checkPermission(
  permission: Permission,
): Promise<{ user: SessionUser & { sessionId: string }; allowed: boolean }> {
  const user = await requireUser();
  return { user, allowed: can(user.role, permission) };
}
