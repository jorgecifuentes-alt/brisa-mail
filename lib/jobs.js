// Brisa · tareas del servidor. Corren cada minuto aunque nadie tenga la app abierta:
//  - Pospuestos: a su hora vuelven a la bandeja como no leídos.
//  - Programados: se envían a su hora (se sacan de la lista antes de enviar: nunca salen dos veces).
//  - Seguimiento: si a la fecha límite nadie respondió, avisa.
//  - Resumen de la mañana: una notificación diaria con lo pendiente.
// Cada tipo vive en su propia colección (no en el documento de preferencias), así la app y el servidor
// no se pisan al guardar.
import { getDoc, setDoc, deleteDoc, listDocs } from './store.js';
import { tools } from './mail.js';
import { pushNotify } from './live.js';

const PREFS = 'data/users/local/prefs';
export const COL = { scheduled: `${PREFS}/scheduled`, followups: `${PREFS}/followups`, snoozes: `${PREFS}/snz`, state: `${PREFS}/jobs/state` };
const g = globalThis.__brisaJobs || (globalThis.__brisaJobs = { timer: null, running: false });

export function startJobs() {
  if (g.timer || !process.env.IMAP_HOST) return;
  g.timer = setInterval(tick, 60 * 1000);
  setTimeout(tick, 15 * 1000);
}

async function tick() {
  if (g.running) return;
  g.running = true;
  try {
    await runSnoozes();
    await runScheduled();
    await runFollowups();
    await runDigest();
  } catch (e) { console.error('[tareas]', e?.message || e); }
  finally { g.running = false; }
}

async function runSnoozes() {
  for (const { id, data } of await listDocs(COL.snoozes)) {
    if (!data || data.until > Date.now()) continue;
    await deleteDoc(`${COL.snoozes}/${id}`);
    try {
      await tools.label_thread({ threadId: data.threadId || id, labelIds: ['INBOX', 'UNREAD'] });
      await pushNotify({ title: 'Volvió a tu bandeja', body: `${data.fromName ? data.fromName + ': ' : ''}${data.subject || ''}`, tag: 'brisa-snooze' });
    } catch (e) { console.error('[tareas] pospuesto', e?.message); }
  }
}

async function runScheduled() {
  for (const { id, data } of await listDocs(COL.scheduled)) {
    if (!data || data.at > Date.now()) continue;
    await deleteDoc(`${COL.scheduled}/${id}`); // primero se saca de la lista: un error no lo duplica
    try {
      if (data.replyTo) await tools.reply({ messageId: data.replyTo, body: data.body || '' });
      else await tools.send_message({ to: data.to || [], cc: data.cc || [], subject: data.subject || '', body: data.body || '' });
      await pushNotify({ title: 'Correo enviado', body: data.subject || '', tag: 'brisa-sent' });
      if (data.followDays) await setDoc(`${COL.followups}/${id}`, followupFor(data, Date.now()));
    } catch (e) {
      console.error('[tareas] programado', e?.message);
      await setDoc(`${COL.scheduled}/${id}`, { ...data, at: Date.now() + 15 * 60 * 1000, error: String(e?.message || e) });
      await pushNotify({ title: 'No se pudo enviar', body: `${data.subject || ''}. Se reintenta en 15 minutos.`, tag: 'brisa-sent' });
    }
  }
}
export function followupFor(d, sentAt) {
  const to = String((d.to && d.to[0]) || d.toEmail || '').toLowerCase();
  return { to, toName: d.toName || to, subject: d.subject || '', sentAt, due: sentAt + (Number(d.followDays) || 2) * 86400000, state: 'waiting', checkedAt: 0 };
}

async function hasReply(f) {
  const core = String(f.subject || '').replace(/^(\s*(re|rv|fw|fwd)\s*:\s*)+/i, '').replace(/"/g, '').slice(0, 60).trim();
  const res = await tools.search_threads({ query: `from:${f.to}${core ? ` subject:"${core}"` : ''}`, pageSize: 5 });
  for (const t of (res && res.threads) || []) {
    const th = await tools.get_thread({ threadId: t.id, messageFormat: 'MINIMAL' });
    if ((th.messages || []).some((m) => String(m.sender || '').toLowerCase().includes(f.to) && Number(m.internalDate) > f.sentAt)) return true;
  }
  return false;
}
async function runFollowups() {
  const now = Date.now();
  for (const { id, data: f } of await listDocs(COL.followups)) {
    if (!f || f.state !== 'waiting' || !f.to) continue;
    if (now - (f.checkedAt || 0) < 10 * 60 * 1000 && f.due > now) continue;
    let replied = false;
    try { replied = await hasReply(f); } catch (e) { console.error('[tareas] seguimiento', e?.message); continue; }
    if (replied) { await deleteDoc(`${COL.followups}/${id}`); continue; }
    if (f.due <= now) {
      await setDoc(`${COL.followups}/${id}`, { ...f, state: 'due', checkedAt: now });
      await pushNotify({ title: 'Sin respuesta', body: `${f.toName || f.to}: ${f.subject}`, tag: 'brisa-follow' });
    } else await setDoc(`${COL.followups}/${id}`, { ...f, checkedAt: now });
  }
}

function localNow(tz) {
  let parts;
  try { parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()); }
  catch { return localNow('America/Santiago'); }
  const v = (t) => parts.find((p) => p.type === t).value;
  return { day: `${v('year')}-${v('month')}-${v('day')}`, hm: `${v('hour').replace(/^24/, '00')}:${v('minute')}` };
}
async function runDigest() {
  const prefs = (await getDoc(PREFS)) || {};
  const dg = prefs.digest;
  if (!dg || !dg.on) return;
  const { day, hm } = localNow(prefs.tz || 'America/Santiago');
  const state = (await getDoc(COL.state)) || {};
  if (hm < (dg.time || '08:00') || state.digestDay === day) return;
  await setDoc(COL.state, { ...state, digestDay: day });
  const count = async (q) => Number((await tools.search_threads({ query: q, pageSize: 1 }))?.resultCountEstimate) || 0;
  // Prioridad = remitentes marcados con ⚡ + personas prioritarias por nombre (igual que en la app).
  const ps = (prefs.prioSenders || []).slice(0, 20);
  const fold = (t) => String(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const names = Array.isArray(prefs.prioNames) ? prefs.prioNames : ['Alexis Rojas', 'Viviana Molina', 'José Moscoso'];
  const nq = names.slice(0, 20).map((n) => String(n).toLowerCase().split(/[\s,;.]+/).filter((w) => w.length > 1).map((w) => { const f = fold(w).replace(/[^a-z0-9ñ]/g, ''); return f && f !== w ? `{from:${f} from:${w}}` : `from:${f || w}`; }).join(' ')).filter(Boolean).map((x) => `(${x})`);
  const any = (prefs.prioImportant === false ? [] : ['is:important']).concat(ps.map((e) => 'from:' + e), nq);
  const [unread, prio] = await Promise.all([
    count('in:inbox is:unread'),
    any.length ? count(`in:inbox is:unread {${any.join(' ')}}`) : 0,
  ]);
  const waiting = (await listDocs(COL.followups)).filter((d) => d.data && d.data.state === 'due').length;
  const parts = [`${unread} sin leer`, `${prio} de prioridad`];
  if (waiting) parts.push(`${waiting} ${waiting === 1 ? 'espera' : 'esperan'} respuesta`);
  await pushNotify({ title: 'Buenos días ☀️', body: parts.join(' · '), tag: 'brisa-digest' });
}
