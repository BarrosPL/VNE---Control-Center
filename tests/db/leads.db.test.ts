import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyAppRole } from '../../scripts/lib/app-role.mjs';
import { recordEntityView } from '../../src/server/auth/audit.ts';
import {
  findAgentBySlug, getLeadHeader, getTimeline, isValidLeadId, listLeads, PAGE_SIZE,
  type MessageItem, type EventItem,
} from '../../src/server/queries/leads.ts';
import { startTestDb, type TestDb } from './helpers.ts';

let t: TestDb;
const fixture = (f: string) => readFileSync(join(__dirname, '..', 'fixtures', f), 'utf8');

beforeAll(async () => {
  t = await startTestDb('acc-leads-');
  await t.owner.query(fixture('vne-schema.sql'));
  await t.owner.query(fixture('vne-data.sql'));
  await applyAppRole(t.owner, { roleName: 'acc_app', database: 'acc_test' }); // concede SELECT nas vne_* recem-criadas
});
afterAll(async () => {
  await t?.stop();
});

describe('listLeads', () => {
  it('lista todos ordenados por ultima atividade e usa o nome do contato como fallback', async () => {
    const r = await listLeads(t.app, {});
    // a lista parte do snapshot: o lead 1002 (so mensagens/janela) nao aparece, mas abre por ID direto
    expect(r.total).toBe(3);
    expect(r.items.map((i) => i.leadId)).toEqual(['1001', '1004', '1003']);
    expect(r.items[0].leadId).toBe('1001'); // atividade mais recente
    expect(r.items.find((i) => i.leadId === '1003')).toMatchObject({ name: 'Fulano de Tal', isDeleted: true });
    expect(r.items.find((i) => i.leadId === '1001')).toMatchObject({ lastWorkflow: 'sophia', totalIncoming: 2, totalOutgoing: 2 });
  });

  it('busca por ID numerico e por nome (parcial, sem diferenciar caixa)', async () => {
    expect((await listLeads(t.app, { q: '1001' })).items.map((i) => i.leadId)).toEqual(['1001']);
    expect((await listLeads(t.app, { q: 'maria' })).items.map((i) => i.leadId)).toEqual(['1001']);
    expect((await listLeads(t.app, { q: 'fulano' })).items.map((i) => i.leadId)).toEqual(['1003']);
  });

  it('caracteres curinga (% _) sao literais, nao coringas', async () => {
    expect((await listLeads(t.app, { q: '%' })).items.map((i) => i.leadId)).toEqual(['1004']);
    expect((await listLeads(t.app, { q: '_' })).items.map((i) => i.leadId)).toEqual(['1004']);
    expect((await listLeads(t.app, { q: '100%' })).items.map((i) => i.leadId)).toEqual(['1004']);
  });

  it('entradas maliciosas nao quebram nem injetam SQL', async () => {
    for (const q of ["'; DROP TABLE vne_mensagens; --", '1 OR 1=1', '99999999999999999999', '\\']) {
      const r = await listLeads(t.app, { q });
      expect(r.total).toBe(0);
    }
    expect((await t.owner.query('SELECT count(*)::int n FROM vne_mensagens')).rows[0].n).toBeGreaterThan(0);
  });

  it('paginacao: pagina invalida vira 1; alem do fim retorna vazio', async () => {
    expect((await listLeads(t.app, { page: -5 })).page).toBe(1);
    expect((await listLeads(t.app, { page: Number.NaN })).page).toBe(1);
    const far = await listLeads(t.app, { page: 50 });
    expect(far.items).toHaveLength(0);
    expect(far.total).toBe(3);
    expect(PAGE_SIZE).toBe(25);
  });
});

