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
    ? draft.map((item, idx) => `
        <div class="draft-line">
          <div class="draft-line-info">
            <span class="draft-name">${item.name}</span>
            ${item.notes ? `<small class="draft-notes">${item.notes}</small>` : ''}
          </div>
          <div class="draft-line-controls">
            <button class="draft-qty-btn" data-action="dec" data-idx="${idx}" aria-label="Reducir cantidad">−</button>
            <span class="draft-qty">${item.quantity}</span>
            <button class="draft-qty-btn" data-action="inc" data-idx="${idx}" aria-label="Aumentar cantidad">+</button>
            <span class="draft-subtotal">${money(item.price * item.quantity)}</span>
            <button class="draft-remove" data-action="remove" data-idx="${idx}" aria-label="Eliminar ${item.name}">✕</button>
          </div>
        </div>`).join('')
    : '<p class="empty-state">Añade productos o dicta tu comanda.</p>';
  draftTotalEl.textContent = money(draft.reduce((s, i) => s + i.price * i.quantity, 0));
}

// Delegated handler for draft item controls
draftItemsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const idx = Number(btn.dataset.idx);
  const action = btn.dataset.action;
  if (action === 'inc') {
    draft[idx].quantity += 1;
    vibrate(25);
  } else if (action === 'dec') {
    if (draft[idx].quantity > 1) {
      draft[idx].quantity -= 1;
      vibrate(25);
    } else {
      draft.splice(idx, 1); // remove when reaches 0
      vibrate([40, 20]);
    }
  } else if (action === 'remove') {
    draft.splice(idx, 1);
    vibrate([40, 20]);
  }
  renderDraft();
});

// ── Submit order ──────────────────────────────────────────────────────────
async function submitOrder(source = 'waiter') {
  if (!draft.length) return showToast('Añade al menos un producto.');
  const order = await saveOrder({
    table: Number(tableSelect.value),
    items: draft,
    currency: currencySelect.value,
    status: 'pending',
    source,
  });
  draft = [];
  renderDraft();
  showToast('Comanda guardada y enviada a cocina. ✓');
  vibrate([60, 40, 100]);
  if (navigator.serviceWorker?.ready) {
    const reg = await navigator.serviceWorker.ready;
    reg.sync?.register('gastropulse-sync').catch(() => null);
  }
  // Start wait timer whenever a customer submits their own order
  if (source === 'customer') {
    startWaitTimer(Number(tableSelect.value));
  }
  return order;
}

// ── Navigation ────────────────────────────────────────────────────────────
function setView(viewId) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === viewId));
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === viewId));
  if (viewId === 'kitchen-view') renderKitchen();
  if (viewId === 'customer-view') {
    startLocationVerification();
    checkPendingOrderTimer();
  }
}

