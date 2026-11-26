// Brisa · adaptador local.
// La interfaz (public/index.html) es la misma que la versión publicada en claude.ai y pide sus
// capacidades con `claude.use(nombre)`. Aquí cada una se implementa contra este servidor:
//   mcp        -> /api/gmail/<herramienta>   (IMAP/SMTP con la forma del conector de Gmail)
//   sample     -> /api/ai                    (Claude por la API de Anthropic, en streaming)
//   dictation  -> Web Speech API del navegador (no se graba ni se guarda audio)
//   db, user   -> /api/store                 (archivo JSON local, un solo usuario)
//   desktop    -> instalación como app (PWA) y contador en el ícono
(function () {
  const err = (code, message, extra) => Object.assign(new Error(message), { code, message }, extra || {});

  /* ---------- mcp ---------- */
  let freshUntil = 0;
  const mcp = Object.freeze({
    async callTool(server, tool, input, opts) {
      if (server !== 'Gmail') throw err('server_not_connected', 'Servidor desconocido.');
      let r;
      try {
        const fresh = !!(opts && opts.cache && opts.cache.refresh) || freshUntil > Date.now();
        r = await fetch('/api/gmail/' + encodeURIComponent(tool), { method: 'POST', headers: { 'content-type': 'application/json', ...(fresh ? { 'x-brisa-fresh': '1' } : {}) }, body: JSON.stringify(input || {}) });
      } catch (e) { throw err('server_unavailable', 'Sin conexión con el servidor.', { retryable: true }); }
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) throw err((j.error && j.error.code) || 'upstream_error', (j.error && j.error.message) || 'Error del servidor.');
      return { content: [], payload: j.payload };
    },
    // Tras invalidar, las próximas lecturas (unos segundos) piden datos frescos al servidor.
    async invalidate() { freshUntil = Date.now() + 4000; },
    // Vigila una lectura: la repite al instante cuando el servidor avisa de correo nuevo (IMAP IDLE
    // por SSE) y, como respaldo, cada `refetchInterval` (mínimo 60 s).
    watchTool(server, tool, input, handler, opts) {
      let stopped = false;
      const run = () => mcp.callTool(server, tool, input).then((r) => { if (!stopped) handler({ type: 'data', result: r }); }, (e) => { if (!stopped) handler({ type: 'error', error: e }); });
      run();
      const off = onLive(() => run());
      const t = setInterval(run, Math.max(60000, (opts && opts.refetchInterval) || 60000));
      return () => { stopped = true; off(); clearInterval(t); };
    },
    async listTools() { return { servers: [{ server: 'Gmail', authStatus: 'connected', tools: [] }] }; },
  });

  /* ---------- correo en vivo (SSE) ---------- */
  const liveSubs = new Set();
  let es = null;
  function onLive(fn) {
    liveSubs.add(fn);
    if (!es && window.EventSource) {
      es = new EventSource('/api/events');
      es.addEventListener('mail', (ev) => { let d = {}; try { d = JSON.parse(ev.data); } catch (e) {} liveSubs.forEach((f) => f(d)); });
    }
    return () => { liveSubs.delete(fn); if (!liveSubs.size && es) { es.close(); es = null; } };
  }

  /* ---------- sample ---------- */
  // Sin herramientas: texto en streaming desde /api/ai.
  // Con herramientas: bucle de turnos contra /api/ai/tools, ejecutando cada herramienta aquí, en la página.
  async function sample(input, opts) {
    opts = opts || {};
    if (opts.tools && opts.tools.length) return sampleWithTools(input, opts);
    const prompt = typeof input === 'string' ? input : (input || []).map((m) => m.content).join('\n\n');
    let r;
    try {
      r = await fetch('/api/ai', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, modelTier: opts.modelTier }), signal: opts.signal });
    } catch (e) { throw err(e && e.name === 'AbortError' ? 'cancelled' : 'upstream_error', 'No se pudo contactar a Claude.'); }
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw err((j.error && j.error.code) || (r.status === 429 ? 'rate_limited' : 'upstream_error'), (j.error && j.error.message) || 'Claude no respondió.');
    }
    const reader = r.body.getReader(), dec = new TextDecoder();
    let text = '';
    for (;;) {
      let chunk;
      try { chunk = await reader.read(); } catch (e) { throw err(e && e.name === 'AbortError' ? 'cancelled' : 'upstream_error', 'Se cortó la respuesta.', { text }); }
      if (chunk.done) break;
      const delta = dec.decode(chunk.value, { stream: true });
      text += delta;
      if (opts.onText) opts.onText({ text, delta });
    }
    return { text, truncated: false, modelTierApplied: opts.modelTier || 'default' };
  }

  async function sampleWithTools(input, opts) {
    const msgs = typeof input === 'string' ? [{ role: 'user', content: input }] : (input || []).map((m) => ({ role: m.role, content: m.content }));
    const byName = Object.fromEntries(opts.tools.map((t) => [t.name, t]));
    const defs = opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema || { type: 'object', properties: {} } }));
    const signal = opts.signal || new AbortController().signal;
    let text = '';
    for (let round = 0; round < 8; round++) {
      if (signal.aborted) throw err('cancelled', 'Detenido.', { text });
      let r;
      try {
        r = await fetch('/api/ai/tools', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: msgs, tools: defs, modelTier: opts.modelTier }), signal });
      } catch (e) { throw err(e && e.name === 'AbortError' ? 'cancelled' : 'upstream_error', 'No se pudo contactar a Claude.', { text }); }
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) throw err((j.error && j.error.code) || 'upstream_error', (j.error && j.error.message) || 'Claude no respondió.', { text });
      const content = j.content || [];
      const said = content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (said) { text += (text ? '\n\n' : '') + said; if (opts.onText) opts.onText({ text, delta: said }); }
      msgs.push({ role: 'assistant', content });
      const uses = content.filter((b) => b.type === 'tool_use');
      if (j.stop_reason !== 'tool_use' || !uses.length) break;
      const results = await Promise.all(uses.map(async (u) => {
        const tool = byName[u.name];
        try {
          if (!tool) throw new Error('Herramienta desconocida.');
          const out = await tool.execute(u.input || {}, { signal });
          const str = typeof out === 'string' ? out : JSON.stringify(out == null ? null : out);
          return { type: 'tool_result', tool_use_id: u.id, content: str.slice(0, 32000) };
        } catch (e) {
          return { type: 'tool_result', tool_use_id: u.id, content: 'Error: ' + ((e && e.message) || e), is_error: true };
        }
      }));
      msgs.push({ role: 'user', content: results });
    }
    return { text, truncated: false, modelTierApplied: opts.modelTier || 'default' };
  }
  sample.limits = async () => ({ maxPromptBytes: 262144, tools: { maxCount: 16 }, modelTiers: ['quick', 'default', 'complex'] });

  /* ---------- dictation (Web Speech API) ---------- */
  function makeDictation() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const subs = { p: new Set(), f: new Set(), s: new Set() };
    let rec = null, state = 'idle', stopping = false, lastReason = 'stopped';
    const emit = (k, v) => subs[k].forEach((fn) => { try { fn(v); } catch (e) {} });
    const setState = (s, reason) => { state = s; emit('s', reason ? { state: s, reason } : { state: s }); };
    const sub = (k) => (fn) => { subs[k].add(fn); if (k === 's') fn({ state }); return () => subs[k].delete(fn); };
    return Object.freeze({
      start(options) {
        if (rec) return Promise.resolve();
        return new Promise((resolve, reject) => {
          rec = new SR();
          rec.lang = (options && options.language) === 'es' ? (navigator.language.startsWith('es') ? navigator.language : 'es-ES') : ((options && options.language) || navigator.language);
          rec.continuous = true; rec.interimResults = true;
          stopping = false; lastReason = 'stopped';
          setState('starting');
          rec.onstart = () => { setState('listening'); resolve(); };
          rec.onresult = (ev) => {
            let interim = '';
            for (let i = ev.resultIndex; i < ev.results.length; i++) {
              const r = ev.results[i];
              if (r.isFinal) { emit('p', { text: '' }); emit('f', { text: r[0].transcript }); }
              else interim += r[0].transcript;
            }
            if (interim) emit('p', { text: interim });
          };
          rec.onerror = (ev) => {
            const map = { 'not-allowed': 'not_granted', 'service-not-allowed': 'not_granted', 'audio-capture': 'upstream_error', network: 'upstream_error', 'language-not-supported': 'unavailable', aborted: 'stopped', 'no-speech': 'stopped' };
            lastReason = map[ev.error] || 'upstream_error';
            if (state === 'starting') reject(err(lastReason, 'No se pudo iniciar el dictado.'));
          };
          rec.onend = () => {
            // Chrome corta tras unos segundos de silencio: reanuda mientras no se haya pedido detener.
            if (!stopping && lastReason === 'stopped' && state === 'listening') { try { rec.start(); return; } catch (e) {} }
            rec = null; setState('idle', stopping ? 'stopped' : lastReason);
          };
          try { rec.start(); } catch (e) { rec = null; setState('idle', 'upstream_error'); reject(err('upstream_error', 'No se pudo iniciar el dictado.')); }
        });
      },
      async stop() { if (!rec) return; stopping = true; setState('finishing'); rec.stop(); },
      active() { return state !== 'idle'; },
      onPartial: sub('p'), onFinal: sub('f'), onState: sub('s'),
    });
  }

  /* ---------- db (archivo JSON local, sondeo cada 5 s) ---------- */
  const listeners = new Set();
  const bump = () => listeners.forEach((fn) => fn());
  setInterval(bump, 5000);
  const api = {
    getDoc: (p) => fetch('/api/store?doc=' + encodeURIComponent(p)).then((r) => r.json()).then((j) => j.doc),
    list: (c) => fetch('/api/store?collection=' + encodeURIComponent(c)).then((r) => r.json()).then((j) => j.docs || []),
    write: (op, p, data) => fetch('/api/store', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, path: p, data }) })
      .then((r) => { if (!r.ok) throw err('unavailable', 'No se pudo guardar.'); bump(); }),
  };
  const snapDoc = (id, data) => ({ id, exists: data != null, data: () => (data == null ? undefined : JSON.parse(JSON.stringify(data))), metadata: { fromCache: false, hasPendingWrites: false } });
  function docRef(p) {
    return {
      id: p.split('/').pop(), path: p,
      get: () => api.getDoc(p).then((d) => snapDoc(p.split('/').pop(), d)),
      set: (data) => api.write('set', p, data),
      update: (data) => api.write('update', p, data),
      delete: () => api.write('delete', p),
      collection: (name) => colRef(p + '/' + name),
      onSnapshot(next, onErr) {
        let last;
        const run = () => api.getDoc(p).then((d) => { const s = JSON.stringify(d); if (s !== last) { last = s; next(snapDoc(p.split('/').pop(), d)); } }).catch((e) => onErr && onErr(err('unavailable', String(e))));
        listeners.add(run); run();
        return () => listeners.delete(run);
      },
    };
  }
  function colRef(c, order, lim) {
    const fetchDocs = () => api.list(c).then((docs) => {
      let out = docs.map((d) => snapDoc(d.id, d.data));
      if (order) out.sort((a, b) => { const x = a.data()[order.f], y = b.data()[order.f]; return (x > y ? 1 : x < y ? -1 : 0) * (order.d === 'desc' ? -1 : 1); });
      if (lim) out = out.slice(0, lim);
      return { docs: out, size: out.length, empty: !out.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
    });
    return {
      path: c,
      doc: (id) => docRef(c + '/' + (id || Math.random().toString(36).slice(2, 12))),
      add: (data) => { const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7); return api.write('set', c + '/' + id, data).then(() => docRef(c + '/' + id)); },
      orderBy: (f, d) => colRef(c, { f, d: d || 'asc' }, lim),
      limit: (n) => colRef(c, order, n),
      where: () => colRef(c, order, lim),
      get: fetchDocs,
      onSnapshot(next, onErr) {
        let last;
        const run = () => fetchDocs().then((s) => { const k = JSON.stringify(s.docs.map((d) => [d.id, d.data()])); if (k !== last) { last = k; next(s); } }).catch((e) => onErr && onErr(err('unavailable', String(e))));
        listeners.add(run); run();
        return () => listeners.delete(run);
      },
    };
  }
  const db = Object.freeze({ doc: docRef, collection: (c) => colRef(c) });

  /* ---------- user (un solo usuario local) ---------- */
  const user = Object.freeze({
    id: async () => 'local',
    isOwner: async () => true,
    canEdit: async () => true,
    can: async () => true,
    me: async () => ({ id: 'local', name: 'Tú', avatarUrl: '', color: '#1D74F5', email: null, isOwner: true, canEdit: true }),
    profiles: async (ids) => Object.fromEntries([].concat(ids).map((id) => [id, { id, name: id === 'local' ? 'Tú' : id, avatarUrl: '', color: '#1D74F5', email: null, isMe: id === 'local', guest: false }])),
    name: async () => 'Tú',
  });

  /* ---------- desktop (instalar como app: PWA) ---------- */
  let deferredPrompt = null;
  let installed = window.matchMedia && matchMedia('(display-mode: standalone)').matches;
  const changed = () => window.dispatchEvent(new Event('brisa-install-change'));
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; changed(); });
  window.addEventListener('appinstalled', () => { installed = true; deferredPrompt = null; changed(); });
  const desktop = Object.freeze({
    install: Object.freeze({
      state: async () => (installed ? 'installed' : deferredPrompt ? 'available' : 'unavailable'),
      request: async () => {
        if (!deferredPrompt) return 'unavailable';
        const p = deferredPrompt; deferredPrompt = null;
        p.prompt();
        const choice = await p.userChoice.catch(() => ({ outcome: 'dismissed' }));
        changed();
        return choice.outcome === 'accepted' ? 'installed' : 'cancelled';
      },
    }),
    // Avisos del sistema: pide permiso, suscribe este dispositivo a push y muestra el aviso.
    notification: Object.freeze({
      show: async (o) => {
        if (!('Notification' in window)) throw new Error('ENOTSUP');
        if (Notification.permission === 'default') await Notification.requestPermission();
        if (Notification.permission !== 'granted') throw new Error('EPERM');
        const reg = await navigator.serviceWorker.ready;
        const pushed = await ensurePush(reg);
        // Con push activo, el service worker ya avisa cuando la app no está a la vista.
        if (pushed && document.hidden && !(o && o.force)) return;
        await reg.showNotification('Brisa', { body: String((o && o.body) || '').slice(0, 300), icon: '/icons/icon-192.png', tag: 'brisa-mail' });
      },
    }),
    // Contador de no leídos en el ícono de la app instalada (donde el sistema lo permite).
    app: Object.freeze({ dock: Object.freeze({
      setBadge: async (t) => {
        if (!navigator.setAppBadge) return false;
        try { if (t) await navigator.setAppBadge(Number(t) || undefined); else await navigator.clearAppBadge(); return true; } catch (e) { return false; }
      },
    }) }),
  });

  async function ensurePush(reg) {
    try {
      if (!reg.pushManager) return false;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const { key } = await fetch('/api/push/key').then((r) => r.json());
        const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((key.length + 3) % 4));
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)) });
      }
      await fetch('/api/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON() }) });
      return true;
    } catch (e) { return false; }
  }

  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));

  // "brisa": avisa a la interfaz que corre con servidor propio (tareas, adjuntos, seguimiento, programados).
  const caps = { mcp, sample: Object.freeze(sample), dictation: makeDictation(), db, user, desktop, brisa: Object.freeze({ server: true }) };
  // La IA dentro de Brisa solo existe si el servidor tiene clave; si no, la interfaz ofrece "Pedir a Claude".
  const aiReady = fetch('/api/ai/status').then((r) => r.json()).then((j) => !!j.enabled).catch(() => false);
  window.claude = Object.freeze({ use: (name) => name === 'sample' ? aiReady.then((ok) => (ok ? caps.sample : null)) : Promise.resolve(caps[name] || null) });
  // Modo local: conectar directo al servidor de correo.
  try { if (!localStorage.getItem('brisa-mode')) localStorage.setItem('brisa-mode', 'gmail'); } catch (e) {}
})();
