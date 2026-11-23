import { Router } from 'express';

// ---------------------------------------------------------------------------
// Subscription store abstraction
// In production (Vercel) we use the KV store so subscriptions survive across
// serverless function instances. In local dev we fall back to an in-memory Set.
// ---------------------------------------------------------------------------

let kv = null;
if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
  const { createClient } = await import('@vercel/kv');
  kv = createClient({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
}

const SUBS_KEY = 'push:subscriptions';
const ORDERS_KEY = 'orders';

async function addSubscription(raw) {
  if (kv) {
    await kv.sadd(SUBS_KEY, raw);
  } else {
    fallbackSubscriptions.add(raw);
  }
}

async function getAllSubscriptions() {
  if (kv) {
    return kv.smembers(SUBS_KEY);
  }
  return [...fallbackSubscriptions];
}

async function saveOrderToStore(order) {
  if (kv) {
    await kv.hset(ORDERS_KEY, { [order.id]: JSON.stringify(order) });
  } else {
    fallbackOrders.set(order.id, order);
  }
}

async function getAllOrders() {
  if (kv) {
    const hash = await kv.hgetall(ORDERS_KEY);
    if (!hash) return [];
    return Object.values(hash).map((v) => (typeof v === 'string' ? JSON.parse(v) : v));
  }
  return [...fallbackOrders.values()];
}

async function updateOrderStatus(id, status) {
  if (kv) {
    const raw = await kv.hget(ORDERS_KEY, id);
    if (!raw) return null;
    const order = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const updated = { ...order, status, updatedAt: new Date().toISOString() };
    await kv.hset(ORDERS_KEY, { [id]: JSON.stringify(updated) });
    return updated;
  }
  const order = fallbackOrders.get(id);
  if (!order) return null;
  const updated = { ...order, status, updatedAt: new Date().toISOString() };
  fallbackOrders.set(id, updated);
  return updated;
}

// Used only when KV is not configured (local dev / demo deploy).
const fallbackSubscriptions = new Set();
const fallbackOrders = new Map();

export function createApiRouter({ webpush, vapidKeys }) {
  const router = Router();

  // ── Health ────────────────────────────────────────────────────────────────
  router.get('/health', (_req, res) =>
    res.json({ ok: true, service: 'gastropulse', pushConfigured: Boolean(vapidKeys), kvConfigured: Boolean(kv) })
  );

  // ── Push: VAPID public key ────────────────────────────────────────────────
  router.get('/push/public-key', (_req, res) => {
    if (!vapidKeys) return res.status(503).json({ error: 'Web Push no configurado. Define VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY.' });
    res.json({ publicKey: vapidKeys.publicKey });
  });

  // ── Push: subscribe ───────────────────────────────────────────────────────
  router.post('/push/subscribe', async (req, res) => {
    const subscription = req.body;
    if (!subscription?.endpoint) return res.status(400).json({ error: 'Suscripción inválida.' });
    await addSubscription(JSON.stringify(subscription));
    res.status(201).json({ subscribed: true });
  });

  // ── Push: kitchen ready (Caminante) ──────────────────────────────────────
  router.post('/push/kitchen-ready', async (req, res, next) => {
    if (!vapidKeys) return res.status(503).json({ error: 'Web Push no configurado.' });
    try {
      const table = req.body?.table || '?';
      const orderId = req.body?.orderId;

      // Mark the order as served in the store
      if (orderId) await updateOrderStatus(orderId, 'served').catch(() => null);

      const payload = JSON.stringify({
        title: 'GastroPulse · Caminante',
        body: `La comanda de la Mesa ${table} está lista para servir.`,
        url: '/',
      });
      const subs = await getAllSubscriptions();
      const results = await Promise.allSettled(
        subs.map((raw) => webpush.sendNotification(JSON.parse(raw), payload))
      );
      res.json({ sent: results.filter((r) => r.status === 'fulfilled').length, table });
    } catch (error) {
      next(error);
    }
  });

  // ── Orders: receive synced orders from Background Sync ───────────────────
  router.post('/orders', async (req, res, next) => {
    try {
      const orders = Array.isArray(req.body) ? req.body : [req.body];
      const saved = [];
      for (const order of orders) {
        if (!order?.id || !order?.items?.length) continue;
        const record = { ...order, receivedAt: new Date().toISOString(), status: order.status || 'pending' };
        await saveOrderToStore(record);
        saved.push(record.id);
      }
      res.status(201).json({ saved: saved.length, ids: saved });
    } catch (error) {
      next(error);
    }
  });

  // ── Orders: list all orders (used by KDS) ────────────────────────────────
  router.get('/orders', async (_req, res, next) => {
    try {
      const orders = await getAllOrders();
      // Return pending + preparing orders, sorted newest first
      const active = orders
        .filter((o) => ['pending', 'preparing'].includes(o.status))
        .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
      res.json(active);
    } catch (error) {
      next(error);
    }
  });

  // ── Orders: update status ─────────────────────────────────────────────────
  router.patch('/orders/:id', async (req, res, next) => {
    try {
      const { status } = req.body;
      if (!['pending', 'preparing', 'ready', 'served'].includes(status)) {
        return res.status(400).json({ error: 'Estado inválido.' });
      }
      const updated = await updateOrderStatus(req.params.id, status);
      if (!updated) return res.status(404).json({ error: 'Orden no encontrada.' });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
