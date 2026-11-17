# GastroPulse PWA

Prototipo funcional offline-first para gestionar comandas de restaurante con vistas de mesero, cocina (KDS), cliente y el estado de entrega "Caminante".

La configuración regional está preparada para negocios colombianos: **COP ($)** es la moneda predeterminada, con precios locales de ejemplo, y el selector superior permite cambiar a **USD ($)**. Cada comanda guarda la moneda seleccionada.

## Ejecutar

```bash
npm install
npm start
```

Abre `http://localhost:3000`. Para probar capacidades de cámara, geolocalización, sensores y notificaciones se requiere HTTPS o `localhost` y permisos del navegador.

## Arquitectura

- `public/index.html` y `public/css/styles.css`: UI mobile-first con tema claro "Terraza" y oscuro "Comedor".
- `public/js/app.js`: navegación, catálogo, KDS, voz y flujo de pedido.
- `public/js/db.js`: IndexedDB promisificada con `menu`, `comandas` y `sync_queue`.
- `public/js/push.js`: permisos y suscripción del navegador a Web Push.
- `public/sw.js`: caché del App Shell, Background Sync, Push y `notificationclick`.
- `public/js/voice.js`: Web Speech API y parser de lenguaje natural a líneas de comanda.
- `public/js/sensors.js`: BarcodeDetector, cámara, geolocalización, luz ambiental, movimiento y vibración.
- `server/server.js`: Express, archivos estáticos y composición de rutas.
- `server/routes/api.js` y `server/routes/webhook.js`: API de salud, sincronización, Web Push y webhook compatible con Dialogflow.

## Web Push

Genera claves una vez y arranca el servidor con variables de entorno:

```bash
npx web-push generate-vapid-keys
cp .env.example .env
# Completa VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY en .env
npm start
```

El endpoint `POST /api/google-assistant-webhook` acepta payloads de Dialogflow y devuelve `fulfillmentText`.

### Google Conversational Actions

El mismo endpoint también acepta el payload oficial de Conversational Actions con `handler`, `intent`, `scene` y `session`, y responde con `session` + `prompt.firstSimple`. Configura en Builder la URL pública HTTPS:

```text
https://TU_DOMINIO/api/google-assistant-webhook
```

Ejemplo mínimo:

```json
{
  "handler": { "name": "place_order" },
  "intent": {
    "name": "actions.intent.TEXT",
    "params": {
      "table": { "original": "5", "resolved": 5 },
      "items": { "original": "dos cervezas", "resolved": "dos cervezas" }
    },
    "query": "Mesa 5, dos cervezas"
  },
  "session": { "id": "session_id", "params": {} },
  "user": { "locale": "es-CO" }
}
```