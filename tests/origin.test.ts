import { describe, expect, it } from 'vitest';
import { absoluteUrl, requestOrigin } from '../src/lib/origin.ts';

const h = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });
const FALLBACK = 'http://127.0.0.1:3000';

describe('requestOrigin (redirects atras de proxy reverso)', () => {
  it('usa o host que o usuario acessou, nao o host interno', () => {
    expect(requestOrigin(h({ host: 'control.exemplo.com', 'x-forwarded-proto': 'https' }), FALLBACK)).toBe('https://control.exemplo.com');
  });

  it('X-Forwarded-Host tem prioridade; usa o primeiro valor de listas', () => {
    expect(requestOrigin(h({ host: 'interno:3000', 'x-forwarded-host': 'a.exemplo.com, b.exemplo.com', 'x-forwarded-proto': 'https, http' }), FALLBACK)).toBe('https://a.exemplo.com');
  });

  it('sem cabecalhos: usa o fallback', () => {
    expect(requestOrigin(h({}), FALLBACK)).toBe('http://127.0.0.1:3000');
  });

  it('protocolo desconhecido cai no do fallback (nunca javascript:, ftp: etc.)', () => {
    expect(requestOrigin(h({ host: 'x.com', 'x-forwarded-proto': 'javascript' }), FALLBACK)).toBe('http://x.com');
  });

  it('hosts malformados ou maliciosos sao ignorados (fallback)', () => {
    for (const host of ['evil.com/../x', 'a b.com', 'x.com@evil.com', '//evil.com', 'evil.com?x=1', '', '-x.com', 'a.com:99999999']) {
      expect(requestOrigin(h({ host }), FALLBACK), host).toBe('http://127.0.0.1:3000');
    }
  });

  it('absoluteUrl so aceita caminhos relativos a raiz (sem open redirect)', () => {
    expect(absoluteUrl('/login?motivo=expirada', h({ host: 'x.com' }), FALLBACK).href).toBe('http://x.com/login?motivo=expirada');
    for (const bad of ['//evil.com', 'https://evil.com', 'login', '']) {
      expect(() => absoluteUrl(bad, h({ host: 'x.com' }), FALLBACK), bad).toThrow();
    }
  });
});