describe('getLeadHeader', () => {
  it('lead completo: snapshot + janela + canais (uniao chat_map e janela)', async () => {
    const h = (await getLeadHeader(t.app, '1001'))!;
    expect(h).toMatchObject({
      leadId: '1001', name: 'Maria Teste Silva', inSnapshot: true, pipelineId: '9907372', statusId: '76077496',
      responsibleUserId: '555', totalIncoming: 2, totalOutgoing: 2, lastWorkflow: 'sophia', talks: 2, isDeleted: false,
    });
    expect(h.channels).toEqual(['instagram_business', 'waba']);
    expect(Number(h.price)).toBe(1500);
    expect(h.lastClientMessageAt).toBeTruthy();
  });

  it('lead sem snapshot (so mensagens/janela) ainda existe e sinaliza inSnapshot=false', async () => {
    const h = (await getLeadHeader(t.app, '1002'))!;
    expect(h).toMatchObject({ inSnapshot: false, name: 'Contato Sem Snapshot', pipelineId: null, lastWorkflow: 'agente_nao_cadastrado' });
  });

  it('ids invalidos ou inexistentes => null, sem erro', async () => {
    for (const id of ['abc', '1 OR 1=1', "1'; --", '', '9'.repeat(30), '-5', '1.5']) {
      expect(isValidLeadId(id)).toBe(false);
      expect(await getLeadHeader(t.app, id)).toBeNull();
    }
    expect(await getLeadHeader(t.app, '424242')).toBeNull();
  });
});

