// ENSAIO da transicao de producao, 100% LOCAL: copia (SOMENTE LEITURA) o estado atual das tabelas de
// registro acc_* do banco real para um PostgreSQL 17.10 descartavel, aplica as migrations pendentes e importa o
// registry por cima, verificando o resultado. NAO copia usuarios, credenciais, sessoes nem tentativas de login
// (sem PII/segredos). NAO escreve no banco real.
//   node --env-file=.env.local scripts/rehearse-prod.mjs [--from-migration=0004] [--confirm-host=<host-de-origem>]
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAppRole } from './lib/app-role.mjs';
import { assertTargetAllowed, parseArgs } from './lib/migrations.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const FROM = typeof flags['from-migration'] === 'string' ? flags['from-migration'] : '0004';
// tabelas de registro copiadas, em ordem de dependencia (FKs). Nada de usuarios/sessoes/credenciais.
const COPY = [
  'acc_organizations', 'acc_integrations', 'acc_capabilities', 'acc_tools', 'acc_agents', 'acc_agent_versions',
  'acc_agent_capabilities', 'acc_agent_tools', 'acc_agent_integrations', 'acc_audit_log',
];
const out = { steps: [] };
const step = (name, data) => { out.steps.push({ name, ...data }); console.log(JSON.stringify({ step: name, ...data })); };

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer(); s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const srcUrl = process.env.ACC_APP_DATABASE_URL;
if (!srcUrl) throw new Error('Defina ACC_APP_DATABASE_URL (origem, somente leitura).');
const { host: srcHost } = assertTargetAllowed(srcUrl, flags['confirm-host'] ?? new URL(srcUrl).hostname);

