import { Router } from 'express';

// ---------------------------------------------------------------------------
// KV abstraction — Vercel KV in production, in-memory Maps in local dev.
// All KV writes use hset (atomic per key). Concurrent writes to different
// record IDs are safe; concurrent writes to the same ID are last-write-wins,
// which is acceptable for restaurant operations.
// ---------------------------------------------------------------------------

let kv = null;
if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
  const { createClient } = await import('@vercel/kv');
  kv = createClient({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
}

// ── Generic KV hash helpers ───────────────────────────────────────────────
async function kvHset(hashKey, id, value) {
  const record = { ...value, id, updatedAt: value.updatedAt || new Date().toISOString() };
  if (kv) {
    await kv.hset(hashKey, { [id]: JSON.stringify(record) });
  } else {
    fallback.get(hashKey)?.set(id, record);
  }
  return record;
}

async function kvHgetall(hashKey) {
  if (kv) {
    const hash = await kv.hgetall(hashKey);
    if (!hash) return [];
    return Object.values(hash).map((v) => (typeof v === 'string' ? JSON.parse(v) : v));
  }
  return [...(fallback.get(hashKey)?.values() ?? [])];
}

async function kvHget(hashKey, id) {
  if (kv) {
    const raw = await kv.hget(hashKey, id);
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  }
  return fallback.get(hashKey)?.get(id) ?? null;
}

async function kvHdel(hashKey, id) {
  if (kv) {
    await kv.hdel(hashKey, id);
  } else {
    fallback.get(hashKey)?.delete(id);
  }
}

// In-memory fallback stores (dev only)
const fallback = new Map([
  ['push:subscriptions:set', new Set()],
  ['orders', new Map()],
  ['complaints', new Map()],
]);

async function addSubscription(raw) {
  if (kv) {
    await kv.sadd('push:subscriptions', raw);
  } else {
    fallback.get('push:subscriptions:set').add(raw);
  }
}

async function getAllSubscriptions() {
  if (kv) return kv.smembers('push:subscriptions');
  return [...fallback.get('push:subscriptions:set')];
}

// ── Push helper ───────────────────────────────────────────────────────────
async function sendPushToAll(webpush, title, body, url = '/') {
  const subs = await getAllSubscriptions();
  if (!subs.length) return 0;
  const payload = JSON.stringify({ title, body, url });
  const results = await Promise.allSettled(
    subs.map((raw) => webpush.sendNotification(JSON.parse(raw), payload))
  );
  return results.filter((r) => r.status === 'fulfilled').length;
}

export function createApiRouter({ webpush, vapidKeys }) {
  const router = Router();

  // ── Health ────────────────────────────────────────────────────────────────
  router.get('/health', (_req, res) =>
    res.json({ ok: true, service: 'gastropulse', pushConfigured: Boolean(vapidKeys), kvConfigured: Boolean(kv) })
  );

  // ── Push: VAPID public key ────────────────────────────────────────────────
  router.get('/push/public-key', (_req, res) => {
    if (!vapidKeys) return res.status(503).json({ error: 'Web Push no configurado.' });
    res.json({ publicKey: vapidKeys.publicKey });
  });

  // ── Push: subscribe ───────────────────────────────────────────────────────
  router.post('/push/subscribe', async (req, res) => {
    const sub = req.body;
    if (!sub?.endpoint) return res.status(400).json({ error: 'Suscripción inválida.' });
    await addSubscription(JSON.stringify(sub));
    res.status(201).json({ subscribed: true });
  });

  // ── Push: notify (generic — used by Caminante, complaints, late orders) ───
  router.post('/push/notify', async (req, res, next) => {
    if (!vapidKeys) return res.status(503).json({ error: 'Web Push no configurado.' });
    try {
      const { title = 'GastroPulse', body = '', url = '/' } = req.body;
      const sent = await sendPushToAll(webpush, title, body, url);
      res.json({ sent });
    } catch (err) { next(err); }
  });

  // ── Push: kitchen ready (Caminante) ──────────────────────────────────────
  router.post('/push/kitchen-ready', async (req, res, next) => {
    if (!vapidKeys) return res.status(503).json({ error: 'Web Push no configurado.' });
    try {
      const { table = '?', orderId, title, body } = req.body;
      if (orderId) {
        const order = await kvHget('orders', orderId);
        if (order) await kvHset('orders', orderId, { ...order, status: 'served' });
      }
      const pushTitle = title || 'GastroPulse · Caminante';
      const pushBody  = body  || `La comanda de la Mesa ${table} está lista para servir.`;
      const sent = await sendPushToAll(webpush, pushTitle, pushBody, '/');
      res.json({ sent, table });
    } catch (err) { next(err); }
  });

  // ── Orders: create (Background Sync) ─────────────────────────────────────
  router.post('/orders', async (req, res, next) => {
    try {
      const orders = Array.isArray(req.body) ? req.body : [req.body];
      const saved = [];
      for (const order of orders) {
        if (!order?.id || !order?.items?.length) continue;
        const record = {
          ...order,
          status: order.status || 'pending',
          createdAt: order.createdAt || new Date().toISOString(),
          receivedAt: new Date().toISOString(),
        };
        await kvHset('orders', record.id, record);
        saved.push(record.id);
      }
      res.status(201).json({ saved: saved.length, ids: saved });
    } catch (err) { next(err); }
  });

  // ── Orders: list active ───────────────────────────────────────────────────
  router.get('/orders', async (_req, res, next) => {
    try {
      const all = await kvHgetall('orders');
      const active = all
        .filter((o) => ['pending', 'preparing'].includes(o.status))
        .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
      res.json(active);
    } catch (err) { next(err); }
  });

  // ── Orders: update status ─────────────────────────────────────────────────
  router.patch('/orders/:id', async (req, res, next) => {
    try {
      const { status } = req.body;
      if (!['pending', 'preparing', 'ready', 'served'].includes(status)) {
        return res.status(400).json({ error: 'Estado inválido.' });
      }
      const order = await kvHget('orders', req.params.id);
      if (!order) return res.status(404).json({ error: 'Orden no encontrada.' });
      const updated = await kvHset('orders', req.params.id, { ...order, status });
      res.json(updated);
    } catch (err) { next(err); }
  });

  // ── Complaints: create ────────────────────────────────────────────────────
  // Accepts metadata only — no photo (too large for KV).
  // The photo stays in the client's IndexedDB; the server stores the reference.
  router.post('/complaints', async (req, res, next) => {
    try {
      const { id, table, note, source, createdAt } = req.body;
      if (!table) return res.status(400).json({ error: 'Mesa requerida.' });
      const record = {
        id: id || crypto.randomUUID(),
        table: Number(table),
        note: note || '',
        source: source || 'customer',
        hasPhoto: Boolean(req.body.hasPhoto),
        createdAt: createdAt || new Date().toISOString(),
      };
      await kvHset('complaints', record.id, record);

      // Notify kitchen via push
      if (vapidKeys) {
        const pushTitle = source === 'customer' ? 'GastroPulse · Queja de cliente' : 'GastroPulse · Incidencia';
        const pushBody  = `Mesa ${table}: ${note || 'El cliente reportó un problema.'}`;
        sendPushToAll(webpush, pushTitle, pushBody, '/').catch(() => null);
      }

      res.status(201).json(record);
    } catch (err) { next(err); }
  });

  // ── Complaints: list ──────────────────────────────────────────────────────
  router.get('/complaints', async (_req, res, next) => {
    try {
      const all = await kvHgetall('complaints');
      const sorted = all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      res.json(sorted);
    } catch (err) { next(err); }
  });

  // ── Complaints: delete ────────────────────────────────────────────────────
  router.delete('/complaints/:id', async (req, res, next) => {
    try {
      await kvHdel('complaints', req.params.id);
      res.json({ deleted: req.params.id });
    } catch (err) { next(err); }
  });

  return router;
}
