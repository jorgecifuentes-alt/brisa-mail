// Brisa · backend de correo sobre IMAP/SMTP.
// Responde con la misma forma que el conector de Gmail (search_threads, get_thread, ...)
// para que la interfaz funcione igual contra cualquier proveedor.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

const env = (k, d) => process.env[k] ?? d;

/* ---------- Conexión única, serializada ---------- */
let client = null;
let connecting = null;
let queue = Promise.resolve();
let boxes = null;

async function getClient() {
  if (client && client.usable) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    const c = new ImapFlow({
      host: env('IMAP_HOST'),
      port: Number(env('IMAP_PORT', 993)),
      secure: env('IMAP_SECURE', 'true') !== 'false',
      auth: { user: env('IMAP_USER'), pass: env('IMAP_PASS') },
      logger: false,
    });
    c.on('error', () => { client = null; });
    c.on('close', () => { client = null; });
    await c.connect();
    client = c;
    boxes = null;
    return c;
  })();
  try { return await connecting; } finally { connecting = null; }
}

// Ejecuta operaciones IMAP una a la vez sobre la misma conexión.
export function withImap(fn) {
  const run = queue.then(async () => fn(await getClient()));
  queue = run.catch(() => {});
  return run;
}

async function mailboxes(c) {
  if (boxes) return boxes;
  const list = await c.list();
  const find = (use, names) =>
    list.find((b) => b.specialUse === use)?.path ||
    list.find((b) => names.some((n) => b.path.toLowerCase() === n.toLowerCase()))?.path ||
    null;
  boxes = {
    inbox: 'INBOX',
    sent: find('\\Sent', ['Sent', 'Enviados', 'Sent Items', '[Gmail]/Sent Mail']),
    trash: find('\\Trash', ['Trash', 'Papelera', 'Deleted Items', '[Gmail]/Trash']),
    archive: find('\\Archive', ['Archive', 'Archivo']) || find('\\All', ['[Gmail]/All Mail', 'All Mail']),
  };
  return boxes;
}

async function inBox(c, path, fn) {
  const lock = await c.getMailboxLock(path);
  try { return await fn(); } finally { lock.release(); }
}

/* ---------- Identificadores ---------- */
// Un "hilo" es un mensaje: { b: carpeta, u: uid, m: Message-ID }.
const encId = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const decId = (s) => { try { return JSON.parse(Buffer.from(String(s), 'base64url').toString()); } catch { return null; } };

async function resolve(c, id) {
  const ref = decId(id);
  if (!ref) throw toolError('Identificador de correo no válido.');
  const bx = await mailboxes(c);
  const tryBox = async (path, uid) => inBox(c, path, async () => {
    if (uid) {
      const msg = await c.fetchOne(uid, { envelope: true }, { uid: true });
      if (msg && (!ref.m || msg.envelope?.messageId === ref.m)) return { box: path, uid };
    }
    if (ref.m) {
      const found = await c.search({ header: { 'message-id': ref.m } }, { uid: true });
      if (found && found.length) return { box: path, uid: found[found.length - 1] };
    }
    return null;
  });
  const order = [ref.b, bx.inbox, bx.archive, bx.trash, bx.sent].filter((p, i, a) => p && a.indexOf(p) === i);
  for (const p of order) {
    try {
      const hit = await tryBox(p, p === ref.b ? ref.u : null);
      if (hit) return hit;
    } catch { /* la carpeta puede no existir */ }
  }
  throw toolError('No se encontró el correo. Puede que lo hayan movido o eliminado.');
}

function toolError(message) { const e = new Error(message); e.code = 'tool_error'; return e; }

/* ---------- Conversión a la forma del conector ---------- */
const addr = (a) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : '');
const isAutomated = (from = '') => /no-?reply|notifica|notification|alert|avisos|mailer-daemon|bounce|updates?@|info@/i.test(from);

function labelsFor(box, bx, flags, headers, fromAddr) {
  const l = [];
  if (box === bx.inbox) l.push('INBOX');
  if (box === bx.sent) l.push('SENT');
  if (box === bx.trash) l.push('TRASH');
  if (!flags.has('\\Seen')) l.push('UNREAD');
  if (flags.has('\\Flagged')) l.push('STARRED');
  const h = headers.toString().toLowerCase();
  if (h.includes('list-unsubscribe') || /precedence:\s*(bulk|list)/.test(h)) l.push('CATEGORY_PROMOTIONS');
  else if (isAutomated(fromAddr)) l.push('CATEGORY_UPDATES');
  else l.push('CATEGORY_PERSONAL');
  return l;
}