// If the customer has a recent pending order, resume the wait timer
async function checkPendingOrderTimer() {
  const all = await getAll('comandas');
  const table = Number(tableSelect.value);
  const recent = all
    .filter((o) => o.table === table && o.status === 'pending' && o.source === 'customer')
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
  if (!recent) return;
  const ageMs = Date.now() - new Date(recent.updatedAt).getTime();
  const totalMs = WAIT_MINUTES * 60 * 1000;
  if (ageMs < totalMs * 1.5) {
    // Resume timer based on when the order was placed
    startWaitTimerFromTimestamp(table, new Date(recent.updatedAt).getTime());
  }
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
    // Always refresh the incidents panel when switching to it
    if (panel === 'incidents') renderIncidents();
    if (panel === 'orders') renderKitchen();
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
  let incidents = [];
  try {
    // Always read local IndexedDB (has photos)
    const local = await getAll('incidencias');

    // Merge with server complaints (visible across devices)
    let server = [];
    if (navigator.onLine) {
      try {
        const res = await fetch('/api/complaints');
        if (res.ok) server = await res.json();
      } catch (_) { /* offline */ }
    }

    // Merge: server records take precedence, local adds photos
    const merged = new Map();
    server.forEach((s) => merged.set(s.id, { ...s, photoDataUrl: null }));
    local.forEach((l) => {
      if (merged.has(l.id)) {
        // Enrich server record with local photo
        merged.set(l.id, { ...merged.get(l.id), photoDataUrl: l.photoDataUrl });
      } else {
        // Local-only (offline or staff incident)
        merged.set(l.id, l);
      }
    });

    incidents = [...merged.values()]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch (err) {
    console.error('Error leyendo incidencias:', err);
  }

  const count = incidents.length;
  document.querySelector('#incidents-total').textContent = count;
  document.querySelector('#incident-count').textContent = count;

  const board = document.querySelector('#incidents-board');
  if (!count) {
    board.innerHTML = `
      <div class="incidents-empty">
        <span class="incidents-empty-icon">📷</span>
        <p>No hay incidencias registradas.</p>
        <small>Usa el botón "📷 Incidencia" en una comanda o "Reportar problema" en la vista Cliente.</small>
      </div>`;
    return;
  }

  board.innerHTML = incidents.map((inc) => {
    const isCustomer = inc.source === 'customer';
    const badge = isCustomer
      ? `<span class="incident-source-badge source-customer">CLIENTE</span>`
      : `<span class="incident-source-badge source-staff">COCINA</span>`;
    const serverOnlyNote = !inc.photoDataUrl && inc.hasPhoto
      ? `<p class="incident-note" style="color:var(--accent)">📷 Foto guardada en el dispositivo del cliente</p>`
      : '';
    return `
    <article class="incident-card${isCustomer ? ' incident-customer' : ''}" data-incident-id="${inc.id}">
      <div class="incident-photo">
        ${inc.photoDataUrl
          ? `<img src="${inc.photoDataUrl}" alt="Foto incidencia Mesa ${inc.table}" />`
          : `<div class="incident-no-photo"><span>${inc.hasPhoto ? '🖼' : '📷'}</span><small>${inc.hasPhoto ? 'Foto en dispositivo cliente' : 'Sin foto'}</small></div>`}
        ${badge}
      </div>
      <div class="incident-info">
        <p class="eyebrow" style="margin-top:4px">MESA ${inc.table}</p>
        <strong class="incident-time">${formatTime(inc.createdAt)}</strong>
        <small class="incident-date">${new Date(inc.createdAt).toLocaleDateString('es-CO', { day:'2-digit', month:'short', year:'numeric' })}</small>
        ${inc.note ? `<p class="incident-note">"${inc.note}"</p>` : ''}
        ${serverOnlyNote}
      </div>
      <button class="incident-delete" data-delete="${inc.id}" data-server="${isCustomer}" aria-label="Eliminar incidencia">✕</button>
    </article>`;
  }).join('');
}

document.querySelector('#incidents-board').addEventListener('click', async (e) => {
  const delBtn = e.target.closest('[data-delete]');
  if (!delBtn) return;
  const id = delBtn.dataset.delete;
  const isServer = delBtn.dataset.server === 'true';
  // Remove locally
  await removeIncident(id).catch(() => null);
  // Remove from server if it was synced
  if (isServer && navigator.onLine) {
    fetch(`/api/complaints/${id}`, { method: 'DELETE' }).catch(() => null);
  }
  showToast('Incidencia eliminada.');
  renderIncidents();
  refreshIncidentBadge();
});

document.querySelector('#clear-incidents').addEventListener('click', async () => {
  if (!confirm('¿Borrar todas las incidencias?')) return;
  const local = await getAll('incidencias');
  for (const inc of local) await removeIncident(inc.id).catch(() => null);
  // Also clear server complaints
  if (navigator.onLine) {
    try {
      const res = await fetch('/api/complaints');
      if (res.ok) {
        const serverList = await res.json();
        await Promise.allSettled(
          serverList.map((c) => fetch(`/api/complaints/${c.id}`, { method: 'DELETE' }))
        );
      }
    } catch (_) { /* best effort */ }
  }
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
  const currentTable = tableSelect.value;   // snapshot at call time
  verifyCard.className = 'verification-card unverified';
  verifyIcon.textContent = '⟳';
  verifyLabel.textContent = 'Verificando ubicación…';
  verifyDetail.innerHTML = `Buscando señal GPS · Mesa ${currentTable}`;
  document.querySelector('#verify-location-btn').disabled = true;
  document.querySelector('#verify-location-btn').textContent = 'Verificando…';
  customerVoiceBtn.disabled = true;
  try {
    const { verified, distance } = await sensors.verifyLocation(RESTAURANT_COORDS, PERIMETER_RADIUS_M);
    if (verified) {
      verifyCard.className = 'verification-card verified';
      verifyIcon.textContent = '✓';
      verifyLabel.textContent = 'Ubicación verificada · listo para pedir';
      verifyDetail.innerHTML = `Estás dentro del restaurante · Mesa ${currentTable}`;
      customerVoiceBtn.disabled = false;
      document.querySelector('#customer-voice-hint').textContent = 'Di tu pedido y te lo preparamos al instante.';
    } else {
      setVerifyFailed(
        `Estás a ${Math.round(distance)} m del restaurante.`,
        `El pedido por voz requiere estar dentro del local (máx. ${PERIMETER_RADIUS_M} m).`
      );
    }
  } catch (err) {
    if (err.message.includes('denied') || err.message.includes('PERMISSION')) {
      setVerifyFailed(
        'Permiso de ubicación denegado.',
        'Ve a Configuración del navegador → Permisos → Ubicación y permite el acceso.'
      );
    } else {
      setVerifyFailed('No se pudo obtener ubicación.', err.message);
    }
  } finally {
    document.querySelector('#verify-location-btn').disabled = false;
    document.querySelector('#verify-location-btn').textContent = 'Reintentar';
  }
}

function setVerifyFailed(title, detail = '') {
  verifyCard.className = 'verification-card failed';
  verifyIcon.textContent = '✗';
  verifyLabel.textContent = title;
  verifyDetail.textContent = detail;
  customerVoiceBtn.disabled = true;
}

document.querySelector('#verify-location-btn').addEventListener('click', startLocationVerification);

// ── Order wait timer ──────────────────────────────────────────────────────
const WAIT_MINUTES = 15;
let waitInterval = null;

function startWaitTimer(table) {
  startWaitTimerFromTimestamp(table, Date.now());
}

function startWaitTimerFromTimestamp(table, startTs) {
  const card        = document.querySelector('#wait-timer-card');
  const fill        = document.querySelector('#wait-progress-fill');
  const countdown   = document.querySelector('#wait-countdown');
  const estimatedEl = document.querySelector('#wait-estimated');
  const overdueEl   = document.querySelector('#wait-overdue');
  const reportBtn   = document.querySelector('#wait-report-btn');
  const reportedEl  = document.querySelector('#wait-reported');

  clearInterval(waitInterval);
  overdueEl.classList.add('hidden');
  reportedEl.classList.add('hidden');
  reportBtn.disabled = false;
  reportBtn.classList.remove('hidden');

  const totalMs = WAIT_MINUTES * 60 * 1000;
  estimatedEl.textContent = `${WAIT_MINUTES} min`;
  card.classList.remove('hidden');

  function tick() {
    const elapsed   = Date.now() - startTs;
    const remaining = Math.max(0, totalMs - elapsed);
    const pct       = Math.min(100, (elapsed / totalMs) * 100);

    fill.style.width      = `${pct}%`;
    fill.style.background = pct >= 100 ? 'var(--danger)' : pct > 70 ? 'var(--accent)' : 'var(--mint)';

    const mins = String(Math.floor(remaining / 60000)).padStart(2, '0');
    const secs = String(Math.floor((remaining % 60000) / 1000)).padStart(2, '0');
    countdown.textContent  = remaining > 0 ? `${mins}:${secs}` : '¡Tiempo!';
    countdown.style.color  = remaining === 0 ? 'var(--danger)' : '';

    if (remaining === 0) {
      clearInterval(waitInterval);
      overdueEl.classList.remove('hidden');
      vibrate([200, 100, 200]);
      showToast('⏰ El tiempo estimado de tu pedido venció.');
    }
  }

  tick();
  waitInterval = setInterval(tick, 1000);

  // Clone button to remove old listeners before adding a new one
  const freshBtn = reportBtn.cloneNode(true);
  reportBtn.parentNode.replaceChild(freshBtn, freshBtn); // no-op needed for reference
  document.querySelector('#wait-report-btn').addEventListener('click', async () => {
    const btn = document.querySelector('#wait-report-btn');
    btn.disabled = true;
    try {
      const localInc = await saveIncident({
        table,
        note: `Pedido no llegó pasados ${WAIT_MINUTES} minutos.`,
        source: 'customer',
      });
      if (navigator.onLine) {
        fetch('/api/complaints', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: localInc.id,
            table: localInc.table,
            note: localInc.note,
            source: localInc.source,
            hasPhoto: false,
            createdAt: localInc.createdAt,
          }),
        }).catch(() => null);
      }
      document.querySelector('#wait-reported').classList.remove('hidden');
      btn.classList.add('hidden');
      vibrate([80, 40, 80]);
      await refreshIncidentBadge();
    } catch (err) {
      btn.disabled = false;
      showToast(`Error al enviar aviso: ${err.message}`);
    }
  }, { once: true });
}

