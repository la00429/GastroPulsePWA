import { seedMenu, saveOrder, getAll, clearDraft, queueIncident } from './db.js';
import { createVoiceController, parseOrderSpeech, isVoiceSupported } from './voice.js';
import { setupSensors, scanQrCode, captureIncident } from './sensors.js';
import { requestPushPermission } from './push.js';

// ── DOM references ────────────────────────────────────────────────────────
const menuGrid          = document.querySelector('#menu-grid');
const draftItems        = document.querySelector('#draft-items');
const draftTotal        = document.querySelector('#draft-total');
const tableSelect       = document.querySelector('#table-select');
const currencySelect    = document.querySelector('#currency-select');
const toastEl           = document.querySelector('#toast');
const connectionStatus  = document.querySelector('#connection-status');
const deliveryBanner    = document.querySelector('#delivery-banner');
const bannerTable       = document.querySelector('#banner-table');
const bannerTime        = document.querySelector('#banner-time');
const navKitchenCount   = document.querySelector('#nav-kitchen-count');
const incomingCount     = document.querySelector('#incoming-count');
const kdsLastUpdate     = document.querySelector('#kds-last-update');
const verifyCard        = document.querySelector('#verification-card');
const verifyIcon        = document.querySelector('#verify-icon');
const verifyLabel       = document.querySelector('#verify-label');
const verifyDetail      = document.querySelector('#verify-detail');
const customerVoiceBtn  = document.querySelector('#customer-voice');
const qrOverlay         = document.querySelector('#qr-overlay');
const qrVideo           = document.querySelector('#qr-video');

let menu = [];
let draft = [];

// ── Helpers ───────────────────────────────────────────────────────────────
const money = (value) =>
  new Intl.NumberFormat(currencySelect.value === 'COP' ? 'es-CO' : 'en-US', {
    style: 'currency',
    currency: currencySelect.value,
    maximumFractionDigits: currencySelect.value === 'COP' ? 0 : 2,
  }).format(value);

const productPrice = (product) =>
  currencySelect.value === 'COP' ? product.priceCOP : product.priceUSD;

let toastTimer;
function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2800);
}

const vibrate = (pattern) => navigator.vibrate?.(pattern);

// ── Menu rendering ────────────────────────────────────────────────────────
function renderMenu() {
  menuGrid.innerHTML = menu
    .map(
      (item) => `
      <article class="menu-card">
        <div>
          <span class="emoji">${item.emoji}</span>
          <h3>${item.name}</h3>
          <p>${item.description}</p>
        </div>
        <div>
          <span class="price">${money(productPrice(item))}</span>
          <button class="add" data-product="${item.id}" aria-label="Añadir ${item.name}">+</button>
        </div>
      </article>`
    )
    .join('');
}

menuGrid.addEventListener('click', (event) => {
  const button = event.target.closest('[data-product]');
  if (!button) return;
  const product = menu.find((item) => item.id === button.dataset.product);
  if (!product) return;
  const existing = draft.find((item) => item.productId === product.id);
  if (existing) {
    existing.quantity += 1;
  } else {
    draft.push({ productId: product.id, name: product.name, price: productPrice(product), quantity: 1, notes: '' });
  }
  renderDraft();
  vibrate(35);
});

// ── Draft rendering ───────────────────────────────────────────────────────
function renderDraft() {
  document.querySelector('#draft-table').textContent = tableSelect.value;
  if (!draft.length) {
    draftItems.innerHTML = '<p class="empty-state">Añade productos o dicta tu comanda.</p>';
  } else {
    draftItems.innerHTML = draft
      .map(
        (item) => `
        <div class="draft-line">
          <span><b>${item.quantity}×</b> ${item.name}<small>${item.notes || 'Sin notas'}</small></span>
          <strong>${money(item.price * item.quantity)}</strong>
        </div>`
      )
      .join('');
  }
  draftTotal.textContent = money(draft.reduce((sum, item) => sum + item.price * item.quantity, 0));
}

