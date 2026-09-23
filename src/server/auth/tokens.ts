import { createHash, randomBytes } from 'node:crypto';

/** Token opaco de sessao (256 bits). So o hash sha256 e persistido. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Identificador de rate limit: hash do e-mail normalizado (sem guardar o e-mail). */
export function hashIdentifier(normalizedEmail: string): string {
  return createHash('sha256').update(`login:${normalizedEmail}`).digest('hex');
}