// ── Customer complaint flow ───────────────────────────────────────────────
function initComplaintFlow() {
  const photoBtn       = document.querySelector('#complaint-photo-btn');
  const sendBtn        = document.querySelector('#complaint-send-btn');
  const retakeBtn      = document.querySelector('#complaint-retake');
  const noteEl         = document.querySelector('#complaint-note');
  const counterEl      = document.querySelector('#complaint-note-counter');
  const previewWrap    = document.querySelector('#complaint-preview');
  const previewImg     = document.querySelector('#complaint-img');
  const liveVideo      = document.querySelector('#complaint-live-video');
  const camControls    = document.querySelector('#complaint-cam-controls');
  const captureNowBtn  = document.querySelector('#complaint-capture-now');
  const camCancelBtn   = document.querySelector('#complaint-cam-cancel');
  const statusEl       = document.querySelector('#complaint-status');

  let capturedDataUrl = null;
  let activeStream    = null;

  noteEl.addEventListener('input', () => {
    counterEl.textContent = `${noteEl.value.length} / 200`;
    updateSendBtn();
  });

  function updateSendBtn() {
    sendBtn.disabled = !capturedDataUrl && !noteEl.value.trim();
  }

  function stopStream() {
    if (activeStream) { activeStream.getTracks().forEach((t) => t.stop()); activeStream = null; }
    liveVideo.srcObject = null;
  }

  // ── Open camera → show live preview ──────────────────────────────────
  photoBtn.addEventListener('click', async () => {
    photoBtn.disabled = true;
    photoBtn.textContent = '⏳ Iniciando cámara…';
    try {
      activeStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      liveVideo.srcObject = activeStream;
      liveVideo.muted = true;
      await liveVideo.play();

      // Show live video + controls, hide static img
      previewWrap.classList.remove('hidden');
      liveVideo.classList.remove('hidden');
      previewImg.classList.add('hidden');
      camControls.classList.remove('hidden');
      retakeBtn.classList.add('hidden');
      photoBtn.textContent = '📷 Tomar foto';
    } catch (err) {
      photoBtn.disabled = false;
      photoBtn.textContent = '📷 Tomar foto';
      showToast(`Cámara no disponible: ${err.message}`);
    }
  });

  // ── Capture frame manually ────────────────────────────────────────────
  captureNowBtn.addEventListener('click', () => {
    if (!activeStream) return;
    const canvas = document.createElement('canvas');
    canvas.width  = liveVideo.videoWidth  || 640;
    canvas.height = liveVideo.videoHeight || 480;
    canvas.getContext('2d').drawImage(liveVideo, 0, 0, canvas.width, canvas.height);
    capturedDataUrl = canvas.toDataURL('image/jpeg', 0.82);
    stopStream();

    // Show static captured image
    previewImg.src = capturedDataUrl;
    previewImg.classList.remove('hidden');
    liveVideo.classList.add('hidden');
    camControls.classList.add('hidden');
    retakeBtn.classList.remove('hidden');
    photoBtn.textContent = '✓ Foto tomada';
    updateSendBtn();
  });

  // ── Cancel camera without capturing ──────────────────────────────────
  camCancelBtn.addEventListener('click', () => {
    stopStream();
    previewWrap.classList.add('hidden');
    liveVideo.classList.add('hidden');
    camControls.classList.add('hidden');
    photoBtn.disabled = false;
    photoBtn.textContent = '📷 Tomar foto';
  });

  // ── Retake ────────────────────────────────────────────────────────────
  retakeBtn.addEventListener('click', () => {
    capturedDataUrl = null;
    previewImg.src = '';
    previewImg.classList.add('hidden');
    retakeBtn.classList.add('hidden');
    photoBtn.disabled = false;
    photoBtn.textContent = '📷 Tomar foto';
    updateSendBtn();
    photoBtn.click(); // reopen camera immediately
  });

  // ── Send complaint ────────────────────────────────────────────────────
  sendBtn.addEventListener('click', async () => {
    const note = noteEl.value.trim();
    if (!capturedDataUrl && !note) return;
    stopStream();
    sendBtn.disabled = true;
    sendBtn.textContent = '⏳ Enviando…';
    statusEl.className = 'complaint-status hidden';

    try {
      const localIncident = await saveIncident({
        table: Number(tableSelect.value),
        photoDataUrl: capturedDataUrl,
        note,
        source: 'customer',
      });

      // Send metadata to server so kitchen sees it on any device/tab.
      // Photo stays in local IndexedDB (too large for KV).
      if (navigator.onLine) {
        fetch('/api/complaints', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: localIncident.id,
            table: localIncident.table,
            note: localIncident.note,
            source: localIncident.source,
            hasPhoto: Boolean(capturedDataUrl),
            createdAt: localIncident.createdAt,
          }),
        }).catch(() => null);
      }

      // Reset form
      noteEl.value = '';
      counterEl.textContent = '0 / 200';
      capturedDataUrl = null;
      previewWrap.classList.add('hidden');
      previewImg.src = '';
      photoBtn.disabled = false;
      photoBtn.textContent = '📷 Tomar foto';
      sendBtn.textContent = 'Enviar queja →';
      updateSendBtn();

      statusEl.className = 'complaint-status success';
      statusEl.textContent = '✓ Tu queja fue recibida. El equipo la está revisando.';
      vibrate([80, 40, 80]);
      await refreshIncidentBadge();
    } catch (err) {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Enviar queja →';
      statusEl.className = 'complaint-status error';
      statusEl.textContent = `No se pudo enviar: ${err.message}`;
    }
  });
}

