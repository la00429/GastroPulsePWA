import { seedMenu, saveOrder, getAll, clearDraft, saveIncident, removeIncident } from './db.js';
import { createVoiceController, parseOrderSpeech, isVoiceSupported } from './voice.js';
import { setupSensors, scanQrCode, captureIncident } from './sensors.js';
import { requestPushPermission } from './push.js';

// ── DOM refs ──────────────────────────────────────────────────────────────
const menuGrid         = document.querySelector('#menu-grid');
const draftItemsEl     = document.querySelector('#draft-items');
const draftTotalEl     = document.querySelector('#draft-total');
const tableSelect      = document.querySelector('#table-select');
const currencySelect   = document.querySelector('#currency-select');
const toastEl          = document.querySelector('#toast');
const connectionStatus = document.querySelector('#connection-status');
const deliveryBanner   = document.querySelector('#delivery-banner');
const bannerTable      = document.querySelector('#banner-table');
const bannerTime       = document.querySelector('#banner-time');
const navBadge         = document.querySelector('#nav-badge');
const incomingCount    = document.querySelector('#incoming-count');
const kdsLastUpdate    = document.querySelector('#kds-last-update');
const verifyCard       = document.querySelector('#verification-card');
const verifyIcon       = document.querySelector('#verify-icon');
const verifyLabel      = document.querySelector('#verify-label');
const verifyDetail     = document.querySelector('#verify-detail');
const customerVoiceBtn = document.querySelector('#customer-voice');
const qrOverlay        = document.querySelector('#qr-overlay');
const qrVideo          = document.querySelector('#qr-video');
const incidentOverlay  = document.querySelector('#incident-overlay');
const incidentVideo    = document.querySelector('#incident-video');
const incidentCd       = document.querySelector('#incident-countdown');
const voiceTranscript  = document.querySelector('#voice-transcript');
const customerTranscript = document.querySelector('#customer-transcript');

let menu = [];
let draft = [];
let sensors;

// ── Helpers ───────────────────────────────────────────────────────────────
const money = (v) =>
  new Intl.NumberFormat(currencySelect.value === 'COP' ? 'es-CO' : 'en-US', {
    style: 'currency', currency: currencySelect.value,
    maximumFractionDigits: currencySelect.value === 'COP' ? 0 : 2,
  }).format(v);

const productPrice = (p) => currencySelect.value === 'COP' ? p.priceCOP : p.priceUSD;

let toastTimer;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3000);
}

const vibrate = (p) => navigator.vibrate?.(p);

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
}
function formatElapsed(iso) {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  const m = String(Math.floor(secs / 60)).padStart(2, '0');
  const s = String(secs % 60).padStart(2, '0');
  return `${m}:${s}`;
}

// ── Menu ──────────────────────────────────────────────────────────────────
function renderMenu() {
  menuGrid.innerHTML = menu.map((item) => `
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
    </article>`).join('');
}

menuGrid.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-product]');
  if (!btn) return;
  const product = menu.find((p) => p.id === btn.dataset.product);
  if (!product) return;
  const existing = draft.find((d) => d.productId === product.id);
  if (existing) existing.quantity += 1;
  else draft.push({ productId: product.id, name: product.name, price: productPrice(product), quantity: 1, notes: '' });
  renderDraft();
  vibrate(35);
});

// ── Draft ─────────────────────────────────────────────────────────────────
function renderDraft() {
  document.querySelector('#draft-table').textContent = tableSelect.value;
  draftItemsEl.innerHTML = draft.length
    ? draft.map((item) => `
        <div class="draft-line">
          <span><b>${item.quantity}×</b> ${item.name}
            ${item.notes ? `<small>${item.notes}</small>` : ''}
          </span>
          <strong>${money(item.price * item.quantity)}</strong>
        </div>`).join('')
    : '<p class="empty-state">Añade productos o dicta tu comanda.</p>';
  draftTotalEl.textContent = money(draft.reduce((s, i) => s + i.price * i.quantity, 0));
}