// ── Submit order ──────────────────────────────────────────────────────────
async function submitOrder() {
  if (!draft.length) return showToast('Añade al menos un producto.');
  await saveOrder({
    table: Number(tableSelect.value),
    items: draft,
    currency: currencySelect.value,
    status: 'pending',
    source: 'waiter',
  });
  draft = [];
  renderDraft();
  showToast('Comanda guardada y enviada a cocina.');
  vibrate([60, 40, 100]);
  // Register Background Sync to flush the queue when online
  if (navigator.serviceWorker?.ready) {
    const reg = await navigator.serviceWorker.ready;
    reg.sync?.register('gastropulse-sync').catch(() => null);
  }
}

// ── View navigation ───────────────────────────────────────────────────────
function setView(viewId) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === viewId));
  document.querySelectorAll('.nav-item').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === viewId));
  if (viewId === 'kitchen-view') renderKitchen();
  if (viewId === 'customer-view') startLocationVerification();
}

// ── Kitchen KDS — reads real data from IndexedDB ──────────────────────────
let kdsRefreshTimer = null;

async function renderKitchen() {
  clearTimeout(kdsRefreshTimer);

  // Try server first (online), fall back to IndexedDB
  let orders = [];
  if (navigator.onLine) {
    try {
      const res = await fetch('/api/orders');
      if (res.ok) orders = await res.json();
    } catch (_err) { /* fall through to IndexedDB */ }
  }
  if (!orders.length) {
    const all = await getAll('comandas');
    orders = all.filter((o) => ['pending', 'preparing'].includes(o.status));
  }

  incomingCount.textContent = orders.length;
  navKitchenCount.textContent = orders.length;
  kdsLastUpdate.textContent = `Actualizado ${new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}`;

  if (!orders.length) {
    document.querySelector('#kds-board').innerHTML =
      '<p class="empty-state" style="grid-column:1/-1;padding:2rem 0">No hay comandas activas.</p>';
    return;
  }

  document.querySelector('#kds-board').innerHTML = orders
    .map((order) => {
      const elapsed = order.updatedAt
        ? formatElapsed(new Date(order.updatedAt))
        : '—';
      return `
        <article class="kds-card" data-order-id="${order.id}">
          <header>
            <div>
              <p class="eyebrow">COMANDA #${String(order.table).padStart(3, '0')}</p>
              <h3>Mesa ${order.table}</h3>
            </div>
            <span class="timer">${elapsed}</span>
          </header>
          <div class="kds-items">
            ${order.items
              .map(
                (item) => `
              <div class="kds-item">
                <b>${item.quantity}×</b>
                <span>${item.name}${item.notes ? `<small> · ${item.notes}</small>` : ''}</span>
              </div>`
              )
              .join('')}
          </div>
          <div class="kds-actions">
            <button class="photo-button" data-incident="${order.table}">▣ Incidencia</button>
            <button class="ready-button" data-ready="${order.table}" data-order-id="${order.id}">✓ Marcar listo</button>
          </div>
        </article>`;
    })
    .join('');

  // Auto-refresh every 30 s while KDS is visible
  kdsRefreshTimer = setTimeout(() => {
    if (document.querySelector('#kitchen-view')?.classList.contains('active')) renderKitchen();
  }, 30_000);
}

function formatElapsed(date) {
  const secs = Math.floor((Date.now() - date.getTime()) / 1000);
  const m = Math.floor(secs / 60).toString().padStart(2, '0');
  const s = (secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

document.querySelector('#kds-board').addEventListener('click', async (event) => {
  // ── Marcar listo → Caminante ──────────────────────────────────────────
  const readyBtn = event.target.closest('[data-ready]');
  if (readyBtn) {
    const table = readyBtn.dataset.ready;
    const orderId = readyBtn.dataset.orderId;
    readyBtn.disabled = true;
    readyBtn.textContent = '⏳ Enviando…';

    // Show banner immediately (optimistic)
    bannerTable.textContent = table;
    bannerTime.textContent = `Preparado por Cocina · ${new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}`;
    deliveryBanner.classList.add('visible');
    vibrate([100, 50, 100]);

    // Send push notification via server
    try {
      const res = await fetch('/api/push/kitchen-ready', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ table: Number(table), orderId }),
      });
      const data = await res.json();
      showToast(
        res.ok
          ? `Caminante activado · ${data.sent ?? 0} dispositivo(s) notificado(s).`
          : 'Caminante activado (push no configurado).'
      );
    } catch (_err) {
      showToast('Caminante activado (sin conexión al servidor).');
    }

    // Refresh KDS after short delay
    setTimeout(renderKitchen, 1500);
  }

  // ── Incidencia ────────────────────────────────────────────────────────
  const incidentBtn = event.target.closest('[data-incident]');
  if (incidentBtn) {
    try {
      await captureIncident();
      await queueIncident({ table: Number(incidentBtn.dataset.incident) });
      showToast('Incidencia capturada y guardada.');
    } catch (error) {
      showToast(error.message);
    }
  }
});