describe('getTimeline', () => {
  it('mescla mensagens e eventos em ordem decrescente de tempo', async () => {
    const r = await getTimeline(t.app, '1001', { includeContent: true });
    expect(r.items).toHaveLength(8); // 4 mensagens + 4 eventos
    const times = r.items.map((i) => new Date(i.at!).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(new Set(r.items.map((i) => i.kind))).toEqual(new Set(['message', 'event']));
  });

  it('filtros de visao', async () => {
    const m = await getTimeline(t.app, '1001', { view: 'messages', includeContent: true });
    const e = await getTimeline(t.app, '1001', { view: 'events', includeContent: true });
    expect(m.items.every((i) => i.kind === 'message') && m.items).toHaveLength(4);
    expect(e.items.every((i) => i.kind === 'event') && e.items).toHaveLength(4);
    // os CAMPOS (nao so a contagem) devem ser os mesmos em cada visao e na visao combinada
    const all = await getTimeline(t.app, '1001', { view: 'all', includeContent: true });
    expect(m.items).toEqual(all.items.filter((i) => i.kind === 'message'));
    expect(e.items).toEqual(all.items.filter((i) => i.kind === 'event'));
    expect((e.items as EventItem[]).map((x) => x.eventType).sort()).toEqual(
      ['lead_created', 'lead_responsible_changed', 'lead_status_changed', 'task_created'],
    );
    expect((m.items as MessageItem[]).map((x) => x.direction).sort()).toEqual(['entrada', 'entrada', 'saida', 'saida']);
  });

  it('com conteudo: texto, anexo e tarefa aparecem; classificacao de autor preservada', async () => {
    const r = await getTimeline(t.app, '1001', { includeContent: true });
    const msgs = r.items.filter((i): i is MessageItem => i.kind === 'message');
    expect(msgs.map((m) => m.authorClass).sort()).toEqual(['bot', 'cliente', 'cliente', 'humano']);
    expect(msgs.find((m) => m.attachmentName)?.attachmentName).toBe('passaporte.pdf');
    expect(msgs.find((m) => m.authorClass === 'humano')?.text).toBe('Recebido!\nVou analisar.');
    expect(msgs.find((m) => m.authorClass === 'bot')?.isAutomated).toBe(true);
    const ev = r.items.filter((i): i is EventItem => i.kind === 'event');
    expect(ev.find((e) => e.eventType === 'task_created')?.taskText).toBe('Ligar para a cliente');
    const moved = ev.find((e) => e.eventType === 'lead_status_changed')!;
    expect([moved.previousStatusId, moved.statusId]).toEqual(['76077492', '76077496']);
  });

  it('SEM conversations:read o conteudo nem sai do banco (menor privilegio)', async () => {
    const r = await getTimeline(t.app, '1001', { includeContent: false });
    const json = JSON.stringify(r.items);
    for (const secret of ['quero saber', 'Qual seu nome', 'passaporte', 'Vou analisar', 'Ligar para a cliente']) {
      expect(json).not.toContain(secret);
    }
    const msgs = r.items.filter((i): i is MessageItem => i.kind === 'message');
    expect(msgs.every((m) => m.contentRestricted && m.text === null && m.attachmentName === null)).toBe(true);
    expect(msgs.map((m) => m.authorClass).sort()).toEqual(['bot', 'cliente', 'cliente', 'humano']); // metadados continuam
  });

  it('o payload bruto dos eventos nunca e exposto', async () => {
    for (const includeContent of [true, false]) {
      const r = await getTimeline(t.app, '1001', { includeContent });
      expect(JSON.stringify(r)).not.toContain('PAYLOAD_SECRET_MARKER');
    }
  });

  it('limite: hasMore, clamp e fallback', async () => {
    const two = await getTimeline(t.app, '1001', { limit: 2, includeContent: true });
    expect(two.items).toHaveLength(2);
    expect(two.hasMore).toBe(true);
    const all = await getTimeline(t.app, '1001', { limit: 8, includeContent: true });
    expect(all.hasMore).toBe(false);
    expect((await getTimeline(t.app, '1001', { limit: 99999, includeContent: true })).limit).toBe(500);
    expect((await getTimeline(t.app, '1001', { limit: -3, includeContent: true })).limit).toBe(50);
    expect((await getTimeline(t.app, '1001', { limit: 0, includeContent: true })).limit).toBe(50);
  });

  it('nao vaza dados de outros leads e ids invalidos retornam vazio', async () => {
    const r = await getTimeline(t.app, '1002', { includeContent: true });
    expect(r.items).toHaveLength(1);
    expect(JSON.stringify(r.items)).not.toContain('Maria');
    expect((await getTimeline(t.app, "1; DROP TABLE vne_mensagens", { includeContent: true })).items).toEqual([]);
  });
});

describe('vinculo com agentes (por dado) e auditoria de visualizacao', () => {
  it('findAgentBySlug liga vne_janela_meta.ultimo_workflow ao cadastro; ausente => null', async () => {
    const org = (await t.owner.query(`SELECT id FROM acc_organizations WHERE slug='vne'`)).rows[0].id;
    await t.owner.query(`INSERT INTO acc_agents (organization_id, slug, name, agent_type) VALUES ($1,'sophia','Agente A','x')`, [org]);
    expect(await findAgentBySlug(t.app, 'sophia')).toMatchObject({ name: 'Agente A' });
    expect(await findAgentBySlug(t.app, 'agente_nao_cadastrado')).toBeNull();
    expect(await findAgentBySlug(t.app, null)).toBeNull();
  });

  it('recordEntityView audita e deduplica por usuario+lead em 10 minutos', async () => {
    const uid = (await t.owner.query(`INSERT INTO acc_users (name, email, role) VALUES ('U','u@x.com','specialist') RETURNING id`)).rows[0].id;
    const count = async () => Number((await t.owner.query(`SELECT count(*)::int n FROM acc_audit_log WHERE action='ENTITY_VIEWED'`)).rows[0].n);
    await recordEntityView(t.app, { actorId: uid, entityType: 'lead', entityId: '1001', reason: 'lead_360' });
    await recordEntityView(t.app, { actorId: uid, entityType: 'lead', entityId: '1001', reason: 'lead_360' });
    expect(await count()).toBe(1);
    await recordEntityView(t.app, { actorId: uid, entityType: 'lead', entityId: '1002', reason: 'lead_360' });
    expect(await count()).toBe(2);
    await t.owner.query(`ALTER TABLE acc_audit_log DISABLE TRIGGER trg_acc_audit_log_no_update_delete`);
    await t.owner.query(`UPDATE acc_audit_log SET created_at = now() - interval '11 minutes' WHERE action='ENTITY_VIEWED'`);
    await t.owner.query(`ALTER TABLE acc_audit_log ENABLE TRIGGER trg_acc_audit_log_no_update_delete`);
    await recordEntityView(t.app, { actorId: uid, entityType: 'lead', entityId: '1001', reason: 'lead_360' });
    expect(await count()).toBe(3);
  });

  it('as consultas usam somente SELECT nas vne_* (role sem escrita)', async () => {
    await expect(t.app.query(`UPDATE vne_mensagens SET texto = 'x'`)).rejects.toMatchObject({ code: '42501' });
    await expect(t.app.query(`DELETE FROM vne_leads_snapshot`)).rejects.toMatchObject({ code: '42501' });
    await expect(t.app.query(`INSERT INTO vne_janela_meta (lead_id, ultima_mensagem_cliente_em) VALUES (1, now())`)).rejects.toMatchObject({ code: '42501' });
  });
});