// ── Submit order ──────────────────────────────────────────────────────────
async function submitOrder() {
  if (!draft.length) return showToast('Añade al menos un producto.');
  await saveOrder({ table: Number(tableSelect.value), items: draft, currency: currencySelect.value, status: 'pending', source: 'waiter' });
  draft = [];
  renderDraft();
  showToast('Comanda guardada y enviada a cocina. ✓');
  vibrate([60, 40, 100]);
  if (navigator.serviceWorker?.ready) {
    const reg = await navigator.serviceWorker.ready;
    reg.sync?.register('gastropulse-sync').catch(() => null);
  }
}

// ── Navigation ────────────────────────────────────────────────────────────
function setView(viewId) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === viewId));
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === viewId));
  if (viewId === 'kitchen-view') renderKitchen();
  if (viewId === 'customer-view') startLocationVerification();
}

// ── KDS tabs ──────────────────────────────────────────────────────────────
document.querySelectorAll('.kds-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.kds-tab').forEach((t) => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    const panel = tab.dataset.tab;
    document.querySelector('#kds-orders-panel').classList.toggle('hidden', panel !== 'orders');
    document.querySelector('#kds-incidents-panel').classList.toggle('hidden', panel !== 'incidents');
    if (panel === 'incidents') renderIncidents();
  });
});

// ── Kitchen KDS ───────────────────────────────────────────────────────────
let kdsTimer = null;

async function renderKitchen() {
  clearTimeout(kdsTimer);
  let orders = [];
  if (navigator.onLine) {
    try {
      const res = await fetch('/api/orders');
      if (res.ok) orders = await res.json();
    } catch (_) { /* fall through */ }
  }
  if (!orders.length) {
    const all = await getAll('comandas');
    orders = all.filter((o) => ['pending', 'preparing'].includes(o.status));
  }

  incomingCount.textContent = orders.length;
  navBadge.textContent = orders.length;
  document.querySelector('#nav-kitchen-count').textContent = orders.length;
  kdsLastUpdate.textContent = `Actualizado ${formatTime(new Date().toISOString())}`;

  const board = document.querySelector('#kds-board');
  if (!orders.length) {
    board.innerHTML = '<p class="empty-state" style="grid-column:1/-1;padding:2rem 0">No hay comandas activas.</p>';
  } else {
    board.innerHTML = orders.map((order) => `
      <article class="kds-card" data-order-id="${order.id}">
        <header>
          <div>
            <p class="eyebrow">COMANDA #${String(order.table).padStart(3, '0')}</p>
            <h3>Mesa ${order.table}</h3>
          </div>
          <span class="timer">${formatElapsed(order.updatedAt || order.createdAt || new Date().toISOString())}</span>
        </header>
        <div class="kds-items">
          ${order.items.map((it) => `
            <div class="kds-item">
              <b>${it.quantity}×</b>
              <span>${it.name}${it.notes ? `<small> · ${it.notes}</small>` : ''}</span>
            </div>`).join('')}
        </div>
        <div class="kds-actions">
          <button class="photo-button" data-incident="${order.table}">📷 Incidencia</button>
          <button class="ready-button" data-ready="${order.table}" data-order-id="${order.id}">✓ Listo</button>
        </div>
      </article>`).join('');
  }

  kdsTimer = setTimeout(() => {
    if (document.querySelector('#kitchen-view')?.classList.contains('active')) renderKitchen();
  }, 30_000);
}

document.querySelector('#kds-board').addEventListener('click', async (e) => {
  // Marcar listo → Caminante
  const readyBtn = e.target.closest('[data-ready]');
  if (readyBtn) {
    const table = readyBtn.dataset.ready;
    const orderId = readyBtn.dataset.orderId;
    readyBtn.disabled = true;
    readyBtn.textContent = '⏳…';

    bannerTable.textContent = table;
    bannerTime.textContent = `Cocina · ${formatTime(new Date().toISOString())}`;
    deliveryBanner.classList.add('visible');
    vibrate([100, 50, 100]);

    try {
      const res = await fetch('/api/push/kitchen-ready', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ table: Number(table), orderId }),
      });
      const data = await res.json();
      showToast(res.ok
        ? `Caminante activado · ${data.sent ?? 0} dispositivo(s) notificado(s).`
        : 'Caminante activado (push no configurado).');
    } catch (_) {
      showToast('Caminante activado (sin conexión al servidor).');
    }
    setTimeout(renderKitchen, 1500);
    return;
  }

  // Incidencia
  const incidentBtn = e.target.closest('[data-incident]');
  if (incidentBtn) {
    startIncidentCapture(Number(incidentBtn.dataset.incident));
  }
});

