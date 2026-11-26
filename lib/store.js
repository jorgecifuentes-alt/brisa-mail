// Almacén de documentos JSON en data/store.json, compartido por la API (/api/store) y por las
// tareas del servidor (lib/jobs.js). Vive en globalThis para que ambas usen la misma copia en memoria.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const FILE = path.join(process.cwd(), 'data', 'store.json');
const g = globalThis.__brisaStore || (globalThis.__brisaStore = { cache: null, writing: Promise.resolve() });

export const validPath = (p) => typeof p === 'string' && /^[A-Za-z0-9_\-.~:@+]+(\/[A-Za-z0-9_\-.~:@+]+)*$/.test(p) && p.length < 1000;
const parentOf = (p) => p.split('/').slice(0, -1).join('/');

async function load() {
  if (g.cache) return g.cache;
  try { g.cache = JSON.parse(await fs.readFile(FILE, 'utf8')); } catch { g.cache = {}; }
  return g.cache;
}
function save() {
  g.writing = g.writing.then(async () => {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.writeFile(FILE + '.tmp', JSON.stringify(g.cache, null, 1));
    await fs.rename(FILE + '.tmp', FILE);
  }).catch(() => {});
  return g.writing;
}
export async function getDoc(p) { const db = await load(); return db[p] ?? null; }
export async function listDocs(col) {
  const db = await load();
  return Object.entries(db).filter(([k]) => parentOf(k) === col).map(([k, v]) => ({ id: k.split('/').pop(), data: v }));
}
export async function setDoc(p, data) { const db = await load(); db[p] = data ?? {}; await save(); }
export async function updateDoc(p, data) { const db = await load(); db[p] = { ...(db[p] || {}), ...(data || {}) }; await save(); }
export async function deleteDoc(p) { const db = await load(); delete db[p]; await save(); }
