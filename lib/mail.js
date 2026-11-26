// Brisa · backend de correo sobre IMAP/SMTP.
// Responde con la misma forma que el conector de Gmail (search_threads, get_thread, ...)
// para que la interfaz funcione igual contra cualquier proveedor.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

const env = (k, d) => process.env[k] ?? d;
// Las contraseñas de aplicación de Google son 16 letras sin espacios, aunque Google las muestre en
// grupos de 4: con un servidor de Google se quitan los espacios para que copiarlas tal cual funcione.
export function mailPass(passKey, hostKey) {
  const pass = String(env(passKey, ''));
  return /(^|\.)(gmail|google(mail)?)\.com$/i.test(String(env(hostKey, '')).trim()) ? pass.replace(/\s+/g, '') : pass;
}

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
      auth: { user: String(env('IMAP_USER', '')).trim(), pass: mailPass('IMAP_PASS', 'IMAP_HOST') },
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
  if (flags.has('$Important') || flags.has('Important')) l.push('IMPORTANT');
  const h = headers.toString().toLowerCase();
  if (h.includes('list-unsubscribe') || /precedence:\s*(bulk|list)/.test(h)) l.push('CATEGORY_PROMOTIONS');
  else if (isAutomated(fromAddr)) l.push('CATEGORY_UPDATES');
  else l.push('CATEGORY_PERSONAL');
  return l;
}

function attachmentNames(node, out = []) {
  if (!node) return out;
  const name = node.dispositionParameters?.filename || node.parameters?.name;
  if (node.disposition === 'attachment' || (name && node.disposition !== 'inline')) out.push(name || 'adjunto');
  (node.childNodes || []).forEach((n) => attachmentNames(n, out));
  return out;
}