// ── QR scan ───────────────────────────────────────────────────────────────
document.querySelector('#scan-qr').addEventListener('click', async () => {
  qrOverlay.classList.remove('hidden');
  try {
    const value = await scanQrCode(qrVideo);
    qrOverlay.classList.add('hidden');
    if (value) {
      // Expect QR to contain just a table number or "mesa:N"
      const match = value.match(/(?:mesa[:\s]*)(\d+)/i) || value.match(/^(\d+)$/);
      if (match) {
        tableSelect.value = match[1];
        tableSelect.dispatchEvent(new Event('change'));
        showToast(`Mesa ${match[1]} seleccionada por QR.`);
      } else {
        showToast(`QR leído: ${value}`);
      }
    } else {
      showToast('No se detectó ningún QR.');
    }
  } catch (error) {
    qrOverlay.classList.add('hidden');
    showToast(error.message);
  }
});

document.querySelector('#qr-cancel').addEventListener('click', () => {
  // Stop any active camera stream
  if (qrVideo.srcObject) {
    qrVideo.srcObject.getTracks().forEach((t) => t.stop());
    qrVideo.srcObject = null;
  }
  qrOverlay.classList.add('hidden');
});

// ── GPS verification (Customer view) ─────────────────────────────────────
// Restaurant coordinates — update to your actual location
const RESTAURANT_COORDS = { latitude: 5.5353, longitude: -73.3678 }; // UPTC Tunja
const PERIMETER_RADIUS_M = 200;

async function startLocationVerification() {
  verifyCard.classList.remove('verified', 'failed');
  verifyCard.classList.add('unverified');
  verifyIcon.textContent = '⟳';
  verifyLabel.textContent = 'Verificando ubicación…';
  verifyDetail.innerHTML = `Comprobando GPS · Mesa <span id="customer-table">${tableSelect.value}</span>`;
  customerVoiceBtn.disabled = true;

  try {
    const { verified, distance } = await sensors.verifyLocation(RESTAURANT_COORDS, PERIMETER_RADIUS_M);
    if (verified) {
      verifyCard.classList.replace('unverified', 'verified');
      verifyIcon.textContent = '✓';
      verifyLabel.textContent = 'Ubicación y Wi-Fi verificados';
      verifyDetail.innerHTML = `Estás dentro de GastroPulse · Mesa <span id="customer-table">${tableSelect.value}</span>`;
      customerVoiceBtn.disabled = false;
    } else {
      setVerifyFailed(`Estás a ${Math.round(distance)} m del restaurante (máx. ${PERIMETER_RADIUS_M} m).`);
    }
  } catch (error) {
    setVerifyFailed(error.message);
  }
}

function setVerifyFailed(reason) {
  verifyCard.classList.replace('unverified', 'failed');
  verifyIcon.textContent = '✗';
  verifyLabel.textContent = 'Verificación fallida';
  verifyDetail.innerHTML = reason;
  customerVoiceBtn.disabled = true;
}

document.querySelector('#verify-location-btn').addEventListener('click', startLocationVerification);

// ── SW message listener ───────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'SYNC_COMPLETE') {
      showToast('Comandas sincronizadas con el servidor.');
      // Refresh KDS if visible
      if (document.querySelector('#kitchen-view')?.classList.contains('active')) renderKitchen();
    }
  });
}

// ── Push button ───────────────────────────────────────────────────────────
document.querySelector('#push-toggle').addEventListener('click', async () => {
  try {
    await requestPushPermission();
    showToast('Notificaciones de cocina activadas. 🔔');
    document.querySelector('#push-toggle').textContent = '🔕';
    document.querySelector('#push-toggle').title = 'Notificaciones activadas';
  } catch (error) {
    showToast(error.message);
  }
});

// ── Voice ─────────────────────────────────────────────────────────────────
let sensors;

