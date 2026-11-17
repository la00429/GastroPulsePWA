import { seedMenu, saveOrder, clearDraft, queueIncident } from './db.js';
import { createVoiceController, parseOrderSpeech, isVoiceSupported } from './voice.js';
import { setupSensors, scanQrCode, captureIncident } from './sensors.js';
import { requestPushPermission } from './push.js';

const menuGrid = document.querySelector('#menu-grid');
const draftItems = document.querySelector('#draft-items');
const draftTotal = document.querySelector('#draft-total');
const tableSelect = document.querySelector('#table-select');
const currencySelect = document.querySelector('#currency-select');
let menu = [];
let draft = [];

const money = (value) => new Intl.NumberFormat(currencySelect.value === 'COP' ? 'es-CO' : 'en-US', { style: 'currency', currency: currencySelect.value, maximumFractionDigits: currencySelect.value === 'COP' ? 0 : 2 }).format(value);
const productPrice = (product) => currencySelect.value === 'COP' ? product.priceCOP : product.priceUSD;
const showToast = (message) => { const toast = document.querySelector('#toast'); toast.textContent = message; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2600); };
const vibrate = (pattern) => navigator.vibrate?.(pattern);

function renderMenu() {
  menuGrid.innerHTML = menu.map((item) => `<article class="menu-card"><div><span class="emoji">${item.emoji}</span><h3>${item.name}</h3><p>${item.description}</p></div><div><span class="price">${money(productPrice(item))}</span><button class="add" data-product="${item.id}" aria-label="Añadir ${item.name}">+</button></div></article>`).join('');
  menuGrid.addEventListener('click', (event) => {
    const button = event.target.closest('[data-product]');
    if (!button) return;
    const product = menu.find((item) => item.id === button.dataset.product);
    const existing = draft.find((item) => item.productId === product.id);
    if (existing) existing.quantity += 1; else draft.push({ productId: product.id, name: product.name, price: productPrice(product), quantity: 1, notes: '' });
    renderDraft(); vibrate(35);
  });
}

function renderDraft() {
  document.querySelector('#draft-table').textContent = tableSelect.value;
  if (!draft.length) draftItems.innerHTML = '<p class="empty-state">Añade productos o dicta tu comanda.</p>';
  else draftItems.innerHTML = draft.map((item) => `<div class="draft-line"><span><b>${item.quantity}×</b> ${item.name}<small>${item.notes || 'Sin notas'}</small></span><strong>${money(item.price * item.quantity)}</strong></div>`).join('');
  draftTotal.textContent = money(draft.reduce((sum, item) => sum + item.price * item.quantity, 0));
}

async function submitOrder() {
  if (!draft.length) return showToast('Añade al menos un producto.');
  await saveOrder({ table: Number(tableSelect.value), items: draft, currency: currencySelect.value, status: 'pending', source: 'waiter' });
  draft = []; renderDraft(); showToast('Comanda guardada y enviada a cocina.'); vibrate([60, 40, 100]);
  if (navigator.serviceWorker?.ready) (await navigator.serviceWorker.ready).sync?.register('gastropulse-sync');
}

function setView(viewId) {
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === viewId));
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === viewId));
  if (viewId === 'kitchen-view') renderKitchen();
}

function renderKitchen() {
  const orders = [{ table: 5, age: '02:14', items: [{ quantity: 2, name: 'Cerveza artesanal' }, { quantity: 1, name: 'Hamburguesa clásica', notes: 'Sin cebolla' }] }, { table: 2, age: '08:42', items: [{ quantity: 1, name: 'Ensalada de temporada' }, { quantity: 1, name: 'Agua mineral' }] }, { table: 8, age: '12:05', items: [{ quantity: 3, name: 'Patatas bravas' }] }];
  document.querySelector('#incoming-count').textContent = orders.length;
  document.querySelector('#kds-board').innerHTML = orders.map((order) => `<article class="kds-card"><header><div><p class="eyebrow">COMANDA #${String(order.table).padStart(3, '0')}</p><h3>Mesa ${order.table}</h3></div><span class="timer">${order.age}</span></header><div class="kds-items">${order.items.map((item) => `<div class="kds-item"><b>${item.quantity}×</b><span>${item.name}${item.notes ? `<small> · ${item.notes}</small>` : ''}</span></div>`).join('')}</div><div class="kds-actions"><button class="photo-button" data-incident="${order.table}">▣ Incidencia</button><button class="ready-button" data-ready="${order.table}">✓ Marcar listo</button></div></article>`).join('');
  document.querySelector('#kds-board').onclick = async (event) => {
    const ready = event.target.closest('[data-ready]');
    const incident = event.target.closest('[data-incident]');
    if (ready) { document.querySelector('#delivery-banner').classList.add('visible'); showToast(`Caminante activado para Mesa ${ready.dataset.ready}`); vibrate([100, 50, 100]); }
    if (incident) { try { await captureIncident(); await queueIncident({ table: Number(incident.dataset.incident) }); showToast('Incidencia capturada y guardada.'); } catch (error) { showToast(error.message); } }
  };
}

