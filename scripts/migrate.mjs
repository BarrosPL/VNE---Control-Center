// Runner de migrations acc_*. Uso: node scripts/migrate.mjs <preview|apply|verify|down> [flags]
//   --sql                 (preview) imprime o SQL completo
//   --confirm-host=<host> obrigatorio para destinos que nao sejam localhost
//   --force               (down) permite remover tabelas que contem linhas
// Le APENAS ACC_MIGRATE_URL. Nunca usa DATABASE_URL (que aponta para producao).
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { assertTargetAllowed, hardenTables, loadMigrations, parseArgs, summarize } from './lib/migrations.mjs';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const LOCK_KEY = 74_210_001; // advisory lock exclusivo do runner acc_*
const TRACKING = 'acc_migrations';

const { flags, rest } = parseArgs(process.argv.slice(2));
const command = rest[0];
const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));

async function connect() {
  const url = process.env.ACC_MIGRATE_URL;
  if (!url) throw new Error('Defina ACC_MIGRATE_URL (destino explicito das migrations).');
  const { host, remote } = assertTargetAllowed(url, flags['confirm-host']);
  const ssl = process.env.PGSSLMODE && process.env.PGSSLMODE !== 'disable';
  const client = new pg.Client({
    connectionString: url,
    ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
  });
  await client.connect();
  log('info', 'connected', { host, remote });
  return client;
}

async function appliedMap(client) {
  const exists = await client.query(`SELECT to_regclass('public.${TRACKING}') AS t`);
  if (!exists.rows[0].t) return new Map();
  const { rows } = await client.query(`SELECT id, checksum FROM ${TRACKING} ORDER BY id`);
  return new Map(rows.map((r) => [r.id, r.checksum]));
}

function assertNoDrift(migrations, applied) {
  for (const [id, sum] of applied) {
    const mig = migrations.find((m) => m.id === id);
    if (!mig) throw new Error(`Migration aplicada sem arquivo local: ${id}`);
    if (mig.checksum !== sum) throw new Error(`Checksum divergente em ${id}: arquivo foi alterado.`);
  }
}

async function preview(migrations) {
  let applied = new Map();
  if (process.env.ACC_MIGRATE_URL) {
    const client = await connect();
    try {
      await client.query('BEGIN READ ONLY');
      applied = await appliedMap(client);
      assertNoDrift(migrations, applied);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
  } else {
    log('warn', 'ACC_MIGRATE_URL ausente: preview sem consultar o banco (tudo aparece como pendente).');
  }
  const pending = migrations.filter((m) => !applied.has(m.id));
  log('info', 'preview', { total: migrations.length, pending: pending.map((m) => m.id) });
  for (const m of pending) {
    const rollback = m.down.split('\n').find((l) => l.startsWith('--') && !l.includes('@')) ?? '';
    log('info', 'pending', { id: m.id, ...summarize(m.up), rollback });
    if (flags.sql) console.log(`\n-- ==== ${m.id} (up) ====\n${m.up}`);
  }
}

async function apply(migrations) {
  const client = await connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${TRACKING} (
         id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    await hardenTables(client, [TRACKING]);
    const applied = await appliedMap(client);
    assertNoDrift(migrations, applied);
    for (const m of migrations.filter((x) => !applied.has(x.id))) {
      await client.query('BEGIN');
      try {
        await client.query(m.up);
        await hardenTables(client, m.tables);
        await client.query(`INSERT INTO ${TRACKING} (id, checksum) VALUES ($1, $2)`, [m.id, m.checksum]);
        await client.query('COMMIT');
        log('info', 'applied', { id: m.id });
      } catch (err) {
        await client.query('ROLLBACK');
        log('error', 'apply_failed', { id: m.id, code: err.code, message: err.message });
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await client.end();
  }
}

async function verify(migrations) {
  const client = await connect();
  let problems = 0;
  try {
    await client.query('BEGIN READ ONLY');
    const applied = await appliedMap(client);
    assertNoDrift(migrations, applied);
    for (const m of migrations) {
      if (!applied.has(m.id)) {
        log('warn', 'not_applied', { id: m.id });
        continue;
      }
      for (const t of m.tables) {
        const { rows } = await client.query('SELECT to_regclass($1) AS t', [`public.${t}`]);
        if (!rows[0].t) {
          problems++;
          log('error', 'missing_table', { id: m.id, table: t });
        }
      }
    }
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'vne\\_%'`,
    );
    log('info', 'verify', { applied: [...applied.keys()], problems, vne_tables_visible: rows[0].n });
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
  if (problems) process.exitCode = 1;
}

async function down(migrations) {
  const client = await connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    const applied = await appliedMap(client);
    assertNoDrift(migrations, applied);
    const last = [...applied.keys()].pop();
    if (!last) return log('info', 'nothing_to_rollback');
    const m = migrations.find((x) => x.id === last);
    if (!m.allowData && !flags.force) {
      for (const t of m.tables) {
        const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${t}`);
        if (rows[0].n > 0) {
          throw new Error(`Rollback recusado: ${t} contem ${rows[0].n} linha(s). Use --force com aprovacao.`);
        }
      }
    }
    await client.query('BEGIN');
    try {
      await client.query(m.down);
      await client.query(`DELETE FROM ${TRACKING} WHERE id = $1`, [m.id]);
      await client.query('COMMIT');
      log('info', 'rolled_back', { id: m.id });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await client.end();
  }
}

const commands = { preview, apply, verify, down };
if (!commands[command]) {
  console.error('Uso: node scripts/migrate.mjs <preview|apply|verify|down> [--sql] [--confirm-host=H] [--force]');
  process.exit(2);
}
try {
  await commands[command](loadMigrations(MIGRATIONS_DIR));
} catch (err) {
  log('error', 'failed', { message: err.message });
  process.exit(1);
}
