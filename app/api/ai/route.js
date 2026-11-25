import Anthropic from '@anthropic-ai/sdk';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let client = null;
function getClient() {
  // Sin credenciales el constructor falla: se informa a la página como "no disponible".
  if (!client) client = new Anthropic();
  return client;
}
const EFFORT = { quick: 'low', default: 'medium', complex: 'high' };

// POST /api/ai  { prompt, modelTier }  ->  texto en streaming (text/plain)
export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { body = {}; }
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (!prompt.trim()) return Response.json({ error: { code: 'invalid_request', message: 'Falta el texto.' } }, { status: 400 });
  if (prompt.length > 400000) return Response.json({ error: { code: 'prompt_too_large', message: 'El texto es demasiado largo.' } }, { status: 413 });

  let anthropic;
  try { anthropic = getClient(); } catch {
    return Response.json({ error: { code: 'not_granted', message: 'Falta ANTHROPIC_API_KEY en .env.local.' } }, { status: 503 });
  }

  const stream = anthropic.beta.messages.stream({
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-5-5',
    max_tokens: 16000,
    output_config: { effort: EFFORT[body.modelTier] || 'medium' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages: [{ role: 'user', content: prompt }],
  });

  // Espera el primer evento: así un error de credenciales o de cuota vuelve como JSON con su código.
  const it = stream[Symbol.asyncIterator]();
  let first;
  try {
    first = await it.next();
    // Si la conexión falla antes del primer evento, el iterador termina sin error: el error llega en finalMessage().
    if (first.done) await stream.finalMessage();
  } catch (e) {
    const status = e?.status;
    const noAuth = !status && /authentication|api.?key/i.test(String(e?.message));
    const code = noAuth || status === 401 || status === 403 ? 'not_granted' : status === 429 ? 'rate_limited' : status === 400 ? 'invalid_request' : 'upstream_error';
    const message = code === 'not_granted' ? 'La clave de Anthropic no es válida o falta. Revisa ANTHROPIC_API_KEY en .env.local.' : 'Claude no pudo responder.';
    console.error('[ai]', status, e?.message);
    return Response.json({ error: { code, message } }, { status: status || 502 });
  }

  const enc = new TextEncoder();
  const out = new ReadableStream({
    async start(ctrl) {
      try {
        for (let r = first; !r.done; r = await it.next()) {
          const ev = r.value;
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') ctrl.enqueue(enc.encode(ev.delta.text));
        }
        const final = await stream.finalMessage();
        if (final.stop_reason === 'refusal') ctrl.enqueue(enc.encode('\n\n[Claude no pudo responder a esta solicitud.]'));
        ctrl.close();
      } catch (e) {
        console.error('[ai]', e?.status, e?.message);
        ctrl.error(e);
      }
    },
    cancel() { stream.abort(); },
  });
  return new Response(out, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}
