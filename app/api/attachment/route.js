import { getAttachment } from '../../../lib/mail.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/attachment?m=<id de mensaje>&i=<posición>&n=<nombre>  ->  el archivo, para verlo en el navegador.
export async function GET(req) {
  const u = new URL(req.url);
  try {
    const a = await getAttachment(u.searchParams.get('m'), u.searchParams.get('i'), u.searchParams.get('n'));
    const safe = String(a.filename).replace(/["\\\r\n]/g, '_');
    return new Response(a.content, { headers: {
      'content-type': a.contentType,
      'content-disposition': `inline; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
    } });
  } catch (e) {
    return new Response(`No se pudo abrir el adjunto: ${e?.message || 'error'}`, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
}
