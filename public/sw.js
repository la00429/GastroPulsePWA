const CACHE_NAME = 'gastropulse-shell-v3';
const APP_SHELL = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/js/db.js',
  '/js/voice.js',
  '/js/sensors.js',
  '/js/push.js',
  '/manifest.json',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// ── Install: pre-cache app shell ──────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: clean old caches ────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: navigation and assets offline-first ─────────────────────────────
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  // Don't cache API calls
  if (event.request.url.includes('/api/')) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      caches.match('/index.html').then((cached) => {
        const networkRequest = fetch(event.request)
          .then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', copy));
            }
            return response;
          })
          .catch(() => cached);

        return cached || networkRequest;
      })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      }).catch(() => caches.match('/index.html'));
    })
  );
});

// ── Background Sync: flush sync_queue to server ───────────────────────────
self.addEventListener('sync', (event) => {
  if (event.tag === 'gastropulse-sync') {
    event.waitUntil(flushSyncQueue());
  }
});

async function flushSyncQueue() {
  // Open IndexedDB directly from the SW context
  const db = await openIDB();
  const queue = await getAllFromStore(db, 'sync_queue');
  if (!queue.length) return;

  const orderItems = queue.filter((item) => item.type === 'CREATE_ORDER');
  const incidentItems = queue.filter((item) => item.type === 'INCIDENT');

  // Batch-send orders
  if (orderItems.length) {
    try {
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(orderItems.map((item) => item.payload)),
      });
      if (response.ok) {
        // Remove successfully synced order items from queue
        for (const item of orderItems) {
          await deleteFromStore(db, 'sync_queue', item.id);
        }
      }
    } catch (_err) {
      // Network failure — leave in queue for next sync attempt
    }
  }

  // Incidents: sync to the server and remove only after success
  for (const item of incidentItems) {
    try {
      const response = await fetch('/api/complaints', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(item.payload),
      });
      if (response.ok) {
        await deleteFromStore(db, 'sync_queue', item.id);
      }
    } catch (_err) {
      // Network failure — leave in queue for the next sync attempt
    }
  }

  // Notify all open clients that sync completed
  const clientsList = await self.clients.matchAll({ type: 'window' });
  clientsList.forEach((client) => client.postMessage({ type: 'SYNC_COMPLETE' }));
}

// ── Push: show notification ───────────────────────────────────────────────
self.addEventListener('push', (event) => {
  const data = event.data?.json() || { title: 'GastroPulse', body: 'Tu comanda tiene una actualización.' };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon.svg',
      badge: '/icons/icon.svg',
      vibrate: [100, 50, 100, 50, 100],
      data: data.url || '/',
    })
  );
});

// ── Notification click: focus or open window ──────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((openClients) => {
      const client = openClients[0];
      return client ? client.focus() : clients.openWindow(event.notification.data);
    })
  );
});

// ── IndexedDB helpers (no imports available in SW) ────────────────────────
function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('gastropulse-db', 3);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {
      const db = req.result;
      ['menu', 'comandas', 'sync_queue', 'incidencias'].forEach((store) => {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, { keyPath: 'id' });
        }
      });
    };
  });
}

function getAllFromStore(db, storeName) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function deleteFromStore(db, storeName, id) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readwrite').objectStore(storeName).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
