import { tools, invalidateScan } from '../../../../lib/mail.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/gmail/<herramienta>  { ...input }  ->  { payload } | { error: { code, message } }
export async function POST(req, { params }) {
  const fn = tools[params.tool];
  if (!fn) return Response.json({ error: { code: 'bad_request', message: 'Herramienta desconocida.' } }, { status: 400 });
  let input = {};
  try { input = await req.json(); } catch { /* sin cuerpo */ }
  // "Deslizar para actualizar": saltarse el caché corto del servidor.
  if (req.headers.get('x-brisa-fresh') === '1') invalidateScan();
  try {
    const payload = await fn(input || {});
    return Response.json({ payload });
  } catch (e) {
    const auth = /auth|login|credential/i.test(String(e?.responseText || e?.message || ''));
    const code = e?.code === 'tool_error' ? 'tool_error' : auth ? 'needs_reauth' : 'server_unavailable';
    const message = code === 'tool_error' ? e.message
      : auth ? 'Tu proveedor de correo rechazó el usuario o la contraseña. Revisa IMAP_USER e IMAP_PASS.'
      : 'No se pudo conectar con el servidor de correo.';
    console.error(`[gmail/${params.tool}]`, e?.message || e);
    return Response.json({ error: { code, message } }, { status: code === 'tool_error' ? 422 : 502 });
  }
}
