import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertTargetAllowed,
  checksum,
  createdTables,
  loadMigrations,
  parseArgs,
  summarize,
} from '../scripts/lib/migrations.mjs';

const dir = join(__dirname, '..', 'migrations');
const migrations = loadMigrations(dir);
const stripComments = (sql: string) => sql.replace(/--.*$/gm, '');

describe('migrations: guardrails estaticos', () => {
  it('cada migration tem par up/down e ids sequenciais', () => {
    expect(migrations.map((m: { id: string }) => m.id)).toEqual([
      '0001_foundation',
      '0002_seed_vne_organization',
      '0003_auth',
      '0004_audit_log',
      '0005_registry_observed_state_and_version_seal',
      '0006_integration_catalog',
      '0007_agent_telemetry',
    ]);
  });

  it('todas as tabelas criadas usam o prefixo acc_', () => {
    for (const m of migrations) {
      for (const t of m.tables) expect(t, `${m.id}: ${t}`).toMatch(/^acc_/);
    }
  });

  it('a fundacao cria exatamente as 13 tabelas da Fase 1', () => {
    const tables = createdTables(readFileSync(join(dir, '0001_foundation.up.sql'), 'utf8')).sort();
    expect(tables).toEqual(
      [
        'acc_agent_capabilities', 'acc_agent_integrations', 'acc_agent_tools', 'acc_agent_versions',
        'acc_agents', 'acc_business_units', 'acc_capabilities', 'acc_integrations',
        'acc_organizations', 'acc_team_members', 'acc_teams', 'acc_tools', 'acc_users',
      ].sort(),
    );
  });

  it('migrations up sao aditivas: sem DROP/TRUNCATE/DELETE; ALTER TABLE so ADD em tabelas acc_*', () => {
    for (const m of migrations) {
      const sql = stripComments(m.up);
      expect(sql, m.id).not.toMatch(/^\s*(DROP|TRUNCATE|DELETE\s+FROM)\b/im);
      // cada comando ALTER TABLE: alvo acc_* e SOMENTE clausulas ADD (nada de DROP/RENAME/ALTER COLUMN/TYPE/SET)
      for (const stmt of sql.split(';').map((x) => x.trim()).filter((x) => /^ALTER\s+TABLE\b/i.test(x))) {
        expect(stmt, `${m.id}: ${stmt.slice(0, 60)}`).toMatch(/^ALTER\s+TABLE\s+acc_[a-z_]+\s+ADD\s/i);
        const clauses = stmt.replace(/^ALTER\s+TABLE\s+acc_[a-z_]+\s+/i, '');
        expect(clauses, m.id).not.toMatch(/\b(DROP|RENAME|ALTER\s+COLUMN|SET\s+(NOT\s+NULL|DEFAULT|DATA)|TYPE)\b/i);
      }
      // UPDATE em migration (ex.: backfill) so em tabelas acc_*
      for (const m2 of sql.matchAll(/^\s*UPDATE\s+([a-z0-9_.]+)/gim)) expect(m2[1], m.id).toMatch(/^acc_/);
    }
  });

  it('todo rollback de migration com colunas/dados sensiveis tem guarda propria ou lista tabelas', () => {
    const m5 = migrations.find((m: { id: string }) => m.id.startsWith('0005'));
    expect(m5.down).toMatch(/acc\.force/); // guarda SQL com --force explicito
    const m7 = migrations.find((m: { id: string }) => m.id.startsWith('0007'));
    expect(m7.ignoreRows).toEqual(['acc_event_types']);
  });

  it('nenhuma migration referencia tabelas vne_* nem tabelas do n8n', () => {
    for (const m of migrations) {
      for (const sql of [m.up, m.down].map(stripComments)) {
        expect(sql, m.id).not.toMatch(/\bvne_[a-z_]+/i);
        expect(sql, m.id).not.toMatch(/\b(workflow_entity|execution_entity|credentials_entity)\b/i);
      }
    }
  });

  it('rollback so remove objetos acc_*', () => {
    for (const m of migrations) {
      const drops = [...stripComments(m.down).matchAll(/DROP\s+(?:TABLE|FUNCTION)\s+(?:IF EXISTS\s+)?([a-z0-9_]+)/gi)];
      for (const d of drops) expect(d[1]).toMatch(/^acc_/);
    }
  });

  it('agents are data: nenhum nome de agente hardcoded em migrations ou src', () => {
    const banned = /\b(sophia|higor|julia|lucia|nike|p[oó]s[-_ ]?venda)\b/i;
    const files = [
      ...readdirSync(dir).map((f) => join(dir, f)),
      ...readdirSync(join(__dirname, '..', 'src'), { recursive: true })
        .map(String)
        .filter((f) => /\.(ts|tsx)$/.test(f))
        .map((f) => join(__dirname, '..', 'src', f)),
    ];
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(banned);
  });

  it('nao ha segredos nas migrations', () => {
    for (const m of migrations) {
      expect(m.up, m.id).not.toMatch(/(password|secret|token|api[_-]?key)\s*(=|:)\s*'[^']+'/i);
    }
  });
});

describe('runner: funcoes puras', () => {
  it('checksum ignora diferenca de quebra de linha', () => {
    expect(checksum('a\r\nb')).toBe(checksum('a\nb'));
  });

  it('summarize conta objetos sem executar SQL', () => {
    const s = summarize('CREATE TABLE acc_x (id int);\nCREATE INDEX i ON acc_x (id);\nINSERT INTO acc_x VALUES (1);');
    expect(s).toMatchObject({ tables: ['acc_x'], indexes: 1, inserts: 1, drops: 0 });
  });

  it('destino local e permitido; remoto exige confirmacao do host exato', () => {
    expect(assertTargetAllowed('postgres://u:p@127.0.0.1:5432/db').remote).toBe(false);
    expect(() => assertTargetAllowed('postgres://u:p@db.exemplo.com/db')).toThrow(/--confirm-host/);
    expect(() => assertTargetAllowed('postgres://u:p@db.exemplo.com/db', 'outro')).toThrow();
    expect(assertTargetAllowed('postgres://u:p@db.exemplo.com/db', 'db.exemplo.com').remote).toBe(true);
    expect(() => assertTargetAllowed('nao-e-url')).toThrow(/invalida/);
  });

  it('parseArgs separa flags de comandos', () => {
    expect(parseArgs(['apply', '--confirm-host=h', '--force'])).toEqual({
      flags: { 'confirm-host': 'h', force: true },
      rest: ['apply'],
    });
  });

  it('a mensagem de erro do destino remoto nao vaza credenciais', () => {
    try {
      assertTargetAllowed('postgres://usuario:SENHA_SECRETA@db.exemplo.com/db');
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('SENHA_SECRETA');
    }
  });
});
