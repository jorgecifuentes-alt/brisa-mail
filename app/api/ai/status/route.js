export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// GET /api/ai/status -> { enabled }: si el servidor tiene clave de Anthropic para la IA dentro de Brisa.
// Sin clave, Brisa ofrece "Pedir a Claude": abre la app de Claude del usuario con el pedido y el correo.
export async function GET() {
  return Response.json({ enabled: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) });
}
