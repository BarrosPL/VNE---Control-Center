import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findSecretKeys, parseRegistry, productionVersion, type Registry } from '../src/domain/registry.ts';

const raw = () => JSON.parse(readFileSync(join(__dirname, '..', 'registry', 'vne.registry.json'), 'utf8'));
type Raw = ReturnType<typeof raw>;
const clone = (): Raw => structuredClone(raw());
const prod = (r: Raw, i = 0) => r.agents[i].versions.find((v: { environment: string; status: string }) => v.environment === 'production' && v.status === 'active');

describe('registro declarativo v2', () => {
  it('o arquivo real e valido, consistente e tem procedencia em todas as versoes', () => {
    const r = parseRegistry(raw());
    expect(r.schema).toBe(2);
    for (const a of r.agents) {
      expect(a.versions.length).toBeGreaterThan(0);
      for (const v of a.versions) {
        expect(v.config_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(v.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(v.source_revision).toMatch(/^n8n:/);
        expect(v.tools.length).toBeGreaterThan(0);
      }
      expect(productionVersion(a)).toBeDefined();
    }
  });

  it('versao candidata/rascunho nunca e a versao de producao em vigor', () => {
    const r = parseRegistry(raw());
    for (const a of r.agents) {
      const p = productionVersion(a)!;
      expect(p.status).toBe('active');
      for (const v of a.versions.filter((x) => x !== p)) expect(v.status === 'active' && v.environment === 'production').toBe(false);
    }
  });

  it('nao contem segredos nem conteudo de prompt', () => {
    expect(findSecretKeys(raw())).toEqual([]);
    const text = JSON.stringify(raw());
    expect(text).not.toMatch(/eyJ[a-zA-Z0-9_-]{20,}|sk-[a-zA-Z0-9]{20,}|Bearer\s/);
    expect(text).not.toMatch(/systemMessage|Você é|voce e a/i);
  });

  it('rejeita o formato antigo (v1) e chaves com aparencia de segredo', () => {
    const r = clone();
    r.schema = 1;
    expect(() => parseRegistry(r)).toThrow();
    const s = clone();
    s.integrations[0].metadata.api_key = 'x';
    expect(() => parseRegistry(s)).toThrow(/segredo/);
  });

  it('exige procedencia: hash sha256 valido, source_revision e prompt_hash', () => {
    for (const field of ['config_hash', 'prompt_hash']) {
      const r = clone();
      prod(r)[field] = 'nao-e-hash';
      expect(() => parseRegistry(r), field).toThrow();
      const m = clone();
      delete prod(m)[field];
      expect(() => parseRegistry(m), field).toThrow();
    }
    const r = clone();
    delete prod(r).source_revision;
    expect(() => parseRegistry(r)).toThrow();
  });

  it('rejeita duplicados (tool, versao, mesma configuracao no mesmo ambiente)', () => {
    let r = clone();
    r.tools.push(structuredClone(r.tools[0]));
    expect(() => parseRegistry(r)).toThrow(/tool duplicado/);
    r = clone();
    r.agents[0].versions.push(structuredClone(r.agents[0].versions[0]));
    expect(() => parseRegistry(r)).toThrow(/versao duplicado/);
    r = clone();
    const copy = structuredClone(r.agents[0].versions[0]);
    copy.version = 'outro-nome';
    copy.status = 'deprecated';
    r.agents[0].versions.push(copy);
    expect(() => parseRegistry(r)).toThrow(/config_hash por ambiente duplicado/);
  });

  it('rejeita referencias inexistentes (tool, capability, integracao)', () => {
    let r = clone();
    prod(r).tools.push('nao_existe');
    expect(() => parseRegistry(r)).toThrow(/tool inexistente/);
    r = clone();
    r.agents[0].capabilities.push('nao_existe');
    expect(() => parseRegistry(r)).toThrow(/capability inexistente/);
    r = clone();
    r.tools[0].integration = 'nao_existe';
    expect(() => parseRegistry(r)).toThrow(/integracao inexistente/);
  });

  it('a versao deve OBSERVAR a integracao usada por suas tools, e o agente deve declara-la', () => {
    let r = clone();
    prod(r).integrations = prod(r).integrations.filter((i: string) => i !== 'kommo');
    expect(() => parseRegistry(r)).toThrow(/ausente em integrations da versao/);
    r = clone();
    r.agents[0].integrations = r.agents[0].integrations.filter((i: { code: string }) => i.code !== 'kommo');
    expect(() => parseRegistry(r)).toThrow(/nao declarada em agents\[\]\.integrations/);
  });

  it('tool nao pode estar ativa e desabilitada ao mesmo tempo', () => {
    const r = clone();
    prod(r).disabled_tools = [prod(r).tools[0]];
    expect(() => parseRegistry(r)).toThrow(/ativa e desabilitada/);
  });

  it('no maximo uma versao ativa por ambiente (espelha o indice unico do banco)', () => {
    const r = clone();
    const other = structuredClone(prod(r));
    other.version = 'segunda-ativa';
    other.config_hash = 'a'.repeat(64);
    r.agents[0].versions.push(other);
    expect(() => parseRegistry(r)).toThrow(/mais de uma versao ativa/);
  });

  it('valida enums (modo operacional, mutation_level, status de versao)', () => {
    let r = clone();
    r.agents[0].operational_mode = 'turbo';
    expect(() => parseRegistry(r)).toThrow();
    r = clone();
    r.tools[0].mutation_level = 'delete-all';
    expect(() => parseRegistry(r)).toThrow();
    r = clone();
    prod(r).status = 'live';
    expect(() => parseRegistry(r)).toThrow();
  });

  it('toda tool de sub-workflow e mutavel (nenhuma escrita marcada como leitura por engano)', () => {
    const r: Registry = parseRegistry(raw());
    for (const t of r.tools) if (t.tool_type === 'n8n_workflow') expect(t.mutation_level).not.toBe('read');
  });
});
