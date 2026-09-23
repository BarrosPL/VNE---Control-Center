// Teste de integracao das migrations em um Postgres REAL e DESCARTAVEL (embedded-postgres).
// Nunca toca em producao: sobe uma instancia temporaria em 127.0.0.1 e a destroi ao final.
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { applyAppRole } from './lib/app-role.mjs';

const PORT = await new Promise((resolve, reject) => {
  const srv = createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});
const dir = mkdtempSync(join(tmpdir(), 'acc-pg-'));
const server = new EmbeddedPostgres({
  databaseDir: dir,
  user: 'acc_test',
  password: 'acc_test',
  port: PORT,
  persistent: false,
  onLog: () => {},
  onError: (e) => console.error('[postgres-error]', e?.message ?? e),
});
const URL_ = `postgres://acc_test:acc_test@127.0.0.1:${PORT}/acc_test`;
const RUNNER = fileURLToPath(new URL('./migrate.mjs', import.meta.url));
const run = (cmd, ...args) =>
  spawnSync(process.execPath, [RUNNER, cmd, ...args], {
    env: { ...process.env, ACC_MIGRATE_URL: URL_, PGSSLMODE: 'disable' },
    encoding: 'utf8',
  });

const FOUNDATION = [
  'organizations', 'business_units', 'users', 'teams', 'team_members', 'agents', 'agent_versions',
  'capabilities', 'agent_capabilities', 'tools', 'agent_tools', 'integrations', 'agent_integrations',
].map((t) => `acc_${t}`);

const AUTH_AUDIT = ['acc_user_credentials', 'acc_sessions', 'acc_login_attempts', 'acc_audit_log'];
const ALL_TABLES = [...FOUNDATION, ...AUTH_AUDIT];

let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed++;
  console.log(`ok  - ${name}`);
};
const rejects = async (sqlPromise, code) => {
  await assert.rejects(sqlPromise, (e) => (code ? e.code === code : true));
};

