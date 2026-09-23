import { NextResponse, type NextRequest } from 'next/server';
import { absoluteUrl } from './lib/origin.ts';

// Checagem OTIMISTA e sem estado: so evita renderizar paginas protegidas quando nao ha cookie algum.
// A PRESENCA do cookie nunca e tratada como autenticacao: quem valida a sessao e o servidor
// (src/server/guards.ts) e, por isso, /login nunca redireciona com base no cookie — isso criaria o
// loop /login -> / -> /login quando o cookie esta invalido, expirado ou revogado.
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === '/login') return NextResponse.next();
  if (!request.cookies.has('acc_session')) {
    return NextResponse.redirect(absoluteUrl('/login', request.headers, request.nextUrl.origin));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
