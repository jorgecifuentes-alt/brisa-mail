// Brisa · service worker: guarda la interfaz para abrir rápido y sin conexión.
// Nunca guarda el correo: las llamadas a /api siempre van al servidor.
const CACHE = 'brisa-shell-v4';
const SHELL = ['/index.html', '/shim.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Red primero (para tener siempre la última versión); la copia guardada solo si no hay conexión.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && SHELL.includes(url.pathname)) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html')))
  );
});

// Aviso de correo nuevo (llega aunque la app esté cerrada).
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Con la app a la vista, la propia página muestra el aviso: no duplicarlo.
    if (wins.some((w) => w.visibilityState === 'visible' && w.focused)) return;
    const canAct = !!(d.id && d.tok);
    await self.registration.showNotification(d.title || 'Correo nuevo', {
      body: d.body || '', tag: d.tag || 'brisa-mail', renotify: true,
      icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: d.url || '/index.html', id: d.id, tok: d.tok },
      actions: canAct ? [{ action: 'read', title: 'Marcar como leído' }, { action: 'archive', title: 'Archivar' }] : [],
    });
    await updateBadge();
  })());
});
// Número en el ícono: cuántos correos nuevos hay avisados (en Android lo muestra el lanzador según las notificaciones).
async function updateBadge() {
  try {
    const n = (await self.registration.getNotifications()).filter((x) => String(x.tag).startsWith('mail-')).length;
    if (self.navigator.setAppBadge) { if (n) await self.navigator.setAppBadge(n); else await self.navigator.clearAppBadge(); }
  } catch { /* sin contador */ }
}
self.addEventListener('notificationclose', (e) => { e.waitUntil(updateBadge()); });
self.addEventListener('notificationclick', (e) => {
  const d = e.notification.data || {};
  // Botones de la notificación: actuar sin abrir la app.
  if (e.action === 'read' || e.action === 'archive') {
    e.notification.close();
    e.waitUntil((async () => {
      let ok = false;
      try {
        const r = await fetch('/api/notify-action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: d.id, tok: d.tok, action: e.action }) });
        ok = r.ok;
      } catch { /* sin conexión */ }
      if (!ok) await self.registration.showNotification('Brisa', { body: 'No se pudo ' + (e.action === 'read' ? 'marcar como leído' : 'archivar') + '. Ábrelo en la app.', tag: 'brisa-error', icon: '/icons/icon-192.png' });
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      wins.forEach((w) => w.postMessage({ type: 'brisa-refresh' }));
      await updateBadge();
    })());
    return;
  }
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/index.html';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if ('focus' in w) return w.focus(); }
    return self.clients.openWindow(url);
  })());
});
