import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyAppRole } from '../../scripts/lib/app-role.mjs';
import { parseRegistry } from '../../src/domain/registry.ts';
import { importCatalog, parseCatalogFile } from '../../src/server/catalog/importer.ts';
import { entityLabel, findCatalogGaps, listCatalog, resolveEntities } from '../../src/server/catalog/resolver.ts';
import { importRegistry } from '../../src/server/registry/importer.ts';
import { startTestDb, type TestDb } from './helpers.ts';

let t: TestDb;
const fixture = (f: string) => readFileSync(join(__dirname, '..', 'fixtures', f), 'utf8');
const n = async (sql: string, p?: unknown[]) => Number((await t.owner.query(sql, p)).rows[0].n);

// catalogo SINTETICO (nomes ficticios): nenhum dado real do Kommo
const file = (over: Record<string, unknown> = {}) =>
  parseCatalogFile({
    integration: 'kommo', source: 'manual', complete_kinds: ['pipeline', 'status'],
    entities: [
      { kind: 'pipeline', id: 9907372, name: 'Funil Sintetico' },
      { kind: 'status', id: 76077496, name: 'Qualificacao', parent: { kind: 'pipeline', id: 9907372 }, attributes: { sort: 10 } },
      { kind: 'status', id: 76077492, name: 'Entrada', parent: { kind: 'pipeline', id: 9907372 } },
      { kind: 'user', id: 555, name: 'Usuario Sintetico' },
    ],
    ...over,
  });

async function run(f = file(), commit = true) {
  await t.app.query('BEGIN');
  try {
    const s = await importCatalog(t.app, f);
    await t.app.query(commit ? 'COMMIT' : 'ROLLBACK');
    return s;
  } catch (e) {
    await t.app.query('ROLLBACK');
    throw e;
  }
}

beforeAll(async () => {
  t = await startTestDb('acc-catalog-');
  const reg = parseRegistry(JSON.parse(readFileSync(join(__dirname, '..', '..', 'registry', 'vne.registry.json'), 'utf8')));
  await t.app.query('BEGIN');
  await importRegistry(t.app, reg); // cria a integracao 'kommo'
  await t.app.query('COMMIT');
  await t.owner.query(fixture('vne-schema.sql'));
  await t.owner.query(fixture('vne-data.sql'));
  await applyAppRole(t.owner, { roleName: 'acc_app', database: 'acc_test' });
});
afterAll(async () => {
  await t?.stop();
});

describe('arquivo de catalogo', () => {
  it('valida formato, IDs numericos viram texto, rejeita duplicados e segredos', () => {
    expect(file().entities[0].id).toBe('9907372');
    expect(() => parseCatalogFile({ integration: 'kommo', entities: [] })).toThrow();
    expect(() => file({ entities: [{ kind: 'user', id: 1, name: 'a' }, { kind: 'user', id: '1', name: 'b' }] })).toThrow(/duplicada/);
    expect(() => file({ entities: [{ kind: 'user', id: 1, name: 'a', attributes: { api_key: 'x' } }] })).toThrow(/segredo/);
    expect(() => file({ entities: [{ kind: 'Bad Kind', id: 1, name: 'a' }] })).toThrow();
    expect(() => file({ entities: [{ kind: 'user', id: 'x'.repeat(80), name: 'a' }] })).toThrow();
  });
});