// ── Voice ─────────────────────────────────────────────────────────────────
function showTranscript(el, text, isError = false) {
  el.textContent = text;
  el.className = `voice-transcript${isError ? ' error' : ''}${text ? '' : ' hidden'}`;
}

function initVoice() {
  const voiceBtn = document.querySelector('#voice-button');

  // ── Waiter voice ──────────────────────────────────────────────────────
  const waiterVoice = createVoiceController({
    onState: (state, detail) => {
      voiceBtn.classList.toggle('listening', state === 'listening');
      if (state === 'idle') showTranscript(voiceTranscript, '');
      if (state === 'error') { showTranscript(voiceTranscript, detail || 'Error de voz.', true); showToast(detail || 'Error en reconocimiento de voz.'); }
      if (state === 'unsupported') showToast('Dictado no disponible. Usa Chrome.');
    },
    onInterim: (partial) => showTranscript(voiceTranscript, `🎤 ${partial}`),
    onResult: (transcript) => {
      showTranscript(voiceTranscript, `✓ "${transcript}"`);
      const parsed = parseOrderSpeech(transcript, menu);
      if (!parsed.items.length) { showToast('No reconocí productos. Intenta: "dos cervezas y una hamburguesa"'); return; }
      if (parsed.table) tableSelect.value = parsed.table;
      parsed.items.forEach((item) => {
        const product = menu.find((p) => p.id === item.productId);
        if (!product) return;
        const existing = draft.find((d) => d.productId === item.productId);
        if (existing) existing.quantity += item.quantity;
        else draft.push({ ...item, price: productPrice(product) });
      });
      renderDraft();
      showToast(`Añadido: ${parsed.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}`);
      vibrate([50, 30, 50]);
    },
  });

  voiceBtn.addEventListener('click', () => {
    if (waiterVoice.supported) waiterVoice.start();
    else showToast('Usa Chrome para activar el dictado.');
  });

  // ── Customer voice ────────────────────────────────────────────────────
  const customerVoice = createVoiceController({
    onState: (state, detail) => {
      customerVoiceBtn.classList.toggle('listening', state === 'listening');
      if (state === 'idle') showTranscript(customerTranscript, '');
      if (state === 'error') { showTranscript(customerTranscript, detail || 'Error de voz.', true); showToast(detail || 'Error en reconocimiento de voz.'); }
      if (state === 'unsupported') showToast('Dictado no disponible. Usa Chrome.');
    },
    onInterim: (partial) => showTranscript(customerTranscript, `🎤 ${partial}`),
    onResult: async (transcript) => {
      showTranscript(customerTranscript, `✓ "${transcript}"`);
      const parsed = parseOrderSpeech(transcript, menu);
      if (!parsed.items.length) { showToast('No reconocí productos. Di por ejemplo: "dos cervezas"'); return; }
      // Add to draft and auto-submit as customer order
      parsed.items.forEach((item) => {
        const product = menu.find((p) => p.id === item.productId);
        if (!product) return;
        const existing = draft.find((d) => d.productId === item.productId);
        if (existing) existing.quantity += item.quantity;
        else draft.push({ ...item, price: productPrice(product) });
      });
      renderDraft();
      showToast(`Añadido: ${parsed.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}`);
      await submitOrder('customer');
    },
  });

  customerVoiceBtn.addEventListener('click', () => {
    if (customerVoice.supported) customerVoice.start();
    else showToast('Usa Chrome para activar el dictado.');
  });

  if (isVoiceSupported()) voiceBtn.title = 'Dictar con Web Speech API';
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

  document.querySelector('#customer-menu').addEventListener('click', () => {
    const panel = document.querySelector('#customer-menu-panel');
    const grid  = document.querySelector('#customer-menu-grid');
    // Render read-only menu cards
    grid.innerHTML = menu.map((item) => `
      <div class="customer-menu-card">
        <span class="customer-menu-emoji">${item.emoji}</span>
        <div class="customer-menu-info">
          <strong>${item.name}</strong>
          <small>${item.description}</small>
        </div>
        <span class="customer-menu-price">${money(productPrice(item))}</span>
      </div>`).join('');
    panel.classList.remove('hidden');
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  document.querySelector('#customer-menu-close').addEventListener('click', () => {
    document.querySelector('#customer-menu-panel').classList.add('hidden');
  });

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
  initComplaintFlow();

  // ── Handle URL params from QR scan (?view=customer&mesa=N) ──────────
  // Must run AFTER sensors is initialized and AFTER all event listeners
  const params = new URLSearchParams(location.search);
  const qrMesa = params.get('mesa');
  const qrView = params.get('view');
  if (qrMesa) {
    // Add option dynamically if mesa number isn't in the predefined list
    if (!tableSelect.querySelector(`option[value="${qrMesa}"]`)) {
      const opt = document.createElement('option');
      opt.value = qrMesa;
      opt.textContent = `Mesa ${qrMesa}`;
      tableSelect.appendChild(opt);
    }
    tableSelect.value = qrMesa;
    // Update all customer-table displays
    document.querySelectorAll('#customer-table').forEach((el) => { el.textContent = qrMesa; });
    renderDraft();
  }
  if (qrView === 'customer') setView('customer-view');
  else if (qrView === 'kitchen') setView('kitchen-view');

  window.dispatchEvent(new Event(navigator.onLine ? 'online' : 'offline'));
}

init().catch((err) => showToast(`No se pudo iniciar GastroPulse: ${err.message}`));