async function messageFor(c, box, uid, full) {
  const bx = await mailboxes(c);
  const msg = await c.fetchOne(uid, {
    envelope: true, flags: true, internalDate: true,
    headers: ['list-unsubscribe', 'precedence'],
    bodyStructure: true,
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
  // Nombres de adjuntos desde la estructura del mensaje (sin descargar los archivos): la lista muestra el clip.
  out.attachmentIds = attachmentNames(msg.bodyStructure);
  if (full) {
    out.plaintextBody = text.slice(0, 100000);
    out.attachments = (parsed?.attachments || []).map((a) => ({ filename: a.filename || 'adjunto', mimeType: a.contentType, size: a.size }));
  }
  return out;
}

/* ---------- Herramientas ---------- */
/* ---------- Búsqueda estilo Gmail sobre IMAP ----------
 * Se leen los sobres de los últimos SCAN mensajes de cada carpeta (en caché unos segundos) y se
 * filtran con una consulta como las de Gmail: in:, is:, category:, from:, newer_than:, -negación,
 * OR, ( ) y { } (grupo OR). Así cada sección de la bandeja inteligente tiene su lista y su total. */
const SCAN = Number(env('IMAP_SCAN', 600));
const scanCache = new Map();
export function invalidateScan() { scanCache.clear(); }

async function scanBox(c, path, bx) {
  const hit = scanCache.get(path);
  if (hit && Date.now() - hit.at < 20000) return hit.items;
  const items = await inBox(c, path, async () => {
    const exists = c.mailbox?.exists || 0;
    if (!exists) return [];
    const from = Math.max(1, exists - SCAN + 1);
    const out = [];
    for await (const msg of c.fetch(`${from}:*`, { uid: true, envelope: true, flags: true, internalDate: true, headers: ['list-unsubscribe', 'precedence'] })) {
      const e = msg.envelope || {};
      const f = e.from?.[0];
      const fromText = `${f?.name || ''} ${f?.address || ''}`.toLowerCase();
      out.push({
        box: path, uid: msg.uid, mid: e.messageId || null,
        t: new Date(msg.internalDate || e.date || 0).getTime(),
        labels: new Set(labelsFor(path, bx, msg.flags || new Set(), msg.headers || '', f?.address || '')),
        from: fromText, subject: String(e.subject || '').toLowerCase(),
      });
    }
    return out;
  });
  scanCache.set(path, { at: Date.now(), items });
  return items;
}

function tokenize(q) {
  const out = []; const re = /\s*(-|\(|\)|\{|\}|"[^"]*"|[^\s(){}]+)/y; let m;
  while ((m = re.exec(q))) out.push(m[1]);
  return out;
}
// Devuelve una función (msg) => boolean.
function compile(q) {
  const t = tokenize(String(q || '')); let i = 0;
  const peek = () => t[i];
  const orExpr = (key) => {
    const parts = [andExpr(key)];
    while (peek() === 'OR') { i++; parts.push(andExpr(key)); }
    return (m) => parts.some((p) => p(m));
  };
  const andExpr = (key) => {
    const parts = [];
    while (i < t.length && peek() !== ')' && peek() !== '}' && peek() !== 'OR') parts.push(unary(key));
    return (m) => parts.every((p) => p(m));
  };
  const unary = (key) => {
    if (peek() === '-') { i++; const u = unary(key); return (m) => !u(m); }
    return primary(key);
  };
  const primary = (key) => {
    const tok = t[i++];
    if (tok === '(') { const e = orExpr(key); if (peek() === ')') i++; return e; }
    if (tok === '{') { const parts = []; while (i < t.length && peek() !== '}') parts.push(unary(key)); i++; return (m) => parts.some((p) => p(m)); }
    const kv = /^([a-z_]+):(.*)$/i.exec(tok);
    if (kv && !key) {
      const k = kv[1].toLowerCase();
      if (kv[2] === '' && peek() === '(') { i++; const e = orExpr(k); if (peek() === ')') i++; return e; }
      return term(k, kv[2]);
    }
    return term(key, tok);
  };
  const term = (k, v) => {
    v = String(v || '').replace(/^"|"$/g, '').toLowerCase();
    switch (k) {
      case 'in': return (m) => ({ inbox: m.labels.has('INBOX'), sent: m.labels.has('SENT'), trash: m.labels.has('TRASH'), archive: !m.labels.has('INBOX') && !m.labels.has('SENT') && !m.labels.has('TRASH'), anywhere: true }[v] ?? false);
      case 'is': return (m) => ({ unread: m.labels.has('UNREAD'), read: !m.labels.has('UNREAD'), starred: m.labels.has('STARRED'), important: m.labels.has('IMPORTANT') }[v] ?? false);
      case 'category': return (m) => ({ primary: m.labels.has('CATEGORY_PERSONAL'), updates: m.labels.has('CATEGORY_UPDATES'), promotions: m.labels.has('CATEGORY_PROMOTIONS'), social: false, forums: false }[v] ?? false);
      case 'from': return (m) => m.from.includes(v);
      case 'subject': return (m) => m.subject.includes(v);
      case 'newer_than': { const n = parseInt(v, 10) || 0; const unit = v.endsWith('y') ? 365 : v.endsWith('m') ? 30 : 1; return (m) => m.t >= Date.now() - n * unit * 86400000; }
      case 'older_than': { const n = parseInt(v, 10) || 0; const unit = v.endsWith('y') ? 365 : v.endsWith('m') ? 30 : 1; return (m) => m.t < Date.now() - n * unit * 86400000; }
      default: return (m) => !v || m.subject.includes(v) || m.from.includes(v);
    }
  };
  return orExpr(null);
}
function boxesFor(q, bx) {
  const s = String(q || '');
  // Solo cuentan los "in:" en positivo: "-in:trash" excluye la papelera, no la busca.
  if (/(^|[\s({])in:sent\b/.test(s)) return [bx.sent];
  if (/(^|[\s({])in:trash\b/.test(s)) return [bx.trash];
  if (/(^|[\s({])in:inbox\b/.test(s)) return [bx.inbox];
  return [bx.inbox, bx.archive];
}

export const tools = {
  async search_threads({ query, pageSize = 20, pageToken }) {
    const size = Math.min(Math.max(Number(pageSize) || 20, 1), 50);
    const offset = Math.max(0, parseInt(pageToken, 10) || 0);
    return withImap(async (c) => {
      const bx = await mailboxes(c);
      const match = compile(query);
      const all = [];
      for (const p of boxesFor(query, bx).filter(Boolean)) {
        try { all.push(...await scanBox(c, p, bx)); } catch { /* carpeta inexistente */ }
      }
      const hits = all.filter(match).sort((a, b) => b.t - a.t);
      const page = hits.slice(offset, offset + size);
      return {
        threads: page.map((h) => ({ id: encId({ b: h.box, u: h.uid, m: h.mid }) })),
        resultCountEstimate: String(hits.length),
        ...(offset + size < hits.length ? { nextPageToken: String(offset + size) } : {}),
      };
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
    invalidateScan();
    return withImap(async (c) => {
      const bx = await mailboxes(c);
      const { box, uid } = await resolve(c, threadId);
      if (!bx.trash) throw toolError('Tu servidor no tiene carpeta de papelera.');
      if (box !== bx.trash) await inBox(c, box, () => c.messageMove(String(uid), bx.trash, { uid: true }));
      return { id: threadId };
    });
  },

  async untrash_thread({ threadId }) {
    invalidateScan();
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
  invalidateScan();
  return withImap(async (c) => {
    const bx = await mailboxes(c);
    let { box, uid } = await resolve(c, threadId);
    for (const l of labelIds) {
      if (l === 'IMPORTANT') await inBox(c, box, () => (add ? c.messageFlagsAdd : c.messageFlagsRemove).call(c, String(uid), ['$Important'], { uid: true }));
      else if (l === 'STARRED') await inBox(c, box, () => (add ? c.messageFlagsAdd : c.messageFlagsRemove).call(c, String(uid), ['\\Flagged'], { uid: true }));
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
      auth: { user: String(env('SMTP_USER', '')).trim(), pass: mailPass('SMTP_PASS', 'SMTP_HOST') },
    });
  }
  return smtp;
}

// Algunos servidores (Gmail) guardan solos lo enviado; otros no. Actívalo con SAVE_SENT=true.
async function sendAndSave(opts) {
  invalidateScan();
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
