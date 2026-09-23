import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAppRole } from '../../scripts/lib/app-role.mjs';
import {
  LOGIN_MAX_FAILURES,
  createUserWithPassword,
  login,
  logout,
  resolveSession,
  revokeAllSessions,
} from '../../src/server/auth/service.ts';

const PASSWORD = 'senha-de-teste-2026';
let server: EmbeddedPostgres;
let dir: string;
let owner: pg.Client; // dono: setup e adulteracao de estado
let app: pg.Client; // role limitado acc_app: usado pelo servico (prova os grants minimos)
let adminId: string;

const q = (sql: string, params?: unknown[]) => owner.query(sql, params);
const count = async (sql: string, params?: unknown[]) => Number((await q(sql, params)).rows[0].n);

beforeAll(async () => {
  const port = await new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
  dir = mkdtempSync(join(tmpdir(), 'acc-auth-'));
  server = new EmbeddedPostgres({
    databaseDir: dir, user: 'acc_test', password: 'acc_test', port, persistent: false,
    onLog: () => {}, onError: (e: unknown) => console.error('[postgres]', e),
  });
  await server.initialise();
  await server.start();
  await server.createDatabase('acc_test');
  const url = `postgres://acc_test:acc_test@127.0.0.1:${port}/acc_test`;
  const r = spawnSync(process.execPath, ['scripts/migrate.mjs', 'apply'], {
    env: { ...process.env, ACC_MIGRATE_URL: url, PGSSLMODE: 'disable' }, encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`migrate falhou: ${r.stdout}${r.stderr}`);
  owner = new pg.Client({ connectionString: url });
  await owner.connect();
  const role = await applyAppRole(owner, { roleName: 'acc_app', database: 'acc_test' });
  app = new pg.Client({ connectionString: `postgres://acc_app:${role.password}@127.0.0.1:${port}/acc_test` });
  await app.connect();
  adminId = (
    await createUserWithPassword(app, {
      name: 'Admin', email: 'Admin@Example.com', role: 'admin', password: PASSWORD, actor: { type: 'system' },
    })
  ).id;
});

afterAll(async () => {
  await app?.end().catch(() => {});
  await owner?.end().catch(() => {});
  await server?.stop().catch(() => {});
  try {
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    // Windows pode manter o arquivo bloqueado por instantes; o diretorio e temporario.
  }
});

const clearAttempts = () => q('DELETE FROM acc_login_attempts');

describe('login e sessao (executado como role acc_app)', () => {
  it('login valido cria sessao, resolve o usuario e audita atomicamente', async () => {
    const res = await login(app, { email: '  ADMIN@example.com ', password: PASSWORD, userAgent: 'vitest' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.user).toMatchObject({ id: adminId, role: 'admin', email: 'admin@example.com' });
    expect(res.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const s = await resolveSession(app, res.token);
    expect(s).toMatchObject({ id: adminId, role: 'admin' });
    expect(await count(`SELECT count(*)::int n FROM acc_audit_log WHERE action='AUTH_LOGIN' AND actor_id=$1`, [adminId])).toBe(1);
  });

  it('nunca persiste o token nem a senha; auditoria sem segredos', async () => {
    const res = await login(app, { email: 'admin@example.com', password: PASSWORD });
    if (!res.ok) throw new Error('login deveria funcionar');
    const dump = JSON.stringify(
      (await q(`SELECT to_jsonb(s) AS r FROM acc_sessions s UNION ALL SELECT to_jsonb(a) FROM acc_audit_log a UNION ALL SELECT to_jsonb(t) FROM acc_login_attempts t`)).rows,
    );
    expect(dump).not.toContain(res.token);
    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain('scrypt$');
    expect(await count(`SELECT count(*)::int n FROM acc_audit_log WHERE action='USER_CREATED' AND after_state::text LIKE '%hash%'`)).toBe(0);
  });

  it('senha errada e e-mail inexistente retornam o mesmo resultado (sem enumeracao)', async () => {
    await clearAttempts();
    const wrong = await login(app, { email: 'admin@example.com', password: 'errada-123456' });
    const unknown = await login(app, { email: 'ninguem@example.com', password: 'errada-123456' });
    expect(wrong).toEqual({ ok: false, reason: 'invalid' });
    expect(unknown).toEqual({ ok: false, reason: 'invalid' });
  });

  it('bloqueia apos falhas consecutivas, mesmo com a senha correta; libera fora da janela', async () => {
    await clearAttempts();
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
      expect(await login(app, { email: 'admin@example.com', password: 'errada-123456' })).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(await login(app, { email: 'admin@example.com', password: PASSWORD })).toEqual({ ok: false, reason: 'locked' });
    // outro e-mail nao e afetado
    expect(await login(app, { email: 'outro@example.com', password: 'x-123456789012' })).toEqual({ ok: false, reason: 'invalid' });
    await q(`UPDATE acc_login_attempts SET attempted_at = now() - interval '1 hour'`);
    expect((await login(app, { email: 'admin@example.com', password: PASSWORD })).ok).toBe(true);
  });

  it('login bem-sucedido zera a contagem de falhas', async () => {
    await clearAttempts();
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) await login(app, { email: 'admin@example.com', password: 'errada-123456' });
    expect((await login(app, { email: 'admin@example.com', password: PASSWORD })).ok).toBe(true);
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) await login(app, { email: 'admin@example.com', password: 'errada-123456' });
    expect((await login(app, { email: 'admin@example.com', password: PASSWORD })).ok).toBe(true);
  });

  it('sessao invalida: token desconhecido, vazio, expirada, inativa por ociosidade, revogada', async () => {
    await clearAttempts();
    expect(await resolveSession(app, undefined)).toBeNull();
    expect(await resolveSession(app, 'token-inexistente')).toBeNull();
    expect(await resolveSession(app, 'x'.repeat(500))).toBeNull();

    const mk = async () => {
      const r = await login(app, { email: 'admin@example.com', password: PASSWORD });
      if (!r.ok) throw new Error('login');
      return r.token;
    };
    const expired = await mk();
    await q(`UPDATE acc_sessions SET expires_at = now() - interval '1 second' WHERE token_hash = encode(sha256($1::bytea),'hex')`, [expired]);
    expect(await resolveSession(app, expired)).toBeNull();

    const idle = await mk();
    await q(`UPDATE acc_sessions SET last_seen_at = now() - interval '3 hours' WHERE token_hash = encode(sha256($1::bytea),'hex')`, [idle]);
    expect(await resolveSession(app, idle)).toBeNull();
  });

  it('atividade renova last_seen_at somente quando defasado', async () => {
    const r = await login(app, { email: 'admin@example.com', password: PASSWORD });
    if (!r.ok) throw new Error('login');
    const where = `token_hash = encode(sha256($1::bytea),'hex')`;
    const seen = async () => String((await q(`SELECT last_seen_at FROM acc_sessions WHERE ${where}`, [r.token])).rows[0].last_seen_at);
    const first = await seen();
    await resolveSession(app, r.token);
    expect(await seen()).toBe(first); // < 60s: nao escreve a cada request
    await q(`UPDATE acc_sessions SET last_seen_at = now() - interval '5 minutes' WHERE ${where}`, [r.token]);
    const stale = await seen();
    await resolveSession(app, r.token);
    expect(await seen()).not.toBe(stale);
  });

  it('logout revoga, audita uma unica vez e e idempotente', async () => {
    const r = await login(app, { email: 'admin@example.com', password: PASSWORD });
    if (!r.ok) throw new Error('login');
    const before = await count(`SELECT count(*)::int n FROM acc_audit_log WHERE action='AUTH_LOGOUT'`);
    await logout(app, r.token);
    await logout(app, r.token);
    expect(await resolveSession(app, r.token)).toBeNull();
    expect(await count(`SELECT count(*)::int n FROM acc_audit_log WHERE action='AUTH_LOGOUT'`)).toBe(before + 1);
  });

  it('usuario inativo nao autentica e sessoes existentes deixam de valer', async () => {
    const other = await createUserWithPassword(app, {
      name: 'Viewer', email: 'viewer@example.com', role: 'viewer', password: PASSWORD, actor: { type: 'human', id: adminId },
    });
    const r = await login(app, { email: 'viewer@example.com', password: PASSWORD });
    if (!r.ok) throw new Error('login');
    expect((await resolveSession(app, r.token))?.role).toBe('viewer');
    await q(`UPDATE acc_users SET status='inactive' WHERE id=$1`, [other.id]);
    expect(await resolveSession(app, r.token)).toBeNull();
    expect(await login(app, { email: 'viewer@example.com', password: PASSWORD })).toEqual({ ok: false, reason: 'invalid' });
  });

  it('revokeAllSessions revoga todas e audita; sem sessoes nao audita', async () => {
    const u = await createUserWithPassword(app, {
      name: 'Spec', email: 'spec@example.com', role: 'specialist', password: PASSWORD, actor: { type: 'system' },
    });
    const t1 = await login(app, { email: 'spec@example.com', password: PASSWORD });
    const t2 = await login(app, { email: 'spec@example.com', password: PASSWORD });
    if (!t1.ok || !t2.ok) throw new Error('login');
    expect(await revokeAllSessions(app, u.id, { type: 'human', id: adminId }, 'teste')).toBe(2);
    expect(await resolveSession(app, t1.token)).toBeNull();
    expect(await resolveSession(app, t2.token)).toBeNull();
    const audits = await count(`SELECT count(*)::int n FROM acc_audit_log WHERE action='AUTH_SESSIONS_REVOKED' AND target_id=$1`, [u.id]);
    expect(await revokeAllSessions(app, u.id, { type: 'human', id: adminId }, 'teste')).toBe(0);
    expect(await count(`SELECT count(*)::int n FROM acc_audit_log WHERE action='AUTH_SESSIONS_REVOKED' AND target_id=$1`, [u.id])).toBe(audits);
  });

  it('e-mail duplicado (case-insensitive) e rejeitado sem criar credencial orfa', async () => {
    const before = await count('SELECT count(*)::int n FROM acc_user_credentials');
    await expect(
      createUserWithPassword(app, { name: 'Dup', email: 'ADMIN@example.com', role: 'viewer', password: PASSWORD, actor: { type: 'system' } }),
    ).rejects.toMatchObject({ code: '23505' });
    expect(await count('SELECT count(*)::int n FROM acc_user_credentials')).toBe(before);
  });
});
