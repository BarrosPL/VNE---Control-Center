import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Lista migrations ordenadas; exige par up/down para cada id. */
export function loadMigrations(dir) {
  const byId = new Map();
  for (const file of readdirSync(dir)) {
    const m = FILE_RE.exec(file);
    if (!m) continue;
    const [, num, name, dir_] = m;
    const id = `${num}_${name}`;
    const entry = byId.get(id) ?? { id, up: null, down: null };
    entry[dir_] = readFileSync(join(dir, file), 'utf8');
    byId.set(id, entry);
  }
  const list = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const mig of list) {
    if (!mig.up || !mig.down) throw new Error(`Migration ${mig.id} precisa de .up.sql e .down.sql`);
    mig.checksum = checksum(mig.up);
    mig.tables = createdTables(mig.up);
    mig.allowData = /^--\s*@allow-data\b/m.test(mig.down);
    // tabelas de REFERENCIA semeadas pela propria migration (ex.: tipos de evento): nao contam no guard de rollback
    mig.ignoreRows = (/^--\s*@ignore-rows:\s*(.+)$/m.exec(mig.down)?.[1] ?? '')
      .split(',').map((t) => t.trim()).filter(Boolean);
  }
  return list;
}

export function checksum(sql) {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

export function createdTables(sql) {
  return [...sql.matchAll(/^\s*CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([a-z0-9_.]+)/gim)].map((m) =>
    m[1].toLowerCase(),
  );
}

/** Resume o que a migration faz, sem executar. */
export function summarize(sql) {
  const count = (re) => [...sql.matchAll(re)].length;
  return {
    tables: createdTables(sql),
    indexes: count(/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX/gim),
    triggersOrFunctions: count(/CREATE\s+(?:OR REPLACE\s+)?(?:FUNCTION|TRIGGER)/gi),
    inserts: count(/^\s*INSERT\s+INTO/gim),
    deletes: count(/^\s*DELETE\s+FROM/gim),
    drops: count(/^\s*DROP\s+/gim),
  };
}

/** Destino remoto exige --confirm-host=<host> identico ao host da URL. */
export function assertTargetAllowed(connectionString, confirmHost) {
  let host;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    throw new Error('ACC_MIGRATE_URL invalida.');
  }
  if (LOCAL_HOSTS.has(host)) return { host, remote: false };
  if (confirmHost !== host) {
    throw new Error(
      `Destino remoto (${host}). Reexecute com --confirm-host=${host} somente com aprovacao explicita.`,
    );
  }
  return { host, remote: true };
}

export function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (m) flags[m[1]] = m[2] ?? true;
    else rest.push(a);
  }
  return { flags, rest };
}

/**
 * Remove grants herdados de default privileges (ex.: roles de outros apps) das tabelas acc_*
 * recem-criadas: somente o dono mantem acesso. Grants da aplicacao sao dados depois,
 * de forma explicita, por scripts/setup-app-role.mjs.
 */
export async function hardenTables(client, tables) {
  for (const t of tables) {
    if (!/^acc_[a-z0-9_]+$/.test(t)) throw new Error(`Nome de tabela invalido para hardening: ${t}`);
    const { rows } = await client.query(
      `SELECT DISTINCT a.grantee,
              CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END AS who
         FROM pg_class c, LATERAL aclexplode(c.relacl) a
        WHERE c.oid = to_regclass($1) AND a.grantee <> c.relowner`,
      [`public.${t}`],
    );
    for (const r of rows) await client.query(`REVOKE ALL ON TABLE public.${t} FROM ${r.who}`);
  }
}
