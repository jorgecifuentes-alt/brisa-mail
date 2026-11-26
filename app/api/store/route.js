import { getDoc, listDocs, setDoc, updateDoc, deleteDoc, validPath } from '../../../lib/store.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/store?doc=a/b         -> { doc }
// GET /api/store?collection=a    -> { docs: [{ id, data }] }
export async function GET(req) {
  const u = new URL(req.url);
  const doc = u.searchParams.get('doc');
  if (doc) return Response.json({ doc: validPath(doc) ? await getDoc(doc) : null });
  const col = u.searchParams.get('collection');
  if (!validPath(col)) return Response.json({ error: 'ruta no válida' }, { status: 400 });
  return Response.json({ docs: await listDocs(col) });
}

// POST /api/store { op: 'set'|'update'|'delete', path, data }
export async function POST(req) {
  const { op, path: p, data } = await req.json().catch(() => ({}));
  if (!validPath(p) || p.split('/').length % 2) return Response.json({ error: 'ruta no válida' }, { status: 400 });
  if (op === 'set') await setDoc(p, data);
  else if (op === 'update') await updateDoc(p, data);
  else if (op === 'delete') await deleteDoc(p);
  else return Response.json({ error: 'operación no válida' }, { status: 400 });
  return Response.json({ ok: true });
}