// ── Incident capture ──────────────────────────────────────────────────────
let incidentCancelRequested = false;

async function startIncidentCapture(table) {
  incidentCancelRequested = false;
  incidentOverlay.classList.remove('hidden');
  incidentCd.textContent = '3';

  try {
    // Show countdown while camera warms up
    let count = 3;
    const cdTimer = setInterval(() => {
      count--;
      incidentCd.textContent = count > 0 ? count : '📷';
      if (count <= 0) clearInterval(cdTimer);
    }, 1000);

    const result = await captureIncident({ previewEl: incidentVideo, captureDelayMs: 3000 });
    clearInterval(cdTimer);

    if (incidentCancelRequested) return;

    incidentOverlay.classList.add('hidden');

    const incident = await saveIncident({ table, photoDataUrl: result.dataUrl });
    showToast(`Incidencia de Mesa ${table} guardada. 📷`);
    vibrate([80, 40, 80]);

    // Refresh incident count badge
    await refreshIncidentBadge();

    // If the incidents tab is open, refresh it
    if (!document.querySelector('#kds-incidents-panel').classList.contains('hidden')) {
      renderIncidents();
    }
  } catch (err) {
    incidentOverlay.classList.add('hidden');
    showToast(`No se pudo capturar: ${err.message}`);
  }
}

document.querySelector('#incident-cancel').addEventListener('click', () => {
  incidentCancelRequested = true;
  incidentOverlay.classList.add('hidden');
  if (incidentVideo.srcObject) {
    incidentVideo.srcObject.getTracks().forEach((t) => t.stop());
    incidentVideo.srcObject = null;
  }
});

// ── Incidents panel ───────────────────────────────────────────────────────
async function refreshIncidentBadge() {
  const incidents = await getAll('incidencias');
  const count = incidents.length;
  document.querySelector('#incident-count').textContent = count;
  document.querySelector('#incidents-total').textContent = count;
  navBadge.textContent = Number(incomingCount.textContent) + count;
}

async function renderIncidents() {
  const incidents = (await getAll('incidencias'))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  document.querySelector('#incidents-total').textContent = incidents.length;
  document.querySelector('#incident-count').textContent = incidents.length;

  const board = document.querySelector('#incidents-board');
  if (!incidents.length) {
    board.innerHTML = '<p class="empty-state" style="padding:2rem 0">No hay incidencias registradas.</p>';
    return;
  }

  board.innerHTML = incidents.map((inc) => `
    <article class="incident-card" data-incident-id="${inc.id}">
      <div class="incident-photo">
        ${inc.photoDataUrl
          ? `<img src="${inc.photoDataUrl}" alt="Foto incidencia Mesa ${inc.table}" loading="lazy" />`
          : '<div class="incident-no-photo">Sin foto</div>'}
      </div>
      <div class="incident-info">
        <p class="eyebrow">MESA ${inc.table}</p>
        <strong>${formatTime(inc.createdAt)}</strong>
        <small>${new Date(inc.createdAt).toLocaleDateString('es-CO')}</small>
        ${inc.note ? `<p class="incident-note">${inc.note}</p>` : ''}
      </div>
      <button class="incident-delete" data-delete="${inc.id}" aria-label="Eliminar incidencia">✕</button>
    </article>`).join('');
}

document.querySelector('#incidents-board').addEventListener('click', async (e) => {
  const delBtn = e.target.closest('[data-delete]');
  if (!delBtn) return;
  await removeIncident(delBtn.dataset.delete);
  showToast('Incidencia eliminada.');
  renderIncidents();
  refreshIncidentBadge();
});

