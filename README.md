# GastroPulse PWA

Prototipo funcional offline-first para gestionar comandas de restaurante con vistas de mesero, cocina (KDS), cliente y el estado de entrega "Caminante".

La configuración regional está preparada para negocios colombianos: **COP ($)** es la moneda predeterminada, con precios locales de ejemplo, y el selector superior permite cambiar a **USD ($)**. Cada comanda guarda la moneda seleccionada.

## Ejecutar

```bash
npm install
npm start
```

Demo desplegada en Vercel:

```text
https://gastropulse-pwa.vercel.app
```

Para desarrollo local usa `http://localhost:3000`. Para probar cámara, geolocalización, sensores y notificaciones se requiere HTTPS o `localhost`, además de permisos del navegador.

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
https://gastropulse-pwa.vercel.app/api/google-assistant-webhook
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

# Guía de pruebas y demo

Esta guía describe cómo comprobar las funciones principales de GastroPulse y qué observar en Chrome DevTools durante una presentación.

## 1. Preparación

### Requisitos

- Conexión a Internet y acceso a la URL desplegada en Vercel.
- Node.js 18 o superior.
- Google Chrome o Chromium para voz, cámara, PWA y Service Worker.
- Permisos de cámara, micrófono y ubicación para las pruebas que los requieren.
- Puerto `3000` disponible solo para ejecutar una copia local.

### Inicio rápido

La demo principal está desplegada en:

- Aplicación: `https://gastropulse-pwa.vercel.app`
- QR de mesas: `https://gastropulse-pwa.vercel.app/qr/`
- Estado del servidor: `https://gastropulse-pwa.vercel.app/api/health`

Usa esta dirección para cámara, voz, ubicación, Push y otras capacidades PWA.

Para ejecutar una copia local:

```bash
npm install
npm start
```

Abre `http://localhost:3000`. Las siguientes direcciones locales son equivalentes:

- Aplicación: `http://localhost:3000`
- QR de mesas: `http://localhost:3000/qr/`
- Estado del servidor: `http://localhost:3000/api/health`

Para reiniciar automáticamente cuando cambia el servidor:

```bash
npm run dev
```

Detén el servidor con `Ctrl+C`.

### Comprobaciones rápidas con PowerShell

```powershell
$baseUrl = "https://gastropulse-pwa.vercel.app"

# Salud del servicio
(Invoke-RestMethod -Uri "$baseUrl/api/health").pushConfigured
(Invoke-RestMethod -Uri "$baseUrl/api/health").kvConfigured

# Comandas activas
Invoke-RestMethod -Method Get -Uri "$baseUrl/api/orders"

# Incidencias registradas
Invoke-RestMethod -Method Get -Uri "$baseUrl/api/complaints"

# Crear una comanda de prueba
$body = @{
  id = "demo-$([guid]::NewGuid())"
  table = 5
  items = @(@{
    productId = "cerveza"
    name = "Cerveza artesanal"
    quantity = 2
  })
  currency = "COP"
  status = "pending"
  source = "demo"
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json -Depth 4

Invoke-RestMethod -Method Post `
  -Uri "$baseUrl/api/orders" `
  -ContentType "application/json" `
  -Body $body
