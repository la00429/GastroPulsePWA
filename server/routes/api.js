import { Router } from 'express';

export function createApiRouter({ webpush, vapidKeys, subscriptions }) {
  const router = Router();

  router.get('/health', (_request, response) => response.json({ ok: true, service: 'gastropulse', pushConfigured: Boolean(vapidKeys) }));
  router.get('/push/public-key', (_request, response) => {
    if (!vapidKeys) return response.status(503).json({ error: 'Web Push no configurado. Define VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY.' });
    response.json({ publicKey: vapidKeys.publicKey });
  });
  router.post('/push/subscribe', (request, response) => {
    const subscription = request.body;
    if (!subscription?.endpoint) return response.status(400).json({ error: 'Suscripción inválida.' });
    subscriptions.add(JSON.stringify(subscription));
    response.status(201).json({ subscribed: true });
  });
  router.post('/push/kitchen-ready', async (request, response, next) => {
    if (!vapidKeys) return response.status(503).json({ error: 'Web Push no configurado.' });
    try {
      const payload = JSON.stringify({ title: 'GastroPulse · Caminante', body: `La comanda de la Mesa ${request.body?.table || '?'} está lista para servir.` });
      const results = await Promise.allSettled([...subscriptions].map((raw) => webpush.sendNotification(JSON.parse(raw), payload)));
      response.json({ sent: results.filter((result) => result.status === 'fulfilled').length });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
