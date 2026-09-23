import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAppRole } from '../../scripts/lib/app-role.mjs';

export interface TestDb {
  owner: pg.Client; // dono: setup e adulteracao de estado
  app: pg.Client; // role limitado acc_app (mesmos privilegios da aplicacao)
  appUrl: string;
  stop(): Promise<void>;
}

/** Sobe um Postgres real e descartavel (127.0.0.1, porta livre), aplica migrations e cria o role acc_app. */
export async function startTestDb(prefix = 'acc-test-'): Promise<TestDb> {
  const port = await new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const server = new EmbeddedPostgres({
    databaseDir: dir, user: 'acc_test', password: 'acc_test', port, persistent: false,
    onLog: () => {}, onError: (e: unknown) => console.error('[postgres]', e),
  });
  await server.initialise();
  await server.start();
  await server.createDatabase('acc_test');
  const url = `postgres://acc_test:acc_test@127.0.0.1:${port}/acc_test`;
  const r = spawnSync(process.execPath, ['scripts/migrate.mjs', 'apply'], {
    env: { ...process.env, ACC_MIGRATE_URL: url, PGSSLMODE: 'disable' }, encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`migrate falhou: ${r.stdout}${r.stderr}`);
  const owner = new pg.Client({ connectionString: url });
  await owner.connect();
  const role = await applyAppRole(owner, { roleName: 'acc_app', database: 'acc_test' });
  const appUrl = `postgres://acc_app:${role.password}@127.0.0.1:${port}/acc_test`;
  const app = new pg.Client({ connectionString: appUrl });
  await app.connect();
  return {
    owner, app, appUrl,
    async stop() {
      await app.end().catch(() => {});
      await owner.end().catch(() => {});
      await server.stop().catch(() => {});
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch {
        // Windows pode manter o arquivo bloqueado por instantes; o diretorio e temporario.
      }
    },
  };
}