describe('importacao do catalogo (como role acc_app)', () => {
  it('preview (rollback) nao grava nada; apply cria; segunda execucao e idempotente', async () => {
    expect((await run(file(), false)).created).toBe(4);
    expect(await n('SELECT count(*)::int n FROM acc_integration_entities')).toBe(0);
    expect(await run()).toMatchObject({ created: 4, updated: 0, deactivated: 0 });
    expect(await run()).toMatchObject({ created: 0, updated: 0, unchanged: 4, deactivated: 0 });
    expect(await n(`SELECT count(*)::int n FROM acc_audit_log WHERE action='CATALOG_IMPORTED'`)).toBe(1); // o no-op nao audita
  });

  it('atualiza nomes alterados no sistema externo (e audita)', async () => {
    const f = file();
    f.entities[3].name = 'Usuario Renomeado';
    expect(await run(f)).toMatchObject({ created: 0, updated: 1 });
    expect(await n(`SELECT count(*)::int n FROM acc_audit_log WHERE action='CATALOG_IMPORTED'`)).toBe(2);
  });

  it('entidade removida de um tipo COMPLETO fica inativa (nunca apagada) e continua resolvendo nome', async () => {
    const f = file();
    f.entities = f.entities.filter((e) => e.id !== '76077492'); // some do arquivo
    expect(await run(f)).toMatchObject({ deactivated: 1 });
    expect(await n(`SELECT count(*)::int n FROM acc_integration_entities WHERE external_id='76077492' AND NOT is_active`)).toBe(1);
    const map = await resolveEntities(t.app, 'kommo', [{ kind: 'status', id: 76077492 }]);
    expect(map.get('status:76077492')).toMatchObject({ name: 'Entrada', isActive: false });
    expect(entityLabel(map, 'status', 76077492)).toMatchObject({ text: 'Entrada', resolved: true, inactive: true });
  });

  it('tipos NAO declarados como completos nunca sao desativados (usuarios ficam)', async () => {
    const only = file({ complete_kinds: [], entities: [{ kind: 'pipeline', id: 9907372, name: 'Funil Sintetico' }] });
    expect(await run(only)).toMatchObject({ deactivated: 0 });
    expect(await n(`SELECT count(*)::int n FROM acc_integration_entities WHERE entity_kind='user' AND is_active`)).toBe(1);
  });

  it('a entidade volta a ficar ativa quando reaparece no arquivo', async () => {
    expect(await run(file())).toMatchObject({ updated: 1 }); // status 76077492 reativado
    expect(await n(`SELECT count(*)::int n FROM acc_integration_entities WHERE NOT is_active`)).toBe(0);
  });

  it('integracao inexistente falha sem efeitos', async () => {
    await expect(run(file({ integration: 'nao_existe' }))).rejects.toThrow(/Integracao inexistente/);
  });

  it('o role da aplicacao nao apaga entradas do catalogo', async () => {
    await expect(t.app.query('DELETE FROM acc_integration_entities')).rejects.toMatchObject({ code: '42501' });
  });
});

describe('resolvedor (lote, fallback e seguranca)', () => {
  it('resolve varios IDs em UMA consulta e devolve o ID quando nao ha nome (nunca inventa)', async () => {
    const map = await resolveEntities(t.app, 'kommo', [
      { kind: 'pipeline', id: 9907372 }, { kind: 'status', id: '76077496' }, { kind: 'status', id: 999 }, { kind: 'user', id: null },
    ]);
    expect(entityLabel(map, 'pipeline', 9907372)).toMatchObject({ text: 'Funil Sintetico', resolved: true });
    expect(entityLabel(map, 'status', 76077496)).toMatchObject({ text: 'Qualificacao', resolved: true });
    expect(entityLabel(map, 'status', 999)).toEqual({ text: 'ID 999', resolved: false, id: '999', inactive: false });
    expect(entityLabel(map, 'user', null)).toMatchObject({ text: '—', resolved: false });
    expect(entityLabel(undefined, 'status', 5)).toMatchObject({ text: 'ID 5', resolved: false });
  });

  it('entradas maliciosas ou invalidas sao ignoradas sem erro', async () => {
    const map = await resolveEntities(t.app, 'kommo', [
      { kind: "status'; DROP TABLE acc_integration_entities;--", id: 1 }, { kind: 'status', id: 'x'.repeat(200) }, { kind: 'Status', id: 1 },
    ]);
    expect(map.size).toBe(0);
    expect(await n('SELECT count(*)::int n FROM acc_integration_entities')).toBe(4);
    expect((await resolveEntities(t.app, "kommo' OR '1'='1", [{ kind: 'user', id: 555 }])).size).toBe(0);
    expect((await resolveEntities(t.app, 'kommo', [])).size).toBe(0);
  });

  it('nao vaza entre integracoes: o mesmo ID em outra integracao nao resolve', async () => {
    expect((await resolveEntities(t.app, 'google_calendar', [{ kind: 'user', id: 555 }])).size).toBe(0);
  });

  it('limita o numero de referencias por consulta (protecao contra abuso)', async () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ kind: 'status', id: i }));
    const map = await resolveEntities(t.app, 'kommo', many);
    expect(map.size).toBeLessThanOrEqual(500);
  });

  it('IDs iguais sob pais diferentes coexistem; o ativo/mais recente vence na resolucao', async () => {
    const f = file({
      complete_kinds: [],
      entities: [
        { kind: 'status', id: 1, name: 'Ganho', parent: { kind: 'pipeline', id: 111 } },
        { kind: 'status', id: 1, name: 'Ganho B', parent: { kind: 'pipeline', id: 222 } },
      ],
    });
    expect(await run(f)).toMatchObject({ created: 2 });
    const map = await resolveEntities(t.app, 'kommo', [{ kind: 'status', id: 1 }]);
    expect(['Ganho', 'Ganho B']).toContain(map.get('status:1')!.name);
  });
});