async function init() {
  menu = await seedMenu(); renderMenu(); renderDraft(); renderKitchen();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
  window.addEventListener('online', () => { document.querySelector('#connection-status').className = 'status-pill online'; document.querySelector('#connection-status').innerHTML = '<i>●</i> Online'; });
  window.addEventListener('offline', () => { document.querySelector('#connection-status').className = 'status-pill offline'; document.querySelector('#connection-status').innerHTML = '<i>●</i> Offline'; });
  document.querySelector('#send-order').onclick = submitOrder;
  document.querySelector('#clear-order').onclick = async () => { draft = []; await clearDraft(tableSelect.value); renderDraft(); showToast('Borrador limpiado.'); };
  tableSelect.onchange = () => { document.querySelector('#customer-table').textContent = tableSelect.value; renderDraft(); };
  document.querySelectorAll('.nav-item').forEach((item) => { item.onclick = () => setView(item.dataset.view); });
  document.querySelector('#theme-toggle').onclick = () => { document.body.classList.toggle('dark'); document.querySelector('#theme-toggle').textContent = document.body.classList.contains('dark') ? '☾' : '☼'; };
  currencySelect.onchange = () => { draft = draft.map((item) => { const product = menu.find((entry) => entry.id === item.productId); return { ...item, price: productPrice(product) }; }); renderMenu(); renderDraft(); };
  document.querySelector('#dismiss-delivery').onclick = () => document.querySelector('#delivery-banner').classList.remove('visible');
  document.querySelector('#scan-qr').onclick = () => showToast('Abriendo cámara para escanear la mesa…');
  const voice = createVoiceController({ onState: (state) => { document.querySelector('#voice-button').classList.toggle('listening', state === 'listening'); if (state === 'unsupported') showToast('Dictado no disponible en este navegador.'); }, onResult: (transcript, final) => { if (!final) return; const parsed = parseOrderSpeech(transcript, menu); if (parsed.table) tableSelect.value = parsed.table; parsed.items.forEach((item) => { const product = menu.find((entry) => entry.id === item.productId); const existing = draft.find((entry) => entry.productId === item.productId); if (existing) existing.quantity += item.quantity; else draft.push({ ...item, price: productPrice(product) }); }); renderDraft(); showToast(`Comanda entendida: “${transcript}”`); } });
  document.querySelector('#voice-button').onclick = () => voice.supported ? voice.start() : showToast('Usa Chrome para activar el dictado.');
  document.querySelector('#customer-voice').onclick = () => { document.querySelector('#voice-button').click(); setView('waiter-view'); };
  window.enableGastroPulsePush = () => requestPushPermission().then(() => showToast('Notificaciones de cocina activadas.')).catch((error) => showToast(error.message));
  setupSensors({ onShake: () => { if (draft.length && confirm('¿Descartar el borrador de esta mesa?')) { draft = []; renderDraft(); } }, onLightChange: (mode) => document.body.classList.toggle('dark', mode === 'dining') });
  if (isVoiceSupported()) document.querySelector('#voice-button').title = 'Dictar con Web Speech API';
  if (navigator.onLine) window.dispatchEvent(new Event('online'));
}
init().catch((error) => showToast(`No se pudo iniciar GastroPulse: ${error.message}`));
