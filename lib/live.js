// Brisa · correo en vivo.
// Mantiene una conexión IMAP aparte en modo IDLE sobre INBOX: el servidor de correo avisa en el
// momento en que llega un mensaje. Ese aviso se reenvía a las páginas abiertas (Server-Sent Events)
// y como notificación push a los dispositivos suscritos (aunque la app esté cerrada).
import { ImapFlow } from 'imapflow';
import * as webpush from 'web-push';
import { invalidateScan, mailPass, encId } from './mail.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const env = (k, d) => process.env[k] ?? d;
const DATA = path.join(process.cwd(), 'data');
const g = globalThis.__brisaLive || (globalThis.__brisaLive = { started: false, listeners: new Set(), client: null, vapid: null });

/* ---------- Suscriptores en vivo (SSE) ---------- */
export function subscribe(fn) { g.listeners.add(fn); ensureStarted(); return () => g.listeners.delete(fn); }
function broadcast(ev) { for (const fn of g.listeners) { try { fn(ev); } catch { /* conexión cerrada */ } } }

/* ---------- IDLE ---------- */
export function ensureStarted() {
  if (g.started || !env('IMAP_HOST')) return;
  g.started = true;
  connect(1000);
}

async function connect(delay) {
  const c = new ImapFlow({
    host: env('IMAP_HOST'),
    port: Number(env('IMAP_PORT', 993)),
    secure: env('IMAP_SECURE', 'true') !== 'false',
    auth: { user: String(env('IMAP_USER', '')).trim(), pass: mailPass('IMAP_PASS', 'IMAP_HOST') },
    logger: false,
    maxIdleTime: 5 * 60 * 1000, // renueva el IDLE cada 5 min para que el servidor no lo corte
    disableAutoIdle: true,      // el IDLE lo maneja idleLoop: empieza de inmediato y se retoma tras cada interrupción
  });
  let retry = () => {
    retry = () => {};
    g.client = null;
    const next = Math.min(delay * 2, 60000);
    setTimeout(() => connect(next), delay);
  };
  c.on('error', () => retry());
  c.on('close', () => retry());
  c.on('exists', async (info) => {
    if (info.path !== 'INBOX' || info.count <= info.prevCount) return;
    let from = '', subject = '', id = '';
    try {
      const gm = !!(c.capabilities && c.capabilities.has('X-GM-EXT-1'));
      const msg = await c.fetchOne('*', { envelope: true, uid: true, ...(gm ? { threadId: true } : {}) });
      const f = msg?.envelope?.from?.[0];
      from = f ? f.name || f.address : '';
      subject = msg?.envelope?.subject || '';
      // Identificador del hilo, el mismo que usa la app: permite "Marcar como leído" y "Archivar" desde la notificación.
      if (gm && msg?.threadId) id = encId({ g: String(msg.threadId) });
      else if (msg?.uid) id = encId({ b: 'INBOX', u: msg.uid, m: msg.envelope?.messageId || null });
    } catch { /* el aviso igual se envía */ }
    invalidateScan();
    const ev = { type: 'mail', from, subject, id, at: Date.now() };
    broadcast(ev);
    notifyPush(ev);
  });
  try {
    await c.connect();
    await c.mailboxOpen('INBOX');
    g.client = c;
    delay = 1000;
    broadcast({ type: 'live', ok: true });
    idleLoop(c);
  } catch (e) {
    console.error('[live] no se pudo conectar:', e?.message);
    retry();
  }
}

// idle() termina cuando otro comando (p. ej. leer el sobre de un correo nuevo) lo interrumpe: se retoma al tiro.
async function idleLoop(c) {
  while (c.usable) {
    try { await c.idle(); } catch { break; }
  }
}

/* ---------- Acciones desde la notificación ----------
 * La notificación lleva un token firmado para su hilo: así el teléfono puede marcarlo como leído o
 * archivarlo sin abrir la app (y sin enviar la contraseña de Brisa). Solo sirve para ese hilo. */
async function actionSecret() { return process.env.APP_PASSWORD || (await vapid()).privateKey; }
export async function actionToken(id) { return createHmac('sha256', await actionSecret()).update('brisa-action:' + id).digest('base64url'); }
export async function checkActionToken(id, tok) {
  if (!id || !tok) return false;
  const a = Buffer.from(await actionToken(id)), b = Buffer.from(String(tok));
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ---------- Push ---------- */
async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(path.join(DATA, file), 'utf8')); } catch { return fallback; } }
async function writeJson(file, data) { await fs.mkdir(DATA, { recursive: true }); await fs.writeFile(path.join(DATA, file), JSON.stringify(data, null, 1)); }

export async function vapid() {
  if (g.vapid) return g.vapid;
  let keys = env('VAPID_PUBLIC_KEY') && env('VAPID_PRIVATE_KEY')
    ? { publicKey: env('VAPID_PUBLIC_KEY'), privateKey: env('VAPID_PRIVATE_KEY') }
    : await readJson('vapid.json', null);
  if (!keys) { keys = webpush.generateVAPIDKeys(); await writeJson('vapid.json', keys); }
  webpush.setVapidDetails(env('VAPID_SUBJECT', 'mailto:admin@localhost'), keys.publicKey, keys.privateKey);
  g.vapid = keys;
  return keys;
}

export async function addSubscription(sub) {
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint)) throw new Error('Suscripción no válida.');
  const subs = await readJson('push.json', []);
  if (!subs.some((s) => s.endpoint === sub.endpoint)) subs.push({ endpoint: sub.endpoint, keys: sub.keys });
  await writeJson('push.json', subs);
}

// Notificación push genérica (la usan las tareas del servidor: pospuestos, programados, seguimiento, resumen).
export async function pushNotify({ title, body = '', tag = 'brisa', url = '/index.html' }) {
  const subs = await readJson('push.json', []);
  if (!subs.length) return;
  await vapid();
  const payload = JSON.stringify({ title, body, tag, url });
  const keep = [];
  await Promise.all(subs.map(async (s) => {
    try { await webpush.sendNotification(s, payload, { TTL: 3600, urgency: 'high' }); keep.push(s); }
    catch (e) { if (e?.statusCode !== 404 && e?.statusCode !== 410) keep.push(s); }
  }));
  if (keep.length !== subs.length) await writeJson('push.json', keep);
}

async function notifyPush(ev) {
  const subs = await readJson('push.json', []);
  if (!subs.length) return;
  await vapid();
  // Una notificación por correo (etiqueta propia): así el ícono del teléfono muestra cuántos llegaron.
  const payload = JSON.stringify({ title: ev.from || 'Correo nuevo', body: ev.subject || '', tag: 'mail-' + (ev.id || ev.at), url: '/index.html', id: ev.id || '', tok: ev.id ? await actionToken(ev.id) : '' });
  const keep = [];
  await Promise.all(subs.map(async (s) => {
    try { await webpush.sendNotification(s, payload, { TTL: 3600, urgency: 'high' }); keep.push(s); }
    catch (e) { if (e?.statusCode !== 404 && e?.statusCode !== 410) keep.push(s); } // 404/410: suscripción vencida
  }));
  if (keep.length !== subs.length) await writeJson('push.json', keep);
}
