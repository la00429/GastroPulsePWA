export function setupSensors({ onShake, onLightChange, onLocation }) {
  let lastAcceleration = 0;
  let lastShake = 0;

  const motionHandler = (event) => {
    const acc = event.accelerationIncludingGravity;
    if (!acc) return;
    const magnitude = Math.abs(acc.x || 0) + Math.abs(acc.y || 0) + Math.abs(acc.z || 0);
    const now = Date.now();
    if (magnitude - lastAcceleration > 22 && now - lastShake > 1000) {
      lastShake = now;
      onShake?.();
    }
    lastAcceleration = magnitude;
  };
  if ('DeviceMotionEvent' in window) window.addEventListener('devicemotion', motionHandler);

  if ('AmbientLightSensor' in window) {
    try {
      const sensor = new AmbientLightSensor();
      sensor.addEventListener('reading', () =>
        onLightChange?.(sensor.illuminance > 80 ? 'terrace' : 'dining')
      );
      sensor.start();
    } catch (err) {
      console.info('AmbientLightSensor no disponible:', err.message);
    }
  }

  const verifyLocation = (target, radius = 150) =>
    new Promise((resolve, reject) => {
      if (!navigator.geolocation)
        return reject(new Error('La geolocalización no está disponible.'));
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const dist = haversine(
            pos.coords.latitude, pos.coords.longitude,
            target.latitude, target.longitude
          );
          const verified = dist <= radius;
          onLocation?.(verified, dist);
          resolve({ verified, distance: dist });
        },
        (err) => reject(new Error(err.message)),
        { enableHighAccuracy: true, timeout: 8000 }
      );
    });

  return {
    verifyLocation,
    dispose: () => window.removeEventListener('devicemotion', motionHandler),
  };
}

function haversine(lat, lon, tlat, tlon) {
  const R = 6371000;
  const rad = (v) => (v * Math.PI) / 180;
  const dLat = rad(tlat - lat);
  const dLon = rad(tlon - lon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat)) * Math.cos(rad(tlat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function scanQrCode(videoElement) {
  if (!('BarcodeDetector' in window))
    throw new Error('Este navegador no soporta escaneo QR. Usa Chrome en móvil.');
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  videoElement.srcObject = stream;
  await videoElement.play();
  const detector = new BarcodeDetector({ formats: ['qr_code'] });

  // Poll up to 5 s for a QR code
  const result = await new Promise((resolve) => {
    let attempts = 0;
    const timer = setInterval(async () => {
      attempts++;
      try {
        const codes = await detector.detect(videoElement);
        if (codes.length > 0) { clearInterval(timer); resolve(codes[0].rawValue); return; }
      } catch (_) { /* frame not ready yet */ }
      if (attempts >= 50) { clearInterval(timer); resolve(null); }
    }, 100);
  });

  stream.getTracks().forEach((t) => t.stop());
  return result;
}

// ── captureIncident ────────────────────────────────────────────────────────
// Opens the camera, shows a live preview in `previewEl` (optional <video>),
// waits `captureDelayMs`, snaps a frame to a canvas and returns a dataURL.
export async function captureIncident({ previewEl = null, captureDelayMs = 2500 } = {}) {
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error('La cámara no está disponible en este dispositivo.');

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
  });

  // Show live preview if a video element was provided
  let videoEl = previewEl;
  let ownVideo = false;
  if (!videoEl) {
    videoEl = document.createElement('video');
    videoEl.style.display = 'none';
    document.body.appendChild(videoEl);
    ownVideo = true;
  }
  videoEl.srcObject = stream;
  videoEl.muted = true;
  await videoEl.play();

  // Wait for the camera to stabilise, then capture
  await new Promise((r) => setTimeout(r, captureDelayMs));

  const canvas = document.createElement('canvas');
  canvas.width = videoEl.videoWidth || 640;
  canvas.height = videoEl.videoHeight || 480;
  canvas.getContext('2d').drawImage(videoEl, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.82);

  // Tear down
  stream.getTracks().forEach((t) => t.stop());
  if (ownVideo) document.body.removeChild(videoEl);
  else { videoEl.srcObject = null; }

  return { dataUrl, capturedAt: new Date().toISOString(), width: canvas.width, height: canvas.height };
}
