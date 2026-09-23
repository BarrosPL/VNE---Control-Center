import { NextResponse, type NextRequest } from 'next/server';
import { absoluteUrl } from '../../../lib/origin.ts';
import { SESSION_COOKIE } from '../../../server/session-cookie.ts';

// Destino de qualquer sessao invalida (expirada, revogada, forjada): apaga o cookie obsoleto e volta
// ao login. Sem isto o cookie ficaria no navegador e cada visita recomecaria o ciclo.
export function GET(request: NextRequest) {
  const response = NextResponse.redirect(absoluteUrl('/login?motivo=expirada', request.headers, request.nextUrl.origin));
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
