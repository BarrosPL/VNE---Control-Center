// Importa o registro declarativo de agentes. Uso: node scripts/seed-registry.mjs <preview|apply> [--file=registry/vne.registry.json]
//   --confirm-host=<host>  obrigatorio para destinos que nao sejam localhost (escrita real exige aprovacao)
// Usa ACC_APP_DATABASE_URL (role limitado). 'preview' executa tudo em transacao e faz ROLLBACK.
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseRegistry } from '../src/domain/registry.ts';
import { importRegistry } from '../src/server/registry/importer.ts';
import { assertTargetAllowed, parseArgs } from './lib/migrations.mjs';

const { flags, rest } = parseArgs(process.argv.slice(2));
const command = rest[0];
const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));

try {
  if (!['preview', 'apply'].includes(command)) {
    console.error('Uso: node scripts/seed-registry.mjs <preview|apply> [--file=...] [--confirm-host=H]');
    process.exit(2);
  }
  const url = process.env.ACC_APP_DATABASE_URL;
  if (!url) throw new Error('Defina ACC_APP_DATABASE_URL.');
  const { host, remote } = assertTargetAllowed(url, flags['confirm-host']);
  const file = typeof flags.file === 'string' ? flags.file : 'registry/vne.registry.json';
  const registry = parseRegistry(JSON.parse(readFileSync(file, 'utf8')));
  const ssl = process.env.PGSSLMODE && process.env.PGSSLMODE !== 'disable';
  const client = new pg.Client({ connectionString: url, ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}) });
  await client.connect();
  try {
    await client.query('BEGIN');
    const summary = await importRegistry(client, registry, { correlationId: randomUUID() });
    if (command === 'apply') await client.query('COMMIT');
    else await client.query('ROLLBACK');
    log('info', command === 'apply' ? 'registry_applied' : 'registry_preview_rolled_back', { host, remote, file, ...summary });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
} catch (err) {
  log('error', 'failed', { message: err.message });
  process.exit(1);
}