document.querySelector('#clear-incidents').addEventListener('click', async () => {
  if (!confirm('¿Borrar todas las incidencias?')) return;
  const incidents = await getAll('incidencias');
  for (const inc of incidents) await removeIncident(inc.id);
  showToast('Todas las incidencias eliminadas.');
  renderIncidents();
  refreshIncidentBadge();
});

// ── QR scan ───────────────────────────────────────────────────────────────
document.querySelector('#scan-qr').addEventListener('click', async () => {
  qrOverlay.classList.remove('hidden');
  try {
    const value = await scanQrCode(qrVideo);
    qrOverlay.classList.add('hidden');
    if (value) {
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
  } catch (err) {
    qrOverlay.classList.add('hidden');
    showToast(err.message);
  }
});

document.querySelector('#qr-cancel').addEventListener('click', () => {
  if (qrVideo.srcObject) { qrVideo.srcObject.getTracks().forEach((t) => t.stop()); qrVideo.srcObject = null; }
  qrOverlay.classList.add('hidden');
});

// ── GPS verification ──────────────────────────────────────────────────────
const RESTAURANT_COORDS = { latitude: 5.5353, longitude: -73.3678 }; // UPTC Tunja
const PERIMETER_RADIUS_M = 200;

async function startLocationVerification() {
  verifyCard.className = 'verification-card unverified';
  verifyIcon.textContent = '⟳';
  verifyLabel.textContent = 'Verificando ubicación…';
  verifyDetail.innerHTML = `Comprobando GPS · Mesa <span id="customer-table">${tableSelect.value}</span>`;
  customerVoiceBtn.disabled = true;
  try {
    const { verified, distance } = await sensors.verifyLocation(RESTAURANT_COORDS, PERIMETER_RADIUS_M);
    if (verified) {
      verifyCard.className = 'verification-card verified';
      verifyIcon.textContent = '✓';
      verifyLabel.textContent = 'Ubicación verificada';
      verifyDetail.innerHTML = `Dentro de GastroPulse · Mesa <span id="customer-table">${tableSelect.value}</span>`;
      customerVoiceBtn.disabled = false;
    } else {
      setVerifyFailed(`Estás a ${Math.round(distance)} m (máx. ${PERIMETER_RADIUS_M} m).`);
    }
  } catch (err) {
    setVerifyFailed(err.message);
  }
}

function setVerifyFailed(reason) {
  verifyCard.className = 'verification-card failed';
  verifyIcon.textContent = '✗';
  verifyLabel.textContent = 'Verificación fallida';
  verifyDetail.textContent = reason;
  customerVoiceBtn.disabled = true;
}

document.querySelector('#verify-location-btn').addEventListener('click', startLocationVerification);

// ── Voice ─────────────────────────────────────────────────────────────────
function showTranscript(el, text, isError = false) {
  el.textContent = text;
  el.className = `voice-transcript${isError ? ' error' : ''}${text ? '' : ' hidden'}`;
}

function initVoice() {
  // Shared handler for both mesero and customer voice
  function makeVoice(transcriptEl) {
    return createVoiceController({
      onState: (state, detail) => {
        const voiceBtn = document.querySelector('#voice-button');
        const isListening = state === 'listening';
        voiceBtn.classList.toggle('listening', isListening);
        customerVoiceBtn.classList.toggle('listening', isListening);

        if (state === 'idle') showTranscript(transcriptEl, '');
        if (state === 'error') {
          showTranscript(transcriptEl, detail || 'Error de voz.', true);
          showToast(detail || 'Error en reconocimiento de voz.');
        }
        if (state === 'unsupported') showToast('Dictado no disponible. Usa Chrome.');
      },
      onInterim: (partial) => {
        showTranscript(transcriptEl, `🎤 ${partial}`);
      },
      onResult: (transcript) => {
        showTranscript(transcriptEl, `✓ "${transcript}"`);
        const parsed = parseOrderSpeech(transcript, menu);
        if (!parsed.items.length) {
          showToast('No reconocí productos. Intenta: "dos cervezas y una hamburguesa"');
          return;
        }
        if (parsed.table) tableSelect.value = parsed.table;
        parsed.items.forEach((item) => {
          const product = menu.find((p) => p.id === item.productId);
          if (!product) return;
          const existing = draft.find((d) => d.productId === item.productId);
          if (existing) existing.quantity += item.quantity;
          else draft.push({ ...item, price: productPrice(product) });
        });
        renderDraft();
        const summary = parsed.items.map((i) => `${i.quantity}× ${i.name}`).join(', ');
        showToast(`Añadido: ${summary}`);
        vibrate([50, 30, 50]);
      },
    });
  }

  const waiterVoice = makeVoice(voiceTranscript);
  const customerVoiceCtrl = makeVoice(customerTranscript);

  document.querySelector('#voice-button').addEventListener('click', () => {
    if (waiterVoice.supported) waiterVoice.start();
    else showToast('Usa Chrome para activar el dictado.');
  });

  customerVoiceBtn.addEventListener('click', () => {
    if (customerVoiceCtrl.supported) {
      customerVoiceCtrl.start();
    } else {
      showToast('Usa Chrome para activar el dictado.');
    }
  });

  if (isVoiceSupported()) {
    document.querySelector('#voice-button').title = 'Dictar con Web Speech API';
  }
}

// ── SW messages ───────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'SYNC_COMPLETE') {
      showToast('Comandas sincronizadas. ✓');
      if (document.querySelector('#kitchen-view')?.classList.contains('active')) renderKitchen();
    }
  });
}

