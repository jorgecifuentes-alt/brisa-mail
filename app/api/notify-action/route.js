import { tools } from '../../../lib/mail.js';
import { checkActionToken } from '../../../lib/live.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/notify-action { id, action: 'read' | 'archive', tok }
// La llama el service worker al tocar un botón de la notificación de un correo nuevo.
export async function POST(req) {
  const { id, action, tok } = await req.json().catch(() => ({}));
  if (!['read', 'archive'].includes(action) || !(await checkActionToken(id, tok))) {
    return Response.json({ error: 'no autorizado' }, { status: 403 });
  }
  try {
    await tools.unlabel_thread({ threadId: id, labelIds: action === 'read' ? ['UNREAD'] : ['INBOX', 'UNREAD'] });
    return Response.json({ ok: true });
  } catch (e) {
    console.error('[notify-action]', e?.message || e);
    return Response.json({ error: 'No se pudo completar la acción.' }, { status: 502 });
  }
}
