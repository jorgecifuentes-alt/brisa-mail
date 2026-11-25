import { subscribe } from '../../../lib/live.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/events  ->  flujo SSE: "mail" cada vez que llega un correo a INBOX.
export async function GET(req) {
  const enc = new TextEncoder();
  let unsub = () => {}, ping;
  const stream = new ReadableStream({
    start(ctrl) {
      const send = (ev) => ctrl.enqueue(enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
      ctrl.enqueue(enc.encode('retry: 3000\n\n'));
      unsub = subscribe(send);
      ping = setInterval(() => { try { ctrl.enqueue(enc.encode(': ping\n\n')); } catch { /* cerrado */ } }, 25000);
      req.signal.addEventListener('abort', () => { clearInterval(ping); unsub(); try { ctrl.close(); } catch { /* ya cerrado */ } });
    },
    cancel() { clearInterval(ping); unsub(); },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' } });
}