function initVoice() {
  const voice = createVoiceController({
    onState: (state) => {
      document.querySelector('#voice-button').classList.toggle('listening', state === 'listening');
      if (state === 'unsupported') showToast('Dictado no disponible en este navegador.');
      if (state === 'error') showToast('Error en reconocimiento de voz.');
    },
    onResult: (transcript, isFinal) => {
      if (!isFinal) return;
      const parsed = parseOrderSpeech(transcript, menu);
      if (parsed.table) tableSelect.value = parsed.table;
      parsed.items.forEach((item) => {
        const product = menu.find((p) => p.id === item.productId);
        if (!product) return;
        const existing = draft.find((d) => d.productId === item.productId);
        if (existing) {
          existing.quantity += item.quantity;
        } else {
          draft.push({ ...item, price: productPrice(product) });
        }
      });
      renderDraft();
      showToast(`Comanda entendida: "${transcript}"`);
    },
  });

  document.querySelector('#voice-button').addEventListener('click', () => {
    if (voice.supported) {
      voice.start();
    } else {
      showToast('Usa Chrome para activar el dictado.');
    }
  });

  document.querySelector('#customer-voice').addEventListener('click', () => {
    setView('waiter-view');
    if (voice.supported) voice.start();
  });

  if (isVoiceSupported()) {
    document.querySelector('#voice-button').title = 'Dictar con Web Speech API';
  }

  return voice;
}

// ── Init ──────────────────────────────────────────────────────────────────
async function init() {
  menu = await seedMenu();
  renderMenu();
  renderDraft();

  // Register Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(console.error);
  }

  // Online / offline status
  function updateConnectionStatus() {
    const online = navigator.onLine;
    connectionStatus.className = `status-pill ${online ? 'online' : 'offline'}`;
    connectionStatus.innerHTML = `<i>●</i> ${online ? 'Online' : 'Offline'}`;
    document.querySelector('#order-status').style.display = online ? 'none' : '';
  }
  window.addEventListener('online', updateConnectionStatus);
  window.addEventListener('offline', updateConnectionStatus);
  updateConnectionStatus();

  // Navigation
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });

  // Waiter controls
  document.querySelector('#send-order').addEventListener('click', submitOrder);
  document.querySelector('#clear-order').addEventListener('click', async () => {
    draft = [];
    await clearDraft(tableSelect.value);
    renderDraft();
    showToast('Borrador limpiado.');
  });
  tableSelect.addEventListener('change', () => {
    document.querySelectorAll('#customer-table').forEach((el) => { el.textContent = tableSelect.value; });
    renderDraft();
  });

  // Delivery banner
  document.querySelector('#dismiss-delivery').addEventListener('click', () => {
    deliveryBanner.classList.remove('visible');
  });

  // Theme toggle
  document.querySelector('#theme-toggle').addEventListener('click', () => {
    document.body.classList.toggle('dark');
    document.querySelector('#theme-toggle').textContent =
      document.body.classList.contains('dark') ? '☾' : '☼';
  });

  // Currency change — recalculate draft prices
  currencySelect.addEventListener('change', () => {
    draft = draft.map((item) => {
      const product = menu.find((p) => p.id === item.productId);
      return product ? { ...item, price: productPrice(product) } : item;
    });
    renderMenu();
    renderDraft();
  });

  // Customer menu button — go to waiter view (shows full menu)
  document.querySelector('#customer-menu').addEventListener('click', () => setView('waiter-view'));

  // Sensors
  sensors = setupSensors({
    onShake: () => {
      if (draft.length && confirm('¿Descartar el borrador de esta mesa?')) {
        draft = [];
        renderDraft();
      }
    },
    onLightChange: (mode) => {
      document.body.classList.toggle('dark', mode === 'dining');
      document.querySelector('#theme-toggle').textContent =
        document.body.classList.contains('dark') ? '☾' : '☼';
    },
    onLocation: (verified) => {
      if (verified) showToast('Ubicación verificada.');
    },
  });

  // Voice
  initVoice();

  // Initial connection state dispatch
  window.dispatchEvent(new Event(navigator.onLine ? 'online' : 'offline'));
}

init().catch((error) => showToast(`No se pudo iniciar GastroPulse: ${error.message}`));
