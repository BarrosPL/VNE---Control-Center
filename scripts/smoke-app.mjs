// Smoke test ponta a ponta: sobe Postgres descartavel, aplica migrations + role limitado,
// cria admin com scripts/create-admin.mjs, inicia `next start` e valida proxy/guards/paginas.
// Requer `npm run build` previo. Nunca usa producao.
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAppRole } from './lib/app-role.mjs';
import { createUserWithPassword, login } from '../src/server/auth/service.ts';

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const pgPort = await freePort();
const appPort = await freePort();
const dir = mkdtempSync(join(tmpdir(), 'acc-smoke-'));
const CRED_FILE = new URL('../.admin-credentials', import.meta.url);
const hadCredFile = existsSync(CRED_FILE);
const server = new EmbeddedPostgres({
  databaseDir: dir, user: 'acc_test', password: 'acc_test', port: pgPort, persistent: false,
  onLog: process.env.DEBUG_PG ? (m) => console.error('[pg-log]', String(m).trim()) : () => {}, onError: (e) => console.error('[postgres]', e?.message ?? e),
});
let next;
let passed = 0;
const cleanup = [];
const ok = (name) => console.log(`ok  - ${++passed}. ${name}`);

try {
  await server.initialise();
  await server.start();
  await server.createDatabase('acc_test');
  const adminUrl = `postgres://acc_test:acc_test@127.0.0.1:${pgPort}/acc_test`;
  let r = spawnSync(process.execPath, ['scripts/migrate.mjs', 'apply'], {
    env: { ...process.env, ACC_MIGRATE_URL: adminUrl, PGSSLMODE: 'disable' }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const owner = new pg.Client({ connectionString: adminUrl });
  await owner.connect();
  await owner.query(readFileSync('tests/fixtures/vne-schema.sql', 'utf8'));
  await owner.query(readFileSync('tests/fixtures/vne-data.sql', 'utf8'));
  const role = await applyAppRole(owner, { roleName: 'acc_app', database: 'acc_test' });
  await owner.end();
  const appUrl = `postgres://acc_app:${role.password}@127.0.0.1:${pgPort}/acc_test`;
  const env = { ...process.env, ACC_APP_DATABASE_URL: appUrl, PGSSLMODE: 'disable', NODE_ENV: 'production' };

  // scripts/create-admin.mjs (importa TS via type stripping)
  r = spawnSync(process.execPath, ['scripts/create-admin.mjs', '--email=admin@example.com', '--name=Admin Teste'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!r.stdout.includes(readFileSync(CRED_FILE, 'utf8').split('password=')[1].trim()), 'senha nao pode ser impressa');
  ok('create-admin cria admin e grava .admin-credentials sem imprimir a senha');
  const password = readFileSync(CRED_FILE, 'utf8').split('password=')[1].trim();

  // registro declarativo: preview (rollback) e apply
  r = spawnSync(process.execPath, ['scripts/seed-registry.mjs', 'preview'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  {
    const c0 = new pg.Client({ connectionString: appUrl });
    await c0.connect();
    assert.equal(Number((await c0.query('SELECT count(*)::int n FROM acc_agents')).rows[0].n), 0);
    await c0.end();
  }
  ok('seed-registry preview nao grava nada');
  r = spawnSync(process.execPath, ['scripts/seed-registry.mjs', 'apply'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  ok('seed-registry apply importa o registro');

  next = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(appPort), '--hostname', '127.0.0.1'], { env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${appPort}`;
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${base}/login`); break; } catch { await new Promise((res) => setTimeout(res, 500)); }
  }
  const get = (path, cookie) =>
    fetch(base + path, { redirect: 'manual', headers: cookie ? { cookie: `acc_session=${cookie}` } : {} });

  let res = await get('/');
  assert.equal(res.status, 307);
  assert.match(res.headers.get('location') ?? '', /\/login$/);
  ok('sem cookie: / redireciona para /login (proxy)');

  res = await get('/login');
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /type="password"/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  ok('/login renderiza o formulario com security headers');

  res = await get('/', 'token-forjado');
  assert.equal(res.status, 307);
  assert.match(res.headers.get('location') ?? '', /\/login/);
  ok('cookie forjado: o proxy deixa passar, mas o guard do servidor rejeita (defesa em profundidade)');

  const c = new pg.Client({ connectionString: appUrl });
  c.on('error', () => {});
  await c.connect();
  cleanup.push(() => c.end().catch(() => {}));
  const session = await login(c, { email: 'admin@example.com', password });
  assert.ok(session.ok);
  res = await get('/', session.token);
  const home = await res.text();
  assert.equal(res.status, 200);
  assert.match(home, /Command Center/);
  assert.match(home, /Admin Teste/);
  assert.ok(!home.includes(session.token) && !home.includes(password));
  ok('sessao valida: / renderiza o Command Center com o usuario, sem vazar token/senha');

  assert.match(home, /Agentes ativos/);
  assert.match(home, /Indisponível/); // metricas de fases futuras nao viram zero falso
  assert.match(home, /Mensagens \(24h\)/);
  assert.match(home, /Modo informativo/);
  ok('Command Center mostra metricas reais (vne_*) e marca as futuras como indisponiveis');

  res = await get('/agents', session.token);
  const agentsHtml = await res.text();
  assert.equal(res.status, 200);
  assert.match(agentsHtml, /Sophia/);
  assert.match(agentsHtml, /Higor/);
  assert.match(agentsHtml, /gpt-4\.1-mini/);
  const detailPath = agentsHtml.match(/href="(\/agents\/[0-9a-f-]{36})"/)?.[1];
  assert.ok(detailPath, 'link para o detalhe');
  ok('/agents lista os agentes cadastrados (dados, nao codigo)');

  res = await get(detailPath, session.token);
  const detail = await res.text();
  assert.equal(res.status, 200);
  assert.match(detail, /INATIVO/); // aviso da tool com workflow alvo inativo
  assert.match(detail, /reservar_e_criar_reuniao/);
  assert.match(detail, /Histórico de versões/);
  ok('detalhe do agente mostra tools, avisos, integracoes e versoes');

  res = await get('/agents/00000000-0000-0000-0000-000000000000', session.token);
  assert.equal(res.status, 404);
  res = await get('/agents/nao-e-uuid', session.token);
  assert.equal(res.status, 404);
  ok('agente inexistente ou id invalido => 404');

  res = await get('/integrations', session.token);
  const integ = await res.text();
  assert.equal(res.status, 200);
  assert.match(integ, /Kommo CRM/);
  assert.match(integ, /Não monitorada/);
  assert.ok(!/postgres:\/\/|password|SESSION_SECRET/i.test(integ), 'sem segredos na tela');
  ok('/integrations lista dependencias sem expor segredos');

  // ---- Lead 360 ----
  res = await get('/leads', session.token);
  const leadsHtml = await res.text();
  assert.equal(res.status, 200);
  assert.match(leadsHtml, /Maria Teste Silva/);
  assert.match(leadsHtml, /Fulano de Tal/); // nome do contato como fallback
  assert.ok(!leadsHtml.includes('quero saber'), 'a lista nao mostra conteudo de mensagens');
  res = await get('/leads?q=maria', session.token);
  const found = await res.text();
  assert.match(found, /Maria Teste Silva/);
  assert.ok(!/Fulano de Tal/.test(found));
  ok('/leads lista e busca leads (fonte: vne_*), sem conteudo de mensagens');

  res = await get('/leads/1001', session.token);
  const lead = await res.text();
  assert.equal(res.status, 200);
  assert.match(lead, /Maria Teste Silva/);
  assert.match(lead, /quero saber sobre o processo/); // admin ve o conteudo
  assert.match(lead, /passaporte\.pdf/);
  assert.match(lead, /Etapa alterada/);
  assert.match(lead, /Dentro de 24h/);
  assert.match(lead, /Agente A|Sophia/); // ultimo agente vinculado por slug (dado)
  assert.match(lead, /Indisponível/); // controles IA/humano: fase futura, nunca simulados
  assert.ok(!lead.includes('PAYLOAD_SECRET_MARKER'), 'payload bruto nunca e exibido');
  ok('Lead 360 (admin): cabecalho, janela 24h, agente por slug, timeline unificada com conteudo');

  res = await get('/leads/1001?view=events', session.token);
  const onlyEvents = await res.text();
  assert.match(onlyEvents, /Etapa alterada/);
  assert.ok(!onlyEvents.includes('quero saber'));
  ok('filtro Eventos CRM esconde a conversa');

  res = await get('/leads/1002', session.token);
  assert.match(await res.text(), /Fora de 24h/);
  res = await get('/leads/424242', session.token);
  assert.equal(res.status, 404);
  res = await get('/leads/abc', session.token);
  assert.equal(res.status, 404);
  res = await get('/leads/1%20OR%201=1', session.token);
  assert.equal(res.status, 404);
  ok('lead sem snapshot abre por ID; inexistente/invalido/injecao => 404');

  const audit = Number((await c.query(`SELECT count(*)::int n FROM acc_audit_log WHERE action='ENTITY_VIEWED' AND target_id='1001'`)).rows[0].n);
  assert.equal(audit, 1, 'varias visualizacoes em 10 min geram um unico registro de auditoria');
  ok('visualizacao de conteudo e auditada (deduplicada)');

  await createUserWithPassword(c, { name: 'Visualizador', email: 'viewer@example.com', role: 'viewer', password: 'senha-do-viewer-123', actor: { type: 'system' } });
  const vs = await login(c, { email: 'viewer@example.com', password: 'senha-do-viewer-123' });
  assert.ok(vs.ok);
  res = await get('/leads/1001', vs.token);
  const restricted = await res.text();
  assert.equal(res.status, 200);
  assert.match(restricted, /Conteúdo restrito ao seu perfil/);
  for (const secret of ['quero saber', 'Qual seu nome', 'passaporte', 'Vou analisar', 'Ligar para a cliente'])
    assert.ok(!restricted.includes(secret), `viewer nao deve ver: ${secret}`);
  assert.match(restricted, /Etapa alterada/); // metadados/eventos continuam visiveis
  const viewerAudit = Number((await c.query(`SELECT count(*)::int n FROM acc_audit_log a JOIN acc_users u ON u.id=a.actor_id WHERE a.action='ENTITY_VIEWED' AND u.email='viewer@example.com'`)).rows[0].n);
  assert.equal(viewerAudit, 0, 'sem conteudo exibido nao ha visualizacao de dados pessoais a auditar');
  ok('Lead 360 (viewer): conteudo restrito no servidor; metadados visiveis; sem auditoria de PII');

  await c.query(`UPDATE acc_sessions SET revoked_at = now()`).catch(() => {});
  res = await get('/', session.token);
  assert.equal(res.status, 307);
  ok('sessao revogada: acesso negado imediatamente');
  await c.end();

  console.log(`\n${passed} verificacoes ok.`);
} finally {
  for (const fn of cleanup) await fn();
  next?.kill();
  await server.stop().catch(() => {});
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* best effort no Windows */ }
  if (!hadCredFile && existsSync(CRED_FILE)) rmSync(CRED_FILE); // credencial de teste nao deve sobrar
}