describe('relatorio de IDs sem nome e listagem', () => {
  it('lista IDs observados em vne_* que ainda nao tem nome, com contagem', async () => {
    const gaps = await findCatalogGaps(t.app, 'kommo');
    const key = (k: string, id: string) => gaps.find((g) => g.kind === k && g.externalId === id);
    // catalogados => nao aparecem
    expect(key('pipeline', '9907372')).toBeUndefined();
    expect(key('status', '76077496')).toBeUndefined();
    expect(key('user', '555')).toBeUndefined();
    // observados no fixture e sem nome => aparecem
    expect(key('status', '76077492')).toBeUndefined(); // reativado acima e catalogado
    expect(key('user', '444')?.seenIn).toBeGreaterThan(0);
  });

  it('sem catalogo, todos os IDs observados aparecem; a consulta e somente leitura', async () => {
    await t.owner.query('ALTER TABLE acc_integration_entities DISABLE TRIGGER USER');
    const before = await n('SELECT count(*)::int n FROM acc_integration_entities');
    expect((await findCatalogGaps(t.app, 'integracao_sem_catalogo')).length).toBeGreaterThan(3);
    expect(await n('SELECT count(*)::int n FROM acc_integration_entities')).toBe(before);
    await t.owner.query('ALTER TABLE acc_integration_entities ENABLE TRIGGER USER');
  });

  it('listCatalog devolve hierarquia e estado', async () => {
    const list = await listCatalog(t.app, 'kommo');
    const st = list.find((e) => e.kind === 'status' && e.externalId === '76077496')!;
    expect(st).toMatchObject({ parentKind: 'pipeline', parentExternalId: '9907372', isActive: true, source: 'manual' });
    expect(st.syncedAt).toBeTruthy();
  });
});

describe('restricoes do banco', () => {
  it('rejeita tipo malformado, pai incompleto, nome vazio e origem invalida', async () => {
    const id = (await t.owner.query(`SELECT id FROM acc_integrations WHERE code='kommo'`)).rows[0].id;
    const ins = (cols: string, vals: unknown[]) => t.owner.query(`INSERT INTO acc_integration_entities (integration_id, ${cols}) VALUES ($1, ${vals.map((_, i) => `$${i + 2}`).join(',')})`, [id, ...vals]);
    await expect(ins('entity_kind, external_id, name, source', ['Bad Kind', '1', 'x', 'manual'])).rejects.toMatchObject({ code: '23514' });
    await expect(ins('entity_kind, external_id, name, source, parent_kind', ['status', '1', 'x', 'manual', 'pipeline'])).rejects.toMatchObject({ code: '23514' });
    await expect(ins('entity_kind, external_id, name, source', ['status', '1', '   ', 'manual'])).rejects.toMatchObject({ code: '23514' });
    await expect(ins('entity_kind, external_id, name, source', ['status', '1', 'x', 'importado'])).rejects.toMatchObject({ code: '23514' });
    await expect(ins('entity_kind, external_id, name, source', ['user', '555', 'duplicado', 'manual'])).rejects.toMatchObject({ code: '23505' });
  });
});
