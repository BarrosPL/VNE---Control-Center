// Cria o primeiro usuario admin. Uso: node --env-file=.env.local scripts/create-admin.mjs --email=a@b.com --name="Nome"
//   --confirm-host=<host>  obrigatorio se o destino nao for localhost (escrita em banco real exige aprovacao)
// Usa ACC_APP_DATABASE_URL (role limitado). A senha e gerada aqui, gravada em .admin-credentials
// (ignorado pelo git, modo 0600) e NUNCA impressa.
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { emailSchema } from '../src/domain/credentials.ts';
import { createUserWithPassword } from '../src/server/auth/service.ts';
import { assertTargetAllowed, parseArgs } from './lib/migrations.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const url = process.env.ACC_APP_DATABASE_URL;
const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));

try {
  if (!url) throw new Error('Defina ACC_APP_DATABASE_URL.');
  const email = emailSchema.parse(flags.email);
  const name = typeof flags.name === 'string' && flags.name.trim() ? flags.name.trim() : null;
  if (!name) throw new Error('Informe --name="Nome".');
  const { host, remote } = assertTargetAllowed(url, flags['confirm-host']);
  const ssl = process.env.PGSSLMODE && process.env.PGSSLMODE !== 'disable';
  const client = new pg.Client({ connectionString: url, ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}) });
  await client.connect();
  try {
    const password = randomBytes(18).toString('base64url');
    const { id } = await createUserWithPassword(client, {
      name,
      email,
      role: 'admin',
      password,
      actor: { type: 'system' },
    });
    const file = fileURLToPath(new URL('../.admin-credentials', import.meta.url));
    writeFileSync(file, `email=${email}\npassword=${password}\n`, { mode: 0o600 });
    log('info', 'admin_created', { userId: id, host, remote, credentials: '.admin-credentials' });
  } finally {
    await client.end();
  }
} catch (err) {
  log('error', 'failed', { message: err.message });
  process.exit(1);
}
