import 'server-only';
import { Pool } from 'pg';

// A aplicacao usa EXCLUSIVAMENTE o role limitado (ACC_APP_DATABASE_URL). Nunca a credencial
// administrativa: sem fallback para DATABASE_URL / ACC_MIGRATE_URL.
const globalDb = globalThis as unknown as { accPool?: Pool };

function createPool(): Pool {
  const url = process.env.ACC_APP_DATABASE_URL;
  if (!url) throw new Error('ACC_APP_DATABASE_URL nao configurada (rode db:app-role:apply).');
  const ssl = process.env.PGSSLMODE && process.env.PGSSLMODE !== 'disable';
  return new Pool({
    connectionString: url,
    ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export function getDb(): Pool {
  globalDb.accPool ??= createPool();
  return globalDb.accPool;
}
