export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// GET /api/me -> { emails }: tus direcciones (usuario IMAP, remitente y alias en MY_ADDRESSES, separados por coma).
// La sección Personas agrupa los correos por la dirección tuya que los recibió, como Spark.
export async function GET() {
  const pick = (s) => (String(s || '').match(/[^\s<>,"]+@[^\s<>,"]+/g) || []).map((x) => x.toLowerCase());
  const emails = [...new Set([...pick(process.env.IMAP_USER), ...pick(process.env.MAIL_FROM), ...pick(process.env.MY_ADDRESSES)])];
  return Response.json({ emails });
}