const port = await freePort();
const dir = mkdtempSync(join(tmpdir(), 'acc-rehearsal-'));
const server = new EmbeddedPostgres({ databaseDir: dir, user: 'acc_test', password: 'acc_test', port, persistent: false, onLog: () => {}, onError: () => {} });
let failed = false;
try {
  await server.initialise(); await server.start(); await server.createDatabase('acc_test');
  const local = `postgres://acc_test:acc_test@127.0.0.1:${port}/acc_test`;
  const run = (script, args, env = {}) => {
    const r = spawnSync(process.execPath, [script, ...args], { env: { ...process.env, PGSSLMODE: 'disable', ...env }, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  // 1) estado "de producao": migrations ate FROM
  let r = run('scripts/migrate.mjs', ['apply', `--to=${FROM}`], { ACC_MIGRATE_URL: local });
  if (r.status !== 0) throw new Error(r.stdout + r.stderr);
  const owner = new pg.Client({ connectionString: local }); owner.on('error', () => {}); await owner.connect();
  await applyAppRole(owner, { roleName: 'acc_app', database: 'acc_test' }); // mesmo role/grants que a producao tem hoje

  // 2) copia SOMENTE LEITURA das tabelas de registro
  const src = new pg.Client({ connectionString: srcUrl, ...(process.env.PGSSLMODE && process.env.PGSSLMODE !== 'disable' ? { ssl: { rejectUnauthorized: false } } : {}) });
  src.on('error', () => {});
  await src.connect();
  await src.query('BEGIN READ ONLY');
  // o seed local (0002) e substituido pelo estado REAL copiado da origem
  await owner.query('DELETE FROM acc_organizations');
  const copied = {};
  for (const t of COPY) {
    const rows = (await src.query(`SELECT to_jsonb(x) AS r FROM ${t} x`)).rows.map((x) => x.r);
    copied[t] = rows.length;
    if (rows.length) {
      if (t === 'acc_audit_log') await owner.query('ALTER TABLE acc_audit_log DISABLE TRIGGER USER');
      await owner.query(`INSERT INTO ${t} SELECT * FROM jsonb_populate_recordset(NULL::${t}, $1::jsonb)`, [JSON.stringify(rows)]);
      if (t === 'acc_audit_log') await owner.query('ALTER TABLE acc_audit_log ENABLE TRIGGER USER');
    }
  }
  await src.query('ROLLBACK'); await src.end();
  step('copiado_de_producao_somente_leitura', { origem: srcHost, tabelas: copied });
  const state = async () => ({
    versoes: (await owner.query(`SELECT a.slug, v.version, v.environment, v.status FROM acc_agent_versions v JOIN acc_agents a ON a.id=v.agent_id ORDER BY 1,2`)).rows,
    tools: Number((await owner.query('SELECT count(*)::int n FROM acc_agent_tools')).rows[0].n),
    integr: Number((await owner.query('SELECT count(*)::int n FROM acc_agent_integrations')).rows[0].n),
  });
  step('estado_antes', await state());

  // 3) aplica as migrations pendentes (0005..) exatamente como o runner faria em producao
  r = run('scripts/migrate.mjs', ['apply'], { ACC_MIGRATE_URL: local });
  step('migrations_pendentes_aplicadas', { status: r.status, saida: r.stdout.split('\n').filter((l) => l.includes('"applied"')).map((l) => JSON.parse(l).id) });
  if (r.status !== 0) throw new Error(r.stdout + r.stderr);
  const sealed = (await owner.query(`SELECT a.slug, v.version, v.status, (v.sealed_at IS NOT NULL) AS selada, v.config_hash IS NOT NULL AS tem_proc FROM acc_agent_versions v JOIN acc_agents a ON a.id=v.agent_id ORDER BY 1,2`)).rows;
  step('pos_0005_backfill', { versoes: sealed, tools_unknown: Number((await owner.query(`SELECT count(*)::int n FROM acc_agent_tools WHERE observed_state='unknown'`)).rows[0].n) });
  await applyAppRole(owner, { roleName: 'acc_app', database: 'acc_test' }); // concede as tabelas novas ao role da aplicacao
  const appUrl = local.replace('acc_test:acc_test', `acc_app:${'x'}`); void appUrl;
  // role da aplicacao com senha conhecida (banco descartavel): so para rodar o importador com o MESMO role de producao
  await owner.query(`ALTER ROLE acc_app PASSWORD 'ensaio'`);
  const app = `postgres://acc_app:ensaio@127.0.0.1:${port}/acc_test`;

  // 4) importa o registry v2: preview (rollback) e apply
  const pv = run('scripts/seed-registry.mjs', ['preview'], { ACC_APP_DATABASE_URL: app });
  const pvj = pv.stdout.split('\n').filter((l) => l.includes('registry_preview')).map((l) => JSON.parse(l))[0];
  step('registry_preview', { status: pv.status, criado: pvj?.created, atualizado: pvj?.updated, versoes: pvj?.versions, observacao: pvj?.observation?.changes?.length, erro: pv.status ? (pv.stdout + pv.stderr).slice(-400) : undefined });
  const ap = run('scripts/seed-registry.mjs', ['apply'], { ACC_APP_DATABASE_URL: app });
  const apj = ap.stdout.split('\n').filter((l) => l.includes('registry_applied')).map((l) => JSON.parse(l))[0];
  step('registry_apply', { status: ap.status, versoes: apj?.versions, observacao: apj?.observation?.changes?.length, erro: ap.status ? (ap.stdout + ap.stderr).slice(-400) : undefined });
  if (ap.status !== 0) throw new Error('importacao do registry v2 falhou no ensaio');
  const after = (await owner.query(`SELECT a.slug, v.version, v.environment, v.status, (v.sealed_at IS NOT NULL) AS selada, left(v.config_hash,12) AS hash, v.source_revision FROM acc_agent_versions v JOIN acc_agents a ON a.id=v.agent_id ORDER BY 1,2`)).rows;
  const obs = (await owner.query(`SELECT observed_state, count(*)::int n FROM acc_agent_tools GROUP BY 1 ORDER BY 1`)).rows;
  const obsI = (await owner.query(`SELECT observed_state, count(*)::int n FROM acc_agent_integrations GROUP BY 1 ORDER BY 1`)).rows;
  const pol = (await owner.query(`SELECT permission_mode, count(*)::int n FROM acc_agent_tools GROUP BY 1 ORDER BY 1`)).rows;
  step('pos_import', { versoes: after, tools_observadas: obs, integracoes_observadas: obsI, politica_das_tools: pol, tools_vinculadas: (await state()).tools });
  const again = run('scripts/seed-registry.mjs', ['preview'], { ACC_APP_DATABASE_URL: app });
  const aj = again.stdout.split('\n').filter((l) => l.includes('registry_preview')).map((l) => JSON.parse(l))[0];
  step('reimportacao_idempotente', { criado: Object.values(aj.created).reduce((a, b) => a + b, 0), atualizado: Object.values(aj.updated).reduce((a, b) => a + b, 0) });

  // 5) o registry ANTIGO (v1) e recusado pelo importador novo? (protecao contra usar arquivo desatualizado)
  // 6) rollback das migrations novas sobre dados reais-shaped
  const downs = [];
  for (let i = 0; i < 3; i++) { const d = run('scripts/migrate.mjs', ['down', '--force'], { ACC_MIGRATE_URL: local }); downs.push(d.status); }
  const left = (await owner.query(`SELECT count(*)::int n FROM pg_tables WHERE schemaname='public' AND tablename IN ('acc_agent_events','acc_agent_runs','acc_agent_sessions','acc_event_types','acc_integration_entities')`)).rows[0].n;
  const cols = (await owner.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='acc_agent_tools' AND column_name='observed_state'`)).rows[0].n;
  const preserved = await state();
  step('rollback_0007_0006_0005', { status_dos_downs: downs, tabelas_novas_restantes: left, coluna_observed_state_restante: cols, dados_preservados: { versoes: preserved.versoes.length, tools: preserved.tools, integr: preserved.integr } });
  await owner.end();
} catch (err) {
  failed = true;
  console.error('ENSAIO FALHOU:', err.message);
} finally {
  await server.stop().catch(() => {});
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* Windows */ }
}
process.exit(failed ? 1 : 0);