```

En Vercel, pedidos e incidencias persisten mediante Vercel KV solo si están configuradas las variables `KV_REST_API_URL` y `KV_REST_API_TOKEN`. Sin esa configuración, el servidor puede usar memoria temporal y los datos pueden perderse al reiniciar o cambiar de instancia.

## 2. Ruta completa de demo

### A. Mesero

1. Selecciona **Mesero** en la barra inferior.
2. Selecciona la Mesa 5.
3. Cambia la moneda entre COP y USD y observa que el menú y el total cambian.
4. Añade `Cerveza artesanal` y `Hamburguesa clásica`.
5. Usa los botones `+`, `-` y `×` del borrador para comprobar cantidades y eliminación.
6. Pulsa **Enviar comanda a cocina**.
7. Abre **Cocina** y confirma que aparece la Mesa 5 con los dos productos.

Resultado esperado: el borrador queda vacío, la comanda aparece en la KDS y el contador activo aumenta.

### B. Cocina y Caminante

1. En **Cocina**, selecciona el registro de Mesa 5.
2. Pulsa **Incidencia** y permite la cámara si se solicita.
3. Espera la cuenta regresiva y comprueba que la foto queda guardada en el panel **Incidencias**.
4. Desde **Comandas**, pulsa **Listo** en la comanda.
5. Confirma el aviso de "Caminante activado".

Resultado esperado: aparece el banner de entrega, la comanda cambia a lista/servida y la incidencia queda registrada.

### C. Cliente

1. Cambia a **Cliente**.
2. Pulsa **Verificar ahora** y permite la ubicación.
3. En un equipo físico cerca de UPTC Tunja, la aplicación debe aceptar una posición a menos de 200 metros del punto configurado.
4. Pulsa **Ver carta completa** y observa el catálogo de solo lectura.
5. Pulsa **Pulsa para pedir**, autoriza el micrófono y di:
   - `Dos cervezas`
   - `Mesa 5, dos cervezas y una hamburguesa sin cebolla`

Resultado esperado: se reconoce el producto, se crea la comanda automáticamente y empieza el temporizador de 15 minutos.

Notas:

- El reconocimiento de voz usa el Web Speech API y está optimizado para Chrome.
- El permiso de ubicación puede denegarse o fallar fuera del perímetro configurado.
- `https://gastropulse-pwa.vercel.app` ofrece HTTPS y permite probar funciones sensibles en producción.
- Al escanear un QR, la aplicación acepta URLs con `?view=customer&mesa=N`, texto `Mesa N` o solo `N`.
- Tras leer el QR, cambia automáticamente a la vista Cliente y actualiza Mesa, borrador y verificación.

### D. Queja o pedido tardío

1. En la vista de cliente, escribe una descripción en el campo de problemas.
2. Pulsa **Adjuntar foto**, permite la cámara y captura una imagen.
3. Pulsa **Enviar informe**.
4. Cambia a **Cocina → Incidencias** y confirma el registro.

Para probar el aviso por espera:

1. Crea un pedido desde la vista de cliente.
2. Deja pasar los 15 minutos de demostración o modifica de forma temporal el valor `WAIT_MINUTES` solo en desarrollo.
3. Cuando aparezca la opción **No llegó mi pedido**, envíala y revisa el panel de incidencias.

## 3. DevTools: qué revisar

Abre DevTools con `F12` o `Ctrl+Shift+I`.

### Console

Revisa:

- Errores de JavaScript o permisos bloqueados.
- Mensajes de instalación del Service Worker.
- Mensajes de sensores no compatibles.
- Errores de cámara, voz o ubicación.

Ejemplos de JavaScript útil en la consola:

```javascript
navigator.onLine
navigator.serviceWorker.controller
location.href
```

No uses datos sensibles reales en las pruebas.

### Network

Filtra por `Fetch/XHR` y crea una comanda.

Verifica:

- `POST /api/orders`
- `GET /api/orders`
- `POST /api/complaints`
- `GET /api/complaints`
- `POST /api/push/kitchen-ready`

Comprueba el código de estado, el cuerpo de la solicitud y la respuesta. Los registros que usan IndexedDB pueden seguir visibles temporalmente sin conexión.

### Offline y sincronización

1. Abre DevTools → **Network**.
2. Marca **Offline**.
3. Crea una comanda desde Mesero.
4. Observa el indicador Offline y el aviso de "Guardado en IndexedDB".
5. Desmarca Offline.
6. Espera el evento de sincronización o recarga la aplicación.
7. Abre Cocina y confirma que la comanda se recuperó.

En **Application → Storage**, puedes inspeccionar:

- IndexedDB → `gastropulse-db`
- Stores: `menu`, `comandas`, `sync_queue`, `incidencias`

En **Application → Service Workers**:

- Confirma que `/sw.js` está registrado y activo.
- Usa `Update` para recargar el Service Worker después de cambios.
- Usa `Unregister` para limpiar una instalación de prueba.
- Después de una nueva implementación, recarga una vez con conexión y espera a que aparezca `gastropulse-shell-v3`.
- Cierra todas las pestañas de la aplicación y ábrela de nuevo antes de repetir la prueba offline.

En **Application → Cache Storage**:

- Verifica la caché `gastropulse-shell-v2`.
- Comprueba que contiene el App Shell.
- Recarga con Offline activo para comprobar que la interfaz sigue disponible.

### Cámara y QR

En `https://gastropulse-pwa.vercel.app/qr/`:

1. Pulsa **Imprimir todos** si necesitas llevar los QR a la demo.
2. Escanea con el botón **Escanear QR** del Mesero.
3. O abre directamente:

   - `https://gastropulse-pwa.vercel.app/?view=customer&mesa=5`

