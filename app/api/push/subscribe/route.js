import { addSubscription } from '../../../../lib/live.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// POST /api/push/subscribe { subscription } -> guarda el dispositivo para recibir avisos de correo nuevo.
export async function POST(req) {
  const { subscription } = await req.json().catch(() => ({}));
  try { await addSubscription(subscription); return Response.json({ ok: true }); }
  catch (e) { return Response.json({ error: e.message }, { status: 400 }); }
}
