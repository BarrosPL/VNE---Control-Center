import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLES, can, isRole, permissionsFor, type Permission } from '../src/domain/rbac.ts';
import { loginSchema, passwordSchema } from '../src/domain/credentials.ts';
import { hashPassword, verifyPassword } from '../src/server/auth/password.ts';
import { generateSessionToken, hashIdentifier, hashToken } from '../src/server/auth/tokens.ts';
import { sanitizeForAudit } from '../src/server/auth/audit.ts';

describe('RBAC', () => {
  it('hierarquia monotona: cada papel superior contem o inferior', () => {
    for (let i = 1; i < ROLES.length; i++) {
      const lower = new Set(permissionsFor(ROLES[i - 1]));
      const higher = new Set(permissionsFor(ROLES[i]));
      for (const p of lower) expect(higher.has(p), `${ROLES[i]} deveria ter ${p}`).toBe(true);
    }
  });

  it('admin tem todas as permissoes; viewer nao escreve nem controla nada', () => {
    for (const p of PERMISSIONS) expect(can('admin', p)).toBe(true);
    const writes = PERMISSIONS.filter((p) => /:(write|control|respond|assign|approve|manage)$/.test(p));
    for (const p of writes) expect(can('viewer', p), p).toBe(false);
  });

  it('acoes sensiveis exigem manager ou admin', () => {
    const managerOnly: Permission[] = ['agents:control', 'requests:assign', 'knowledge:approve', 'audit:read'];
    for (const p of managerOnly) {
      expect(can('specialist', p), p).toBe(false);
      expect(can('manager', p), p).toBe(true);
    }
    for (const p of ['users:manage', 'settings:write', 'routing:manage', 'policies:manage'] as Permission[]) {
      expect(can('manager', p), p).toBe(false);
    }
  });

  it('conteudo de conversa (dados pessoais) exige specialist ou superior; viewer so ve metadados', () => {
    expect(can('viewer', 'entities:read')).toBe(true);
    expect(can('viewer', 'conversations:read')).toBe(false);
    for (const role of ['specialist', 'manager', 'admin']) expect(can(role, 'conversations:read')).toBe(true);
  });

  it('fail closed: papel desconhecido, nulo ou permissao inexistente => negado', () => {
    expect(can('root', 'agents:read')).toBe(false);
    expect(can(undefined, 'agents:read')).toBe(false);
    expect(can('admin', 'nope:nope' as Permission)).toBe(false);
    expect(permissionsFor('root')).toEqual([]);
    expect(isRole('viewer')).toBe(true);
    expect(isRole('Admin')).toBe(false);
  });
});

describe('credenciais: validacao', () => {
  it('politica de senha', () => {
    expect(passwordSchema.safeParse('curta1').success).toBe(false);
    expect(passwordSchema.safeParse('somente-letras-aqui').success).toBe(false);
    expect(passwordSchema.safeParse('senha-segura-2026').success).toBe(true);
    expect(passwordSchema.safeParse('a1'.repeat(70)).success).toBe(false); // > 128
  });

  it('login normaliza e valida e-mail', () => {
    const ok = loginSchema.parse({ email: '  User@Example.COM ', password: 'x' });
    expect(ok.email).toBe('user@example.com');
    expect(loginSchema.safeParse({ email: 'nao-e-email', password: 'x' }).success).toBe(false);
    expect(loginSchema.safeParse({ email: 'a@b.co', password: '' }).success).toBe(false);
  });
});

describe('senha (scrypt)', () => {
  it('hash verifica; senha errada falha; salt aleatorio', async () => {
    const h1 = await hashPassword('senha-correta-123');
    const h2 = await hashPassword('senha-correta-123');
    expect(h1).not.toBe(h2);
    expect(h1.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('senha-correta-123', h1)).toBe(true);
    expect(await verifyPassword('senha-errada-123', h1)).toBe(false);
  });

  it('formato invalido ou adulterado => falso (sem lancar)', async () => {
    expect(await verifyPassword('x', 'lixo')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$1$2$3$a$b')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$a$b$c$d$e')).toBe(false);
  });

  it('nao guarda a senha em claro no hash', async () => {
    expect(await hashPassword('senha-correta-123')).not.toContain('senha-correta-123');
  });
});

describe('tokens', () => {
  it('token tem entropia alta, e unico e o hash e deterministico', () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(hashToken(a)).toBe(hashToken(a));
    expect(hashToken(a)).not.toBe(a);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('identificador de rate limit nao contem o e-mail', () => {
    expect(hashIdentifier('a@b.com')).not.toContain('a@b.com');
  });
});

describe('auditoria: sanitizacao de segredos', () => {
  it('redige chaves sensiveis em qualquer profundidade', () => {
    const out = sanitizeForAudit({
      email: 'a@b.com',
      password: 'x',
      password_hash: 'y',
      nested: { apiKey: 'k', Authorization: 'Bearer z', ok: 1, list: [{ token: 't', keep: 'v' }] },
    });
    expect(out).toEqual({
      email: 'a@b.com',
      password: '[REDACTED]',
      password_hash: '[REDACTED]',
      nested: { apiKey: '[REDACTED]', Authorization: '[REDACTED]', ok: 1, list: [{ token: '[REDACTED]', keep: 'v' }] },
    });
  });
});
