'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { loginSchema } from '../../domain/credentials.ts';
import { login, logout } from '../../server/auth/service.ts';
import { getDb } from '../../server/db.ts';
import {
  clearSessionCookie,
  readSessionToken,
  writeSessionCookie,
} from '../../server/session-cookie.ts';

export type LoginState = { message?: string } | undefined;

// Mensagens genericas: nao revelam se o e-mail existe.
const INVALID = 'E-mail ou senha inválidos.';
const LOCKED = 'Muitas tentativas. Aguarde alguns minutos e tente novamente.';

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) return { message: INVALID };

  const result = await login(getDb(), {
    ...parsed.data,
    userAgent: (await headers()).get('user-agent'),
  });
  if (!result.ok) return { message: result.reason === 'locked' ? LOCKED : INVALID };

  await writeSessionCookie(result.token, result.expiresAt);
  redirect('/');
}

export async function logoutAction(): Promise<void> {
  await logout(getDb(), await readSessionToken());
  await clearSessionCookie();
  redirect('/login');
}