async function messageFor(c, box, uid, full) {
  const bx = await mailboxes(c);
  const msg = await c.fetchOne(uid, {
    envelope: true, flags: true, internalDate: true,
    headers: ['list-unsubscribe', 'precedence'],
    source: full ? true : { start: 0, maxLength: 24000 },
  }, { uid: true });
  if (!msg) return null;
  const env = msg.envelope || {};
  const parsed = msg.source ? await simpleParser(msg.source).catch(() => null) : null;
  const text = (parsed?.text || '').trim();
  const from = env.from?.[0];
  const people = [...(env.from || []), ...(env.to || []), ...(env.cc || [])];
  const id = encId({ b: box, u: uid, m: env.messageId || null });
  const date = msg.internalDate || env.date || new Date();
  const out = {
    id, threadId: id,
    sender: addr(from),
    toRecipients: (env.to || []).map((a) => a.address),
    ccRecipients: (env.cc || []).map((a) => a.address),
    addressDisplayNames: people.filter((a) => a.name).map((a) => ({ displayName: a.name, emailAddress: a.address })),
    subject: env.subject || '',
    snippet: text.replace(/\s+/g, ' ').slice(0, 180),
    date: new Date(date).toISOString(),
    internalDate: String(new Date(date).getTime()),
    labelIds: labelsFor(box, bx, msg.flags || new Set(), msg.headers || '', from?.address || ''),
    messageIdHeader: env.messageId || null,
  };
  if (full) {
    out.plaintextBody = text.slice(0, 100000);
    out.attachments = (parsed?.attachments || []).map((a) => ({ filename: a.filename || 'adjunto', mimeType: a.contentType, size: a.size }));
  }
  return out;
}

/* ---------- Herramientas ---------- */
function parseQuery(q = '') {
  q = q.trim();
  if (q === 'in:inbox') return { box: 'inbox', criteria: { all: true } };
  if (q === 'is:starred') return { box: 'inbox', criteria: { flagged: true }, also: 'archive' };
  if (q === 'in:sent') return { box: 'sent', criteria: { all: true } };
  if (q === 'in:trash') return { box: 'trash', criteria: { all: true } };
  if (q.startsWith('-in:inbox')) {
    const d = /newer_than:(\d+)d/.exec(q);
    const since = new Date(Date.now() - (d ? Number(d[1]) : 60) * 86400000);
    return { box: 'archive', criteria: { since } };
  }
  const term = q.replace(/\b(in|is|label|category):\S+/g, '').trim();
  return { box: 'inbox', also: 'archive', criteria: term ? { or: [{ subject: term }, { from: term }, { body: term }] } : { all: true } };
}

