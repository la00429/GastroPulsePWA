const CACHE_NAME = 'gastropulse-shell-v1';
const APP_SHELL = ['/', '/index.html', '/css/styles.css', '/js/app.js', '/js/db.js', '/js/voice.js', '/js/sensors.js', '/js/push.js', '/manifest.json', '/icons/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match('/'))));
});
self.addEventListener('sync', (event) => {
  if (event.tag === 'gastropulse-sync') event.waitUntil(syncQueue());
});
self.addEventListener('push', (event) => {
  const data = event.data?.json() || { title: 'GastroPulse', body: 'Tu comanda tiene una actualización.' };
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: '/icons/icon.svg', badge: '/icons/icon.svg', vibrate: [100, 50, 100], data: data.url || '/' }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((openClients) => {
    const client = openClients[0];
    return client ? client.focus() : clients.openWindow(event.notification.data);
  }));
});
async function syncQueue() {
  const clientsList = await clients.matchAll({ type: 'window' });
  clientsList.forEach((client) => client.postMessage({ type: 'SYNC_REQUESTED' }));
}
