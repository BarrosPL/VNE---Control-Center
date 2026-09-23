import { z } from 'zod';

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN, `A senha deve ter ao menos ${PASSWORD_MIN} caracteres.`)
  .max(PASSWORD_MAX)
  .refine((v) => /[a-zA-Z]/.test(v) && /\d/.test(v), 'A senha deve conter letras e números.');

export const loginSchema = z.object({
  email: emailSchema,
  // no login nao aplicamos a politica (senhas antigas) — apenas limites de tamanho.
  password: z.string().min(1).max(PASSWORD_MAX),
});

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
