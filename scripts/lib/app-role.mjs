import { randomBytes } from 'node:crypto';

/** Tabelas vne_* que o Control Center le (Lead 360). Somente SELECT. Ampliar sob demanda. */
export const VNE_READ_TABLES = [
  'vne_leads_snapshot',
  'vne_mensagens',
  'vne_eventos_crm',
  'vne_chat_map',
  'vne_janela_meta',
];

/** Tabelas de controle interno que a aplicacao nunca acessa. */
const APP_EXCLUDED = new Set(['acc_migrations']);

/** Tabelas append-only: a aplicacao so insere e le (alem do trigger de imutabilidade). */
const APPEND_ONLY = new Set(['acc_audit_log', 'acc_agent_events']);

/** Dados de referencia: a aplicacao so le (mudam por migration). */
const READ_ONLY = new Set(['acc_event_types']);

const privsFor = (t) => (APPEND_ONLY.has(t) ? 'SELECT, INSERT' : READ_ONLY.has(t) ? 'SELECT' : 'SELECT, INSERT, UPDATE');

const ROLE_RE = /^[a-z][a-z0-9_]{2,40}$/;

export function newPassword() {
  return randomBytes(32).toString('base64url');
}

/**
 * Descreve (sem executar) o que sera concedido. Usado no preview.
 * Sem DELETE: dados auditaveis nao dependem de hard delete (CLAUDE.md §20.6).
 */
export function describeGrants(accTables) {
  return {
    role: 'LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS, CONNECTION LIMIT 10',
    settings: ['statement_timeout=15s', 'idle_in_transaction_session_timeout=30s'],
    acc: accTables
      .filter((t) => !APP_EXCLUDED.has(t))
      .map((t) => `${t}: ${privsFor(t)}`),
    vne: VNE_READ_TABLES.map((t) => `${t}: SELECT`),
    denied: ['DELETE em acc_*', 'CREATE em public', 'tabelas do n8n (workflow/credentials/execution)', 'acc_migrations'],
  };
}

/**
 * Cria (se preciso) e concede privilegios minimos ao role da aplicacao. Idempotente.
 * Retorna a senha SOMENTE quando o role foi criado agora.
 */
export async function applyAppRole(client, { roleName, database }) {
  if (!ROLE_RE.test(roleName)) throw new Error('Nome de role invalido.');
  const q = (s, p) => client.query(s, p);
  const ident = (s) => client.escapeIdentifier(s);

  const exists = (await q('SELECT 1 FROM pg_roles WHERE rolname = $1', [roleName])).rowCount > 0;
  let password = null;
  if (!exists) {
    password = newPassword();
    await q(
      `CREATE ROLE ${ident(roleName)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
         NOBYPASSRLS CONNECTION LIMIT 10 PASSWORD ${client.escapeLiteral(password)}`,
    );
  } else {
    const r = (await q(
      'SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1',
      [roleName],
    )).rows[0];
    if (Object.values(r).some(Boolean)) throw new Error(`Role ${roleName} existente possui privilegios elevados.`);
  }

  await q(`ALTER ROLE ${ident(roleName)} SET statement_timeout = '15s'`);
  await q(`ALTER ROLE ${ident(roleName)} SET idle_in_transaction_session_timeout = '30s'`);
  await q(`GRANT CONNECT ON DATABASE ${ident(database)} TO ${ident(roleName)}`);
  await q(`REVOKE CREATE ON SCHEMA public FROM ${ident(roleName)}`);
  await q(`GRANT USAGE ON SCHEMA public TO ${ident(roleName)}`);

  const acc = (await q(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'acc\\_%' ORDER BY 1`,
  )).rows.map((r) => r.tablename).filter((t) => !APP_EXCLUDED.has(t));
  for (const t of acc) {
    const privs = privsFor(t);
    await q(`REVOKE ALL ON TABLE public.${ident(t)} FROM ${ident(roleName)}`);
    await q(`GRANT ${privs} ON TABLE public.${ident(t)} TO ${ident(roleName)}`);
  }
  await q(`REVOKE ALL ON TABLE public.acc_migrations FROM ${ident(roleName)}`).catch(() => {});

  const present = (await q(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)`,
    [VNE_READ_TABLES],
  )).rows.map((r) => r.tablename);
  for (const t of present) await q(`GRANT SELECT ON TABLE public.${ident(t)} TO ${ident(roleName)}`);

  return { created: !exists, password, accTables: acc, vneTables: present };
}
