import { promises as fs } from 'node:fs';
import path from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Almacén de documentos JSON en data/store.json (firma, plantillas, pospuestos, notas, equipo).
const FILE = path.join(process.cwd(), 'data', 'store.json');
let cache = null;
let writing = Promise.resolve();

async function load() {
  if (cache) return cache;
  try { cache = JSON.parse(await fs.readFile(FILE, 'utf8')); } catch { cache = {}; }
  return cache;
}
function save() {
  writing = writing.then(async () => {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.writeFile(FILE + '.tmp', JSON.stringify(cache, null, 1));
    await fs.rename(FILE + '.tmp', FILE);
  });
  return writing;
}
const valid = (p) => typeof p === 'string' && /^[A-Za-z0-9_\-.~:@+]+(\/[A-Za-z0-9_\-.~:@+]+)*$/.test(p) && p.length < 1000;
const parentOf = (p) => p.split('/').slice(0, -1).join('/');

// GET /api/store?doc=a/b         -> { doc }
// GET /api/store?collection=a    -> { docs: [{ id, data }] }
export async function GET(req) {
  const u = new URL(req.url);
  const db = await load();
  const doc = u.searchParams.get('doc');
  if (doc) return Response.json({ doc: valid(doc) ? db[doc] ?? null : null });
  const col = u.searchParams.get('collection');
  if (!valid(col)) return Response.json({ error: 'ruta no válida' }, { status: 400 });
  const docs = Object.entries(db).filter(([k]) => parentOf(k) === col).map(([k, v]) => ({ id: k.split('/').pop(), data: v }));
  return Response.json({ docs });
}

// POST /api/store { op: 'set'|'update'|'delete', path, data }
export async function POST(req) {
  const { op, path: p, data } = await req.json().catch(() => ({}));
  if (!valid(p) || p.split('/').length % 2) return Response.json({ error: 'ruta no válida' }, { status: 400 });
  const db = await load();
  if (op === 'set') db[p] = data ?? {};
  else if (op === 'update') db[p] = { ...(db[p] || {}), ...(data || {}) };
  else if (op === 'delete') delete db[p];
  else return Response.json({ error: 'operación no válida' }, { status: 400 });
  await save();
  return Response.json({ ok: true });
}
