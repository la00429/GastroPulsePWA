import 'dotenv/config';
import express from 'express';
import webpush from 'web-push';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiRouter } from './routes/api.js';
import webhookRouter from './routes/webhook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const publicDirectory = path.join(projectRoot, 'public');
const app = express();
const port = process.env.PORT || 3000;
const subscriptions = new Set();
const vapidKeys = process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
  ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY }
  : null;

if (vapidKeys) webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', vapidKeys.publicKey, vapidKeys.privateKey);

app.use(express.json({ limit: '1mb' }));
app.use('/api', createApiRouter({ webpush, vapidKeys, subscriptions }));
app.use('/api', webhookRouter);
app.use(express.static(publicDirectory));
app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: 'Error interno del servidor.' });
});

app.listen(port, () => console.log(`GastroPulse escuchando en http://localhost:${port}`));
