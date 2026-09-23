// Importa/atualiza o catalogo de entidades de uma integracao (nomes de pipeline/status/usuario...).
// Uso: node --env-file=.env.local scripts/import-catalog.mjs <preview|apply|gaps> [--file=registry/catalogs/kommo.json]
//   --confirm-host=<host>  obrigatorio para destinos que nao sejam localhost (escrita real exige aprovacao)
//   gaps: lista IDs observados em vne_* que ainda nao tem nome (somente leitura; nao precisa de --file)
// Usa ACC_APP_DATABASE_URL (role limitado). 'preview' executa em transacao e faz ROLLBACK.
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { LEAD_DATA_INTEGRATION } from '../src/domain/data-sources.ts';
import { importCatalog, parseCatalogFile } from '../src/server/catalog/importer.ts';
import { findCatalogGaps } from '../src/server/catalog/resolver.ts';
import { assertTargetAllowed, parseArgs } from './lib/migrations.mjs';

const { flags, rest } = parseArgs(process.argv.slice(2));
const command = rest[0];
const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));

try {
  if (!['preview', 'apply', 'gaps'].includes(command)) {
    console.error('Uso: node scripts/import-catalog.mjs <preview|apply|gaps> [--file=...] [--confirm-host=H]');
    process.exit(2);
  }
  const url = process.env.ACC_APP_DATABASE_URL;
  if (!url) throw new Error('Defina ACC_APP_DATABASE_URL.');
  const { host, remote } = assertTargetAllowed(url, flags['confirm-host']);
  const ssl = process.env.PGSSLMODE && process.env.PGSSLMODE !== 'disable';
  const client = new pg.Client({ connectionString: url, ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}) });
  await client.connect();
  try {
    if (command === 'gaps') {
      await client.query('BEGIN READ ONLY');
      const gaps = await findCatalogGaps(client, typeof flags.integration === 'string' ? flags.integration : LEAD_DATA_INTEGRATION, { directory: true });
      await client.query('ROLLBACK');
      const byKind = {};
      for (const g of gaps) (byKind[g.kind] ??= []).push(`${g.externalId}(${g.seenIn})`);
      log('info', 'catalog_gaps', { host, remote, total: gaps.length, byKind });
    } else {
      if (typeof flags.file !== 'string') throw new Error('Informe --file=caminho.json');
      const file = parseCatalogFile(JSON.parse(readFileSync(flags.file, 'utf8')));
      await client.query('BEGIN');
      try {
        const summary = await importCatalog(client, file, { correlationId: randomUUID() });
        await client.query(command === 'apply' ? 'COMMIT' : 'ROLLBACK');
        log('info', command === 'apply' ? 'catalog_applied' : 'catalog_preview_rolled_back', { host, remote, integration: file.integration, ...summary });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    }
  } finally {
    await client.end();
  }
} catch (err) {
  log('error', 'failed', { message: err.message });
  process.exit(1);
}
