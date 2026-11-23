import { Router } from 'express';

// ---------------------------------------------------------------------------
// Subscription store abstraction
// In production (Vercel) we use the KV store so subscriptions survive across
// serverless function instances. In local dev we fall back to an in-memory Set.
// To enable KV: run `vercel env add` for KV_REST_API_URL and KV_REST_API_TOKEN,
// or link a Vercel KV database in the dashboard and redeploy.
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

// Used only when KV is not configured (local dev / demo deploy).
const fallbackSubscriptions = new Set();

export function createApiRouter({ webpush, vapidKeys }) {
  const router = Router();

  router.get('/health', (_request, response) => response.json({ ok: true, service: 'gastropulse', pushConfigured: Boolean(vapidKeys) }));

  router.get('/push/public-key', (_request, response) => {
    if (!vapidKeys) return response.status(503).json({ error: 'Web Push no configurado. Define VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY.' });
    response.json({ publicKey: vapidKeys.publicKey });
  });

  router.post('/push/subscribe', async (request, response) => {
    const subscription = request.body;
    if (!subscription?.endpoint) return response.status(400).json({ error: 'Suscripción inválida.' });
    await addSubscription(JSON.stringify(subscription));
    response.status(201).json({ subscribed: true });
  });

  router.post('/push/kitchen-ready', async (request, response, next) => {
    if (!vapidKeys) return response.status(503).json({ error: 'Web Push no configurado.' });
    try {
      const payload = JSON.stringify({ title: 'GastroPulse · Caminante', body: `La comanda de la Mesa ${request.body?.table || '?'} está lista para servir.` });
      const subs = await getAllSubscriptions();
      const results = await Promise.allSettled(subs.map((raw) => webpush.sendNotification(JSON.parse(raw), payload)));
      response.json({ sent: results.filter((result) => result.status === 'fulfilled').length });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