try {
  await server.initialise();
  await server.start();
  await server.createDatabase('acc_test');
  const db = new pg.Client({ connectionString: URL_ });
  await db.connect();
  const q = (s, p) => db.query(s, p);
  const tableCount = async (like) =>
    (await q(`SELECT count(*)::int n FROM pg_tables WHERE schemaname='public' AND tablename LIKE $1`, [like])).rows[0].n;

  // tabela vne_* fictica: deve sobreviver intacta ao up e ao down
  await q(`CREATE TABLE vne_probe (id int PRIMARY KEY, v text)`);
  await q(`INSERT INTO vne_probe VALUES (1, 'intacto')`);
  // imita producao: role de OUTRO app recebe grants automaticos em tabelas novas do dono
  await q(`CREATE ROLE other_app LOGIN PASSWORD 'x'`);
  await q(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO other_app`);
  await q(`CREATE TABLE workflow_entity (id int)`);
  await q(`CREATE TABLE vne_mensagens (id int, texto text)`);
  await q(`INSERT INTO vne_mensagens VALUES (1, 'oi')`);
  const anyAccPriv = async (role) =>
    (await q(
      `SELECT count(*)::int n FROM pg_tables t WHERE schemaname='public' AND tablename LIKE 'acc\_%'
         AND has_table_privilege($1, format('public.%I', tablename), 'SELECT,INSERT,UPDATE,DELETE')`,
      [role],
    )).rows[0].n;

  await check('preview nao altera o banco', async () => {
    const r = run('preview');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(await tableCount('acc\\_%'), 0);
  });

  await check('apply cria as 13 tabelas + auth + audit + acc_migrations', async () => {
    const r = run('apply');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    for (const t of ALL_TABLES) assert.equal(await tableCount(t), 1, `falta ${t}`);
    assert.equal(await tableCount('acc\\_migrations'), 1);
  });

  await check('hardening: role de outro app NAO herda acesso as tabelas acc_*', async () => {
    assert.equal(await anyAccPriv('other_app'), 0);
    for (const t of [...ALL_TABLES, 'acc_migrations'])
      assert.equal((await q(`SELECT has_table_privilege('other_app', $1, 'SELECT') p`, [`public.${t}`])).rows[0].p, false, t);
  });

  await check('apply e idempotente (nada pendente na 2a execucao)', async () => {
    const r = run('apply');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal((await q(`SELECT count(*)::int n FROM acc_migrations`)).rows[0].n, 4);
  });

  await check('seed cria somente a organizacao VNE', async () => {
    assert.deepEqual((await q(`SELECT slug FROM acc_organizations`)).rows, [{ slug: 'vne' }]);
    assert.equal((await q(`SELECT count(*)::int n FROM acc_business_units`)).rows[0].n, 0);
    assert.equal((await q(`SELECT count(*)::int n FROM acc_agents`)).rows[0].n, 0);
  });

  await check('verify passa', async () => {
    const r = run('verify');
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  await check('tabelas vne_* nao foram tocadas', async () => {
    assert.deepEqual((await q(`SELECT id, v FROM vne_probe`)).rows, [{ id: 1, v: 'intacto' }]);
  });

  const org = (await q(`SELECT id FROM acc_organizations WHERE slug='vne'`)).rows[0].id;

  await check('agente nasce paused/draft e rejeita modo invalido', async () => {
    const a = await q(
      `INSERT INTO acc_agents (organization_id, slug, name, agent_type) VALUES ($1,'a1','A1','generic')
       RETURNING operational_mode, status`, [org]);
    assert.deepEqual(a.rows[0], { operational_mode: 'paused', status: 'draft' });
    await rejects(q(`UPDATE acc_agents SET operational_mode='banana' WHERE slug='a1'`), '23514');
  });

  await check('somente uma versao ativa por agente/ambiente', async () => {
    const agent = (await q(`SELECT id FROM acc_agents WHERE slug='a1'`)).rows[0].id;
    await q(`INSERT INTO acc_agent_versions (agent_id, version, status) VALUES ($1,'1','active')`, [agent]);
    await rejects(q(`INSERT INTO acc_agent_versions (agent_id, version, status) VALUES ($1,'2','active')`, [agent]), '23505');
    await q(`INSERT INTO acc_agent_versions (agent_id, version, status) VALUES ($1,'2','draft')`, [agent]);
  });

  await check('email unico sem diferenciar caixa; role validado', async () => {
    await q(`INSERT INTO acc_users (name, email) VALUES ('U','User@X.com')`);
    await rejects(q(`INSERT INTO acc_users (name, email) VALUES ('U2','user@x.COM')`), '23505');
    await rejects(q(`INSERT INTO acc_users (name, email, role) VALUES ('U3','u3@x.com','root')`), '23514');
  });

  await check('business unit deve ser da mesma organizacao (team e agent)', async () => {
    const org2 = (await q(`INSERT INTO acc_organizations (slug, name) VALUES ('outra','Outra') RETURNING id`)).rows[0].id;
    const bu2 = (await q(`INSERT INTO acc_business_units (organization_id, slug, name) VALUES ($1,'bu','BU') RETURNING id`, [org2])).rows[0].id;
    await rejects(q(`INSERT INTO acc_teams (organization_id, business_unit_id, slug, name) VALUES ($1,$2,'t','T')`, [org, bu2]), '23503');
    await rejects(q(`INSERT INTO acc_agents (organization_id, business_unit_id, slug, name, agent_type) VALUES ($1,$2,'x','X','g')`, [org, bu2]), '23503');
    await q(`INSERT INTO acc_teams (organization_id, business_unit_id, slug, name) VALUES ($1,$2,'t','T')`, [org2, bu2]);
  });

  await check('permission_mode da tool nasce disabled; updated_at e atualizado por trigger', async () => {
    const agent = (await q(`SELECT id FROM acc_agents WHERE slug='a1'`)).rows[0].id;
    const tool = (await q(`INSERT INTO acc_tools (code, name, tool_type) VALUES ('t.read','T','http') RETURNING id`)).rows[0].id;
    const r = await q(`INSERT INTO acc_agent_tools (agent_id, tool_id) VALUES ($1,$2) RETURNING permission_mode`, [agent, tool]);
    assert.equal(r.rows[0].permission_mode, 'disabled');
    const before = (await q(`SELECT updated_at FROM acc_agents WHERE id=$1`, [agent])).rows[0].updated_at;
    await q(`SELECT pg_sleep(0.05)`);
    await q(`UPDATE acc_agents SET name='A1b' WHERE id=$1`, [agent]);
    const after = (await q(`SELECT updated_at FROM acc_agents WHERE id=$1`, [agent])).rows[0].updated_at;
    assert.ok(after > before);
  });

  await check('sem hard delete: FK RESTRICT impede apagar organizacao referenciada', async () => {
    await rejects(q(`DELETE FROM acc_organizations WHERE id=$1`, [org]), '23503');
  });

  await check('checksum alterado bloqueia novo apply (drift)', async () => {
    const real = (await q(`SELECT checksum FROM acc_migrations WHERE id LIKE '0001%'`)).rows[0].checksum;
    await q(`UPDATE acc_migrations SET checksum='x' WHERE id LIKE '0001%'`);
    const r = run('apply');
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /Checksum divergente/);
    await q(`UPDATE acc_migrations SET checksum=$1 WHERE id LIKE '0001%'`, [real]);
    assert.equal(run('verify').status, 0);
  });

  await check('rollback do seed e atomico: falha se a organizacao esta referenciada', async () => {
    assert.equal(run('down').status, 0); // 0004 audit (vazia)
    assert.equal(run('down').status, 0); // 0003 auth (vazia)
    const r = run('down'); // 0002 seed: org referenciada por agentes de teste
    assert.notEqual(r.status, 0);
    assert.equal((await q(`SELECT count(*)::int n FROM acc_migrations`)).rows[0].n, 2);
    assert.equal((await q(`SELECT count(*)::int n FROM acc_organizations WHERE slug='vne'`)).rows[0].n, 1);
  });

  await check('rollback completo apos limpar dados de teste', async () => {
    // limpeza feita pelo proprio teste, em banco descartavel
    for (const t of ['acc_agent_tools','acc_tools','acc_agent_versions','acc_agents','acc_teams','acc_business_units','acc_users'])
      await q(`DELETE FROM ${t}`);
    await q(`DELETE FROM acc_organizations WHERE slug <> 'vne'`);
    let r = run('down'); // desfaz 0002 (seed)
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal((await q(`SELECT count(*)::int n FROM acc_organizations`)).rows[0].n, 0);
    // guarda: 0001 recusa rollback com dados
    await q(`INSERT INTO acc_users (name, email) VALUES ('G','g@x.com')`);
    r = run('down');
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /Rollback recusado/);
    await q(`DELETE FROM acc_users`);
    r = run('down'); // desfaz 0001
    assert.equal(r.status, 0, r.stdout + r.stderr);
    for (const t of FOUNDATION) assert.equal(await tableCount(t), 0, `${t} deveria ter sumido`);
    assert.equal((await q(`SELECT count(*)::int n FROM pg_proc WHERE proname='acc_set_updated_at'`)).rows[0].n, 0);
    assert.deepEqual((await q(`SELECT id, v FROM vne_probe`)).rows, [{ id: 1, v: 'intacto' }]);
  });

  await check('reapply apos rollback funciona (ciclo up/down/up)', async () => {
    const r = run('apply');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    for (const t of ALL_TABLES) assert.equal(await tableCount(t), 1, t);
    assert.equal((await q(`SELECT count(*)::int n FROM acc_migrations`)).rows[0].n, 4);
  });

  await check('hardening tambem vale apos reapply', async () => {
    assert.equal(await anyAccPriv('other_app'), 0);
  });

  await check('auditoria e imutavel: UPDATE/DELETE/TRUNCATE rejeitados ate para o dono', async () => {
    await q('BEGIN');
    try {
      await q(`INSERT INTO acc_audit_log (actor_type, action, target_type, target_id) VALUES ('system','T','t','1')`);
      await q('SAVEPOINT s1');
      await rejects(q(`UPDATE acc_audit_log SET action='X'`), '23001');
      await q('ROLLBACK TO s1');
      await rejects(q(`DELETE FROM acc_audit_log`), '23001');
      await q('ROLLBACK TO s1');
      await rejects(q(`TRUNCATE acc_audit_log`), '23001');
      await q('ROLLBACK TO s1');
      await rejects(q(`INSERT INTO acc_audit_log (actor_type, action, target_type, target_id) VALUES ('robot','T','t','1')`), '23514');
    } finally {
      await q('ROLLBACK');
    }
    assert.equal((await q(`SELECT count(*)::int n FROM acc_audit_log`)).rows[0].n, 0);
  });

  await check('preview do role da aplicacao nao altera o banco', async () => {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('./setup-app-role.mjs', import.meta.url)), 'preview'], {
      env: { ...process.env, ACC_MIGRATE_URL: URL_, PGSSLMODE: 'disable' }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal((await q(`SELECT count(*)::int n FROM pg_roles WHERE rolname='acc_app'`)).rows[0].n, 0);
  });

  let appPassword;
  await check('role da aplicacao: criacao sem privilegios elevados', async () => {
    const res = await applyAppRole(db, { roleName: 'acc_app', database: 'acc_test' });
    assert.equal(res.created, true);
    appPassword = res.password;
    const r = (await q(`SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname='acc_app'`)).rows[0];
    assert.deepEqual(Object.values(r), [false, false, false, false, false]);
    assert.equal((await applyAppRole(db, { roleName: 'acc_app', database: 'acc_test' })).password, null); // idempotente
  });

  await check('role da aplicacao: acessos permitidos e negados', async () => {
    const app = new pg.Client({ connectionString: `postgres://acc_app:${appPassword}@127.0.0.1:${PORT}/acc_test` });
    await app.connect();
    try {
      await app.query(`SELECT 1 FROM acc_organizations`);
      await app.query(`INSERT INTO acc_users (name, email) VALUES ('App','app@x.com')`);
      await app.query(`UPDATE acc_users SET name='App2' WHERE email='app@x.com'`);
      assert.equal((await app.query(`SELECT texto FROM vne_mensagens`)).rows[0].texto, 'oi'); // leitura vne_ ok
      const denied = async (sql) => rejects(app.query(sql), '42501');
      await denied(`DELETE FROM acc_users`);                               // sem hard delete
      await denied(`CREATE TABLE public.hack (id int)`);                   // sem DDL
      await app.query('BEGIN');
      await app.query(`INSERT INTO acc_audit_log (actor_type, action, target_type, target_id) VALUES ('system','T','t','1')`);
      await app.query('SELECT count(*) FROM acc_audit_log');
      await app.query('ROLLBACK');
      await denied(`UPDATE acc_audit_log SET action='x'`);        // audit: sem UPDATE
      await denied(`DELETE FROM acc_audit_log`);                   // audit: sem DELETE
      await denied(`SELECT * FROM acc_migrations`);                        // controle interno
      await denied(`SELECT * FROM workflow_entity`);                       // n8n
      await denied(`SELECT * FROM vne_probe`);                             // vne_ nao concedida
      await denied(`INSERT INTO vne_mensagens VALUES (2, 'x')`);           // vne_ somente leitura
      await denied(`UPDATE vne_mensagens SET texto='x'`);
      assert.equal((await app.query(`SELECT current_setting('statement_timeout') t`)).rows[0].t, '15s');
    } finally {
      await app.end();
    }
  });

  await check('rollback continua funcionando com o role da aplicacao existente', async () => {
    await q(`DELETE FROM acc_users`);
    for (let i = 0; i < 4; i++) assert.equal(run('down').status, 0, `down #${i + 1}`);
    assert.equal(await tableCount('acc\_%'), 1 /* acc_migrations */);
  });

  console.log(`
${passed} verificacoes ok.`);
  await db.end();
} finally {
  await server.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
