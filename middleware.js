import { NextResponse } from 'next/server';

// Protege toda la app (interfaz y API) con usuario y contraseña.
// Sin APP_PASSWORD solo se puede abrir desde este mismo computador (localhost).
export function middleware(req) {
  // Acciones desde la notificación: protegidas por su propio token firmado (ver lib/live.js).
  if (req.nextUrl.pathname === '/api/notify-action') return NextResponse.next();
  const pass = process.env.APP_PASSWORD;
  const user = process.env.APP_USER || 'brisa';
  const host = (req.headers.get('host') || '').replace(/:\d+$/, '');
  const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

  if (!pass) {
    if (local) return NextResponse.next();
    return new NextResponse('Configura APP_PASSWORD en .env.local antes de abrir Brisa desde otro dispositivo.', { status: 403 });
  }
  const h = req.headers.get('authorization') || '';
  if (h.startsWith('Basic ')) {
    let decoded = '';
    try { decoded = new TextDecoder().decode(Uint8Array.from(atob(h.slice(6)), (c) => c.charCodeAt(0))); } catch { /* cabecera inválida */ }
    const i = decoded.indexOf(':');
    if (i > 0 && safeEqual(decoded.slice(0, i), user) && safeEqual(decoded.slice(i + 1), pass)) return NextResponse.next();
  }
  return new NextResponse('Se requiere usuario y contraseña.', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Brisa", charset="UTF-8"' } });
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export const config = { matcher: '/:path*' };