// ── Push button ───────────────────────────────────────────────────────────
document.querySelector('#push-toggle').addEventListener('click', async () => {
  try {
    await requestPushPermission();
    showToast('Notificaciones activadas. 🔔');
    document.querySelector('#push-toggle').textContent = '🔕';
    document.querySelector('#push-toggle').title = 'Notificaciones activadas';
  } catch (err) {
    showToast(err.message);
  }
});

// ── Init ──────────────────────────────────────────────────────────────────
async function init() {
  menu = await seedMenu();
  renderMenu();
  renderDraft();
  await refreshIncidentBadge();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(console.error);

  function updateOnlineStatus() {
    const online = navigator.onLine;
    connectionStatus.className = `status-pill ${online ? 'online' : 'offline'}`;
    connectionStatus.innerHTML = `<i>●</i> ${online ? 'Online' : 'Offline'}`;
    document.querySelector('#order-status').style.display = online ? 'none' : '';
  }
  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);
  updateOnlineStatus();

  document.querySelectorAll('.nav-item').forEach((btn) =>
    btn.addEventListener('click', () => setView(btn.dataset.view))
  );

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

  document.querySelector('#dismiss-delivery').addEventListener('click', () =>
    deliveryBanner.classList.remove('visible')
  );

  document.querySelector('#theme-toggle').addEventListener('click', () => {
    document.body.classList.toggle('dark');
    document.querySelector('#theme-toggle').textContent = document.body.classList.contains('dark') ? '☾' : '☼';
  });

  currencySelect.addEventListener('change', () => {
    draft = draft.map((item) => {
      const p = menu.find((m) => m.id === item.productId);
      return p ? { ...item, price: productPrice(p) } : item;
    });
    renderMenu();
    renderDraft();
  });

  document.querySelector('#customer-menu').addEventListener('click', () => setView('waiter-view'));

  sensors = setupSensors({
    onShake: () => {
      if (draft.length && confirm('¿Descartar el borrador de esta mesa?')) { draft = []; renderDraft(); }
    },
    onLightChange: (mode) => {
      document.body.classList.toggle('dark', mode === 'dining');
      document.querySelector('#theme-toggle').textContent = document.body.classList.contains('dark') ? '☾' : '☼';
    },
    onLocation: (verified) => { if (verified) showToast('Ubicación verificada. ✓'); },
  });

  initVoice();

  window.dispatchEvent(new Event(navigator.onLine ? 'online' : 'offline'));
}

init().catch((err) => showToast(`No se pudo iniciar GastroPulse: ${err.message}`));
