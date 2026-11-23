const DB_NAME = 'gastropulse-db';
const DB_VERSION = 3; // bumped: añade store 'incidencias'
const STORES = ['menu', 'comandas', 'sync_queue', 'incidencias'];

const defaultMenu = [
  { id: 'hamburguesa', name: 'Hamburguesa clásica', description: 'Carne, queso, tomate y patatas', priceCOP: 49500, priceUSD: 12.5, emoji: '🍔' },
  { id: 'cerveza', name: 'Cerveza artesanal', description: 'Caña lager de la casa', priceCOP: 14000, priceUSD: 3.5, emoji: '🍺' },
  { id: 'bravas', name: 'Patatas bravas', description: 'Salsa brava y alioli', priceCOP: 28000, priceUSD: 7, emoji: '🍟' },
  { id: 'ensalada', name: 'Ensalada de temporada', description: 'Verde, tomate y vinagreta', priceCOP: 36000, priceUSD: 9, emoji: '🥗' },
  { id: 'tarta', name: 'Tarta de queso', description: 'Cremosa, con frutos rojos', priceCOP: 24000, priceUSD: 6, emoji: '🍰' },
  { id: 'agua', name: 'Agua mineral', description: 'Botella 50 cl', priceCOP: 8000, priceUSD: 2, emoji: '💧' },
];

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      STORES.forEach((store) => {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, { keyPath: 'id' });
        }
      });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getAll(storeName) {
  const db = await openDatabase();
  return requestToPromise(db.transaction(storeName, 'readonly').objectStore(storeName).getAll());
}

export async function put(storeName, value) {
  const db = await openDatabase();
  return requestToPromise(db.transaction(storeName, 'readwrite').objectStore(storeName).put(value));
}

export async function remove(storeName, id) {
  const db = await openDatabase();
  return requestToPromise(db.transaction(storeName, 'readwrite').objectStore(storeName).delete(id));
}

export async function seedMenu() {
  const existing = await getAll('menu');
  if (existing.length === 0 || existing.some((item) => !item.priceCOP || !item.priceUSD)) {
    const db = await openDatabase();
    const tx = db.transaction('menu', 'readwrite');
    defaultMenu.forEach((item) => tx.objectStore('menu').put(item));
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }
  return getAll('menu');
}

export async function saveOrder(order) {
  const stored = {
    id: order.id || crypto.randomUUID(),
    table: Number(order.table),
    items: (order.items || []).map((item) => ({
      productId: String(item.productId),
      name: String(item.name),
      price: Number(item.price),
      quantity: Number(item.quantity),
      notes: String(item.notes || ''),
    })),
    currency: String(order.currency || 'COP'),
    status: String(order.status || 'pending'),
    source: String(order.source || 'waiter'),
    createdAt: order.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await put('comandas', stored);
  await put('sync_queue', {
    id: crypto.randomUUID(),
    type: 'CREATE_ORDER',
    payload: stored,
    createdAt: new Date().toISOString(),
  });
  return stored;
}

export async function saveIncident(incident) {
  const stored = {
    id: crypto.randomUUID(),
    table: incident.table,
    photoDataUrl: incident.photoDataUrl || null,
    note: incident.note || '',
    source: incident.source || 'staff',   // 'staff' | 'customer'
    createdAt: new Date().toISOString(),
  };
  await put('incidencias', stored);
  // Also queue for server sync (best-effort)
  await put('sync_queue', {
    id: crypto.randomUUID(),
    type: 'INCIDENT',
    payload: {
      id: stored.id,
      table: stored.table,
      note: stored.note,
      source: stored.source,
      hasPhoto: Boolean(stored.photoDataUrl),
      createdAt: stored.createdAt,
    },
    createdAt: stored.createdAt,
  });
  await registerSync();
  return stored;
}

export async function registerSync() {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  await registration.sync?.register('gastropulse-sync').catch(() => null);
}

export async function removeIncident(id) {
  return remove('incidencias', id);
}

export async function queueIncident(incident) {
  return put('sync_queue', {
    id: crypto.randomUUID(),
    type: 'INCIDENT',
    payload: incident,
    createdAt: new Date().toISOString(),
  });
}

export async function getDraft(table) {
  const orders = await getAll('comandas');
  return orders.find((o) => o.table === Number(table) && o.status === 'draft');
}

export async function clearDraft(table) {
  const draft = await getDraft(table);
  if (draft) await remove('comandas', draft.id);
}