export const tools = {
  async search_threads({ query, pageSize = 20 }) {
    const size = Math.min(Number(pageSize) || 20, 50);
    return withImap(async (c) => {
      const bx = await mailboxes(c);
      const { box, criteria, also } = parseQuery(query);
      const paths = [bx[box], also && bx[also]].filter(Boolean);
      const hits = [];
      for (const p of paths) {
        await inBox(c, p, async () => {
          const uids = (await c.search(criteria, { uid: true })) || [];
          for (const u of uids.slice(-size)) hits.push({ p, u });
        });
      }
      // Los UID crecen con la llegada: los más altos son los más recientes en cada carpeta.
      const picked = hits.slice(-size * paths.length).reverse().slice(0, size);
      const threads = [];
      for (const h of picked) {
        const env = await inBox(c, h.p, () => c.fetchOne(h.u, { envelope: true }, { uid: true }));
        if (env) threads.push({ id: encId({ b: h.p, u: h.u, m: env.envelope?.messageId || null }) });
      }
      return { threads, resultCountEstimate: String(hits.length) };
    });
  },

  async get_thread({ threadId, messageFormat = 'PLAIN_TEXT' }) {
    const full = messageFormat === 'PLAIN_TEXT' || messageFormat === 'FULL_CONTENT';
    return withImap(async (c) => {
      const { box, uid } = await resolve(c, threadId);
      const m = await inBox(c, box, () => messageFor(c, box, uid, full));
      if (!m) throw toolError('No se encontró el correo.');
      return { id: m.id, messageCount: 1, messages: [m] };
    });
  },

  async label_thread({ threadId, labelIds = [] }) { return changeLabels(threadId, labelIds, true); },
  async unlabel_thread({ threadId, labelIds = [] }) { return changeLabels(threadId, labelIds, false); },

  async trash_thread({ threadId }) {
    return withImap(async (c) => {
      const bx = await mailboxes(c);
      const { box, uid } = await resolve(c, threadId);
      if (!bx.trash) throw toolError('Tu servidor no tiene carpeta de papelera.');
      if (box !== bx.trash) await inBox(c, box, () => c.messageMove(String(uid), bx.trash, { uid: true }));
      return { id: threadId };
    });
  },

  async untrash_thread({ threadId }) {
    return withImap(async (c) => {
      const bx = await mailboxes(c);
      const { box, uid } = await resolve(c, threadId);
      if (box === bx.trash) await inBox(c, box, () => c.messageMove(String(uid), bx.archive || bx.inbox, { uid: true }));
      return { id: threadId };
    });
  },

  async send_message({ to = [], cc = [], bcc = [], subject = '', body = '', htmlBody }) {
    if (!to.length) throw toolError('Falta el destinatario.');
    const info = await sendAndSave({ from: env('MAIL_FROM', env('SMTP_USER')), to, cc, bcc, subject, text: body, html: htmlBody });
    return { id: info.messageId };
  },

  async reply({ messageId, body = '', replyAll = false }) {
    const orig = await withImap(async (c) => {
      const { box, uid } = await resolve(c, messageId);
      return inBox(c, box, () => c.fetchOne(uid, { envelope: true, headers: ['references', 'reply-to'] }, { uid: true }));
    });
    const e = orig.envelope || {};
    const me = String(env('MAIL_FROM', env('SMTP_USER'))).toLowerCase();
    const target = (e.replyTo?.length ? e.replyTo : e.from || []).map((a) => a.address);
    const cc = replyAll ? [...(e.to || []), ...(e.cc || [])].map((a) => a.address).filter((a) => a && !me.includes(a.toLowerCase())) : [];
    const refsHeader = orig.headers ? orig.headers.toString().match(/references:\s*([^\r\n]+(?:\r?\n\s+[^\r\n]+)*)/i)?.[1] : '';
    const references = [refsHeader, e.messageId].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const subject = /^re:/i.test(e.subject || '') ? e.subject : `Re: ${e.subject || ''}`;
    const info = await sendAndSave({
      from: env('MAIL_FROM', env('SMTP_USER')), to: target, cc, subject, text: body,
      inReplyTo: e.messageId, references,
    });
    return { id: info.messageId };
  },
};

async function changeLabels(threadId, labelIds, add) {
  return withImap(async (c) => {
    const bx = await mailboxes(c);
    let { box, uid } = await resolve(c, threadId);
    for (const l of labelIds) {
      if (l === 'STARRED') await inBox(c, box, () => (add ? c.messageFlagsAdd : c.messageFlagsRemove).call(c, String(uid), ['\\Flagged'], { uid: true }));
      else if (l === 'UNREAD') await inBox(c, box, () => (add ? c.messageFlagsRemove : c.messageFlagsAdd).call(c, String(uid), ['\\Seen'], { uid: true }));
      else if (l === 'INBOX') {
        const dest = add ? bx.inbox : bx.archive;
        if (!dest) throw toolError('Tu servidor no tiene carpeta de archivo.');
        if (box !== dest) await inBox(c, box, () => c.messageMove(String(uid), dest, { uid: true }));
      }
    }
    return { id: threadId };
  });
}

let smtp = null;
function transport() {
  if (!smtp) {
    smtp = nodemailer.createTransport({
      host: env('SMTP_HOST'),
      port: Number(env('SMTP_PORT', 465)),
      secure: env('SMTP_SECURE', 'true') !== 'false',
      auth: { user: env('SMTP_USER'), pass: env('SMTP_PASS') },
    });
  }
  return smtp;
}

// Algunos servidores (Gmail) guardan solos lo enviado; otros no. Actívalo con SAVE_SENT=true.
async function sendAndSave(opts) {
  const info = await transport().sendMail(opts);
  if (env('SAVE_SENT') === 'true') {
    try {
      const raw = await new MailComposer({ ...opts, messageId: info.messageId }).compile().build();
      await withImap(async (c) => {
        const bx = await mailboxes(c);
        if (bx.sent) await c.append(bx.sent, raw, ['\\Seen']);
      });
    } catch { /* no bloquear el envío por esto */ }
  }
  return info;
}
