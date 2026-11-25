import { vapid } from '../../../../lib/live.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// GET /api/push/key -> { key }: clave pública para suscribirse a las notificaciones push.
export async function GET() { return Response.json({ key: (await vapid()).publicKey }); }
