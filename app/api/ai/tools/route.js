import Anthropic from '@anthropic-ai/sdk';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Un turno del asistente con herramientas. El navegador ejecuta las herramientas (son funciones
// de la página: listar la bandeja, leer un correo, preparar un borrador…) y vuelve a llamar con
// los resultados hasta que Claude responde sin pedir más.
//
// POST /api/ai/tools { messages, tools, modelTier } -> { content, stop_reason }
let client = null;
const EFFORT = { quick: 'low', default: 'medium', complex: 'high' };

export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools.slice(0, 16) : [];
  if (!messages.length) return Response.json({ error: { code: 'invalid_request', message: 'Faltan mensajes.' } }, { status: 400 });

  try {
    if (!client) client = new Anthropic();
    const res = await client.beta.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-opus-5-5',
      max_tokens: 16000,
      output_config: { effort: EFFORT[body.modelTier] || 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      tools: tools.map((t) => ({ name: String(t.name), description: String(t.description || ''), input_schema: t.input_schema || { type: 'object', properties: {} } })),
      messages,
    });
    // El contenido vuelve completo (incluidos los bloques de razonamiento) para reenviarlo sin cambios.
    return Response.json({ content: res.content, stop_reason: res.stop_reason });
  } catch (e) {
    const status = e?.status;
    const noAuth = !status && /authentication|api.?key/i.test(String(e?.message));
    const code = noAuth || status === 401 || status === 403 ? 'not_granted' : status === 429 ? 'rate_limited' : status === 400 ? 'invalid_request' : 'upstream_error';
    console.error('[ai/tools]', status, e?.message);
    return Response.json({ error: { code, message: code === 'not_granted' ? 'Falta o no es válida ANTHROPIC_API_KEY en .env.local.' : 'Claude no pudo responder.' } }, { status: status || 502 });
  }
}
