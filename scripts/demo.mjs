// Ambiente de DEMONSTRACAO local e descartavel: Postgres embutido + todas as migrations + registro +
// catalogo ficticio + leads/mensagens ficticios + telemetria SINTETICA, e sobe o app em modo dev.
//   npm run demo            (Ctrl+C encerra e apaga tudo)
// Nunca toca em producao: o banco existe so em 127.0.0.1 numa pasta temporaria e o app e iniciado com
// ACC_APP_DATABASE_URL apontando para ele (sobrepoe qualquer .env.local). Credenciais impressas aqui valem
// APENAS neste banco descartavel.
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAppRole } from './lib/app-role.mjs';
import { createUserWithPassword } from '../src/server/auth/service.ts';
import { generateSynthetic } from './seed-synthetic-telemetry.mjs';

const APP_PORT = Number(process.env.DEMO_PORT) || 3000;
const DEMO_PASSWORD = 'demo-Control-Center-2026';

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
const dir = mkdtempSync(join(tmpdir(), 'acc-demo-'));
const server = new EmbeddedPostgres({
  databaseDir: dir, user: 'acc_demo', password: 'acc_demo', port: pgPort, persistent: false,
  onLog: () => {}, onError: (e) => console.error('[postgres]', e?.message ?? e),
});
let next;
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('\nEncerrando a demonstracao…');
  next?.kill();
  await server.stop().catch(() => {});
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* Windows */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  console.log('Preparando banco descartavel…');
  await server.initialise();
  await server.start();
  await server.createDatabase('acc_demo');
  const adminUrl = `postgres://acc_demo:acc_demo@127.0.0.1:${pgPort}/acc_demo`;
  const sh = (args, env) => {
    const r = spawnSync(process.execPath, args, { env: { ...process.env, ...env }, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${args.join(' ')} falhou:\n${r.stdout}${r.stderr}`);
  };
  sh(['scripts/migrate.mjs', 'apply'], { ACC_MIGRATE_URL: adminUrl, PGSSLMODE: 'disable' });

  const owner = new pg.Client({ connectionString: adminUrl });
  await owner.connect();
  await owner.query(readFileSync('tests/fixtures/vne-schema.sql', 'utf8'));
  await owner.query(readFileSync('tests/fixtures/vne-data.sql', 'utf8'));
  const role = await applyAppRole(owner, { roleName: 'acc_app', database: 'acc_demo' });
  await owner.end();
  const appUrl = `postgres://acc_app:${role.password}@127.0.0.1:${pgPort}/acc_demo`;
  const env = { ACC_APP_DATABASE_URL: appUrl, PGSSLMODE: 'disable' };

  sh(['scripts/seed-registry.mjs', 'apply'], env);
  sh(['scripts/import-catalog.mjs', 'apply', '--file=tests/fixtures/demo-catalog.json'], env);

  const app = new pg.Client({ connectionString: appUrl });
  await app.connect();
  await createUserWithPassword(app, { name: 'Administrador Demo', email: 'demo@example.com', role: 'admin', password: DEMO_PASSWORD, actor: { type: 'system' } });
  await createUserWithPassword(app, { name: 'Visualizador Demo', email: 'viewer@example.com', role: 'viewer', password: DEMO_PASSWORD, actor: { type: 'system' } });
  const syn = await generateSynthetic(app, { runs: 40, seed: 1, leads: ['1001', '1004'] });
  await app.end();
  console.log(`Telemetria sintetica: ${syn.runs} execucoes, ${syn.events} eventos.`);

  next = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '-p', String(APP_PORT), '--hostname', '127.0.0.1'], {
    env: { ...process.env, ...env, DEMO_MODE: '1', SESSION_SECRET: randomBytes(32).toString('base64url') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  next.stdout.on('data', (b) => process.stdout.write(String(b)));
  next.stderr.on('data', (b) => process.stderr.write(String(b)));
  next.on('exit', () => { if (!stopping) shutdown(); });

  console.log('\n================ DEMONSTRACAO ================');
  console.log(`  URL:       http://127.0.0.1:${APP_PORT}/login`);
  console.log(`  Admin:     demo@example.com    / ${DEMO_PASSWORD}`);
  console.log(`  Visualiz.: viewer@example.com  / ${DEMO_PASSWORD}   (nao ve conteudo de mensagens)`);
  console.log('  Banco:     local e descartavel (127.0.0.1). Dados FICTICIOS e telemetria SINTETICA.');
  console.log('  Encerrar:  Ctrl+C');
  console.log('===============================================\n');
} catch (err) {
  console.error(err.message);
  await shutdown();
}
