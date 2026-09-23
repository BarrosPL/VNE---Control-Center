// Origem publica do request, para montar redirecionamentos ABSOLUTOS corretos atras de proxy reverso
// (EasyPanel/Traefik). `request.url` reflete o host interno do servidor, nao o que o usuario acessou.
// Funcao pura (sem imports do Next) para poder ser usada no proxy e em Route Handlers e testada.

const HOST_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/i;

export function requestOrigin(headers: Pick<Headers, 'get'>, fallbackOrigin: string): string {
  const first = (v: string | null) => v?.split(',')[0]?.trim() || null;
  const host = first(headers.get('x-forwarded-host')) ?? first(headers.get('host'));
  const proto = first(headers.get('x-forwarded-proto'));
  const fallback = new URL(fallbackOrigin);
  if (!host || !HOST_RE.test(host)) return fallback.origin; // host malformado/ausente: nunca confie
  const scheme = proto === 'https' || proto === 'http' ? proto : fallback.protocol.replace(':', '');
  return `${scheme}://${host}`;
}

export function absoluteUrl(path: string, headers: Pick<Headers, 'get'>, fallbackOrigin: string): URL {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('path deve ser relativo a raiz');
  return new URL(path, requestOrigin(headers, fallbackOrigin));
}
