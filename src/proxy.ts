import { NextResponse, type NextRequest } from 'next/server';

// Checagem OTIMISTA (somente presenca do cookie) para redirecionar cedo.
// A validacao real da sessao e a autorizacao acontecem em src/server/guards.ts.
export function proxy(request: NextRequest) {
  const hasCookie = request.cookies.has('acc_session');
  const { pathname } = request.nextUrl;
  if (pathname === '/login') {
    return hasCookie ? NextResponse.redirect(new URL('/', request.url)) : NextResponse.next();
  }
  if (!hasCookie) return NextResponse.redirect(new URL('/login', request.url));
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
