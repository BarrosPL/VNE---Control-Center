// Cria/atualiza o role limitado da aplicacao. Uso: node scripts/setup-app-role.mjs <preview|apply>
//   --confirm-host=<host>  obrigatorio para destinos que nao sejam localhost
//   --rotate               (apply) gera nova senha para role ja existente
// Usa ACC_MIGRATE_URL (credencial administrativa do destino EXPLICITO). Nunca imprime senhas.
// Em 'apply' grava ACC_APP_DATABASE_URL e SESSION_SECRET em .env.local (ignorado pelo git).
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyAppRole, describeGrants, newPassword } from './lib/app-role.mjs';
import { assertTargetAllowed, parseArgs } from './lib/migrations.mjs';

const ENV_LOCAL = fileURLToPath(new URL('../.env.local', import.meta.url));
const { flags, rest } = parseArgs(process.argv.slice(2));
const command = rest[0];
const roleName = process.env.ACC_APP_ROLE || 'acc_app';
const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));

function upsertEnv(file, entries) {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) : [];
  for (const [k, v] of Object.entries(entries)) {
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
}

async function main() {
  if (!['preview', 'apply'].includes(command)) {
    console.error('Uso: node scripts/setup-app-role.mjs <preview|apply> [--confirm-host=H] [--rotate]');
    process.exit(2);
  }
  const url = process.env.ACC_MIGRATE_URL;
  if (!url) throw new Error('Defina ACC_MIGRATE_URL (destino explicito).');
  const { host, remote } = assertTargetAllowed(url, flags['confirm-host']);
  const ssl = process.env.PGSSLMODE && process.env.PGSSLMODE !== 'disable';
  const client = new pg.Client({
    connectionString: url,
    ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  log('info', 'connected', { host, remote, role: roleName });
  try {
    const database = (await client.query('SELECT current_database() AS d')).rows[0].d;
    if (command === 'preview') {
      await client.query('BEGIN READ ONLY');
      const exists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [roleName])).rowCount > 0;
      const acc = (await client.query(
        `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'acc\\_%' ORDER BY 1`,
      )).rows.map((r) => r.tablename);
      await client.query('ROLLBACK');
      log('info', 'preview', { roleExists: exists, ...describeGrants(acc) });
      return;
    }
    await client.query('BEGIN');
    try {
      const res = await applyAppRole(client, { roleName, database });
      let password = res.password;
      if (!res.created && flags.rotate) {
        password = newPassword();
        await client.query(`ALTER ROLE ${client.escapeIdentifier(roleName)} PASSWORD ${client.escapeLiteral(password)}`);
      }
      await client.query('COMMIT');
      if (password) {
        const u = new URL(url);
        const appUrl = `postgres://${encodeURIComponent(roleName)}:${encodeURIComponent(password)}@${u.host}${u.pathname}`;
        const entries = { ACC_APP_DATABASE_URL: appUrl };
        if (!existsSync(ENV_LOCAL) || !/^SESSION_SECRET=/m.test(readFileSync(ENV_LOCAL, 'utf8')))
          entries.SESSION_SECRET = randomBytes(48).toString('base64url');
        upsertEnv(ENV_LOCAL, entries);
        log('info', 'credentials_written', { file: '.env.local', keys: Object.keys(entries) });
      } else {
        log('info', 'role_exists_unchanged_password', { hint: 'use --rotate para gerar nova senha' });
      }
      log('info', 'applied', { created: res.created, accTables: res.accTables.length, vneTables: res.vneTables });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  log('error', 'failed', { message: err.message });
  process.exit(1);
});