En DevTools, Chrome puede solicitar permiso de cámara en la barra superior. Si el escaneo QR no está disponible, usa la cámara para incidencias o abre la URL directa.

### Ubicación simulada

1. Abre DevTools → `Sensors` (o `More tools → Sensors`).
2. Activa **Geolocation**.
3. Prueba con:
   - UPTC Tunja: latitud `5.5353`, longitud `-73.3678`
   - Un punto lejano, por ejemplo: latitud `4.6097`, longitud `-74.0817`
4. En **Cliente**, pulsa **Verificar ahora**.

Resultado:

- Cerca del restaurante: ubicación verificada.
- Lejos o fuera de 200 metros: acceso denegado por perímetro.

### Geolocalización y permisos

Si aparece "PERMISSION_DENIED":

1. Clica el icono de candado junto a la URL.
2. Busca **Ubicación**, **Micrófono** y **Cámara**.
3. Cambia el permiso a **Permitir**.
4. Recarga y vuelve a ejecutar la prueba.

### Web Push

1. Configura las claves VAPID:

```powershell
npx web-push generate-vapid-keys
```

2. Copia las claves a `.env` en `VAPID_PUBLIC_KEY` y `VAPID_PRIVATE_KEY`.
3. Reinicia con `npm start`.
4. Comprueba `/api/health`: `pushConfigured` debe ser `true`.
5. Pulsa el icono de campana en la barra superior.
6. Permite las notificaciones.
7. Pulsa **Listo** en una comanda desde Cocina.

Si no hay suscriptores o el navegador bloquea notificaciones, el servidor puede responder `sent: 0`.

### Tema y sensor de luz

- Pulsa el icono de sol/luna para cambiar manualmente entre terraza y comedor.
- En equipos compatibles, `AmbientLightSensor` puede cambiar el tema según la luminosidad.
- Sacudir un dispositivo compatible puede mostrar la confirmación para descartar el borrador.
- Solo usa estos controles en dispositivos físicos o emisores compatibles.

### Voz

Prueba estas frases:

```text
Mesa 4, dos cervezas y una hamburguesa sin cebolla
Una ensalada sin gluten
Tres aguas con hielo
Una cerveza extra queso
Una hamburguesa bien hecha
```

Observa el resultado parcial y final en el panel de voz. La voz puede depender de conexión y permisos del sistema.

## 4. Prueba del webhook de Google Assistant

### Diálogo mínimo de Dialogflow

```powershell
$body = @{
  intent = "Realizar pedido"
  queryResult = @{
    intent = @{
      displayName = "Realizar pedido"
    }
  }
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post `
  -Uri "https://gastropulse-pwa.vercel.app/api/google-assistant-webhook" `
  -ContentType "application/json" `
  -Body $body
```

### Conversational Actions

```powershell
$body = @{
  handler = @{ name = "place_order" }
  intent = @{
    name = "actions.intent.TEXT"
    params = @{
      table = @{ original = "5"; resolved = 5 }
      items = @{ original = "dos cervezas"; resolved = "dos cervezas" }
    }
    query = "Mesa 5, dos cervezas"
  }
  session = @{ id = "demo-session"; params = @{} }
  user = @{ locale = "es-CO" }
} | ConvertTo-Json -Depth 6

Invoke-RestMethod -Method Post `
  -Uri "https://gastropulse-pwa.vercel.app/api/google-assistant-webhook" `
  -ContentType "application/json" `
  -Body $body
```

Si configuraste `GOOGLE_WEBHOOK_TOKEN`, agrega `?token=TU_TOKEN` a la URL o el encabezado `x-webhook-token`.

## 5. Lista de verificación final

- [ ] La aplicación inicia con `npm start`.
- [ ] El endpoint `/api/health` responde.
- [ ] Se puede crear y modificar un borrador.
- [ ] La comanda aparece en Cocina.
- [ ] La moneda cambia correctamente.
- [ ] El offline guarda en IndexedDB.
- [ ] Al recuperar conexión se sincroniza la cola.
- [ ] El Service Worker permanece activo.
- [ ] El QR abre la mesa correcta.
- [ ] Cámara y geolocalización funcionan o muestran errores comprensibles.
- [ ] La voz reconoce productos y cantidades.
- [ ] Las incidencias se pueden crear y borrar.
- [ ] Push responde con suscriptores cuando está configurado.
- [ ] El webhook responde correctamente.