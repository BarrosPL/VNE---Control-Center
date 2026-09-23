import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findSecretKeys, parseRegistry, type Registry } from '../src/domain/registry.ts';

const raw = () => JSON.parse(readFileSync(join(__dirname, '..', 'registry', 'vne.registry.json'), 'utf8'));
const clone = (): Registry & Record<string, unknown> => structuredClone(raw());

describe('registro declarativo', () => {
  it('o arquivo real e valido e consistente', () => {
    const r = parseRegistry(raw());
    expect(r.agents.length).toBeGreaterThanOrEqual(2);
    for (const a of r.agents) expect(a.tools.length).toBeGreaterThan(0);
  });

  it('nao contem segredos (nenhuma chave com aparencia de credencial)', () => {
    expect(findSecretKeys(raw())).toEqual([]);
    expect(JSON.stringify(raw())).not.toMatch(/eyJ[a-zA-Z0-9_-]{20,}|sk-[a-zA-Z0-9]{20,}|Bearer\s/);
  });

  it('rejeita chaves com aparencia de segredo', () => {
    const r = clone();
    (r.integrations[0].metadata as Record<string, unknown>).api_key = 'x';
    expect(() => parseRegistry(r)).toThrow(/segredo/);
  });

  it('rejeita duplicados', () => {
    const r = clone();
    r.tools.push(structuredClone(r.tools[0]));
    expect(() => parseRegistry(r)).toThrow(/tool duplicado/);
  });

  it('rejeita referencias inexistentes (tool, capability, integracao)', () => {
    let r = clone();
    r.agents[0].tools.push('nao_existe');
    expect(() => parseRegistry(r)).toThrow(/tool inexistente/);
    r = clone();
    r.agents[0].capabilities.push('nao_existe');
    expect(() => parseRegistry(r)).toThrow(/capability inexistente/);
    r = clone();
    r.tools[0].integration = 'nao_existe';
    expect(() => parseRegistry(r)).toThrow(/integracao inexistente/);
  });

  it('exige que o agente declare a integracao usada por suas tools', () => {
    const r = clone();
    r.agents[0].integrations = r.agents[0].integrations.filter((i) => i.code !== 'kommo');
    expect(() => parseRegistry(r)).toThrow(/nao declarada/);
  });

  it('valida enums (modo operacional, mutation_level)', () => {
    let r = clone();
    (r.agents[0] as { operational_mode: string }).operational_mode = 'turbo';
    expect(() => parseRegistry(r)).toThrow();
    r = clone();
    (r.tools[0] as { mutation_level: string }).mutation_level = 'delete-all';
    expect(() => parseRegistry(r)).toThrow();
  });

  it('toda tool mutavel de risco alto e explicita (nenhuma escrita marcada como leitura por engano)', () => {
    const r = parseRegistry(raw());
    for (const t of r.tools) if (t.tool_type === 'n8n_workflow') expect(t.mutation_level).not.toBe('read');
  });
});
