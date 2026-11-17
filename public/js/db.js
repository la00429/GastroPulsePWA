const DB_NAME = 'gastropulse-db';
const DB_VERSION = 2;
const STORES = ['menu', 'comandas', 'sync_queue'];

const defaultMenu = [
  { id: 'hamburguesa', name: 'Hamburguesa clásica', description: 'Carne, queso, tomate y patatas', priceCOP: 49500, priceUSD: 12.5, emoji: '🍔' },
  { id: 'cerveza', name: 'Cerveza artesanal', description: 'Caña lager de la casa', priceCOP: 14000, priceUSD: 3.5, emoji: '🍺' },
  { id: 'bravas', name: 'Patatas bravas', description: 'Salsa brava y alioli', priceCOP: 28000, priceUSD: 7, emoji: '🍟' },
  { id: 'ensalada', name: 'Ensalada de temporada', description: 'Verde, tomate y vinagreta', priceCOP: 36000, priceUSD: 9, emoji: '🥗' },
  { id: 'tarta', name: 'Tarta de queso', description: 'Cremosa, con frutos rojos', priceCOP: 24000, priceUSD: 6, emoji: '🍰' },
  { id: 'agua', name: 'Agua mineral', description: 'Botella 50 cl', priceCOP: 8000, priceUSD: 2, emoji: '💧' }
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
    request.onupgradeneeded = () => {
      const database = request.result;
      STORES.forEach((store) => {
        if (!database.objectStoreNames.contains(store)) {
          database.createObjectStore(store, { keyPath: 'id' });
        }
      });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getAll(storeName) {
  const database = await openDatabase();
  return requestToPromise(database.transaction(storeName, 'readonly').objectStore(storeName).getAll());
}

export async function put(storeName, value) {
  const database = await openDatabase();
  return requestToPromise(database.transaction(storeName, 'readwrite').objectStore(storeName).put(value));
}

export async function remove(storeName, id) {
  const database = await openDatabase();
  return requestToPromise(database.transaction(storeName, 'readwrite').objectStore(storeName).delete(id));
}

export async function seedMenu() {
  const existingItems = await getAll('menu');
  if (existingItems.length === 0 || existingItems.some((item) => !item.priceCOP || !item.priceUSD)) {
    const database = await openDatabase();
    const transaction = database.transaction('menu', 'readwrite');
    defaultMenu.forEach((item) => transaction.objectStore('menu').put(item));
    await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
  }
  return getAll('menu');
}

export async function saveOrder(order) {
  const storedOrder = { ...order, id: order.id || crypto.randomUUID(), updatedAt: new Date().toISOString() };
  await put('comandas', storedOrder);
  await put('sync_queue', { id: crypto.randomUUID(), type: 'CREATE_ORDER', payload: storedOrder, createdAt: new Date().toISOString() });
  return storedOrder;
}

export async function queueIncident(incident) {
  return put('sync_queue', { id: crypto.randomUUID(), type: 'INCIDENT', payload: incident, createdAt: new Date().toISOString() });
}

export async function getDraft(table) {
  const orders = await getAll('comandas');
  return orders.find((order) => order.table === Number(table) && order.status === 'draft');
}

export async function clearDraft(table) {
  const draft = await getDraft(table);
  if (draft) await remove('comandas', draft.id);
}
