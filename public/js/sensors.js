export function setupSensors({ onShake, onLightChange, onLocation }) {
  let lastAcceleration = 0;
  let lastShake = 0;
  const motionHandler = (event) => {
    const acceleration = event.accelerationIncludingGravity;
    if (!acceleration) return;
    const magnitude = Math.abs(acceleration.x || 0) + Math.abs(acceleration.y || 0) + Math.abs(acceleration.z || 0);
    const now = Date.now();
    if (magnitude - lastAcceleration > 22 && now - lastShake > 1000) { lastShake = now; onShake?.(); }
    lastAcceleration = magnitude;
  };
  if ('DeviceMotionEvent' in window) window.addEventListener('devicemotion', motionHandler);

  let lightSensor;
  if ('AmbientLightSensor' in window) {
    try {
      lightSensor = new AmbientLightSensor();
      lightSensor.addEventListener('reading', () => onLightChange?.(lightSensor.illuminance > 80 ? 'terrace' : 'dining'));
      lightSensor.start();
    } catch (error) { console.info('AmbientLightSensor no disponible:', error.message); }
  }

  const verifyLocation = (target, radius = 150) => new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('La geolocalización no está disponible.'));
    navigator.geolocation.getCurrentPosition((position) => {
      const distance = haversine(position.coords.latitude, position.coords.longitude, target.latitude, target.longitude);
      const verified = distance <= radius;
      onLocation?.(verified, distance);
      resolve({ verified, distance });
    }, reject, { enableHighAccuracy: true, timeout: 8000 });
  });
  return { verifyLocation, dispose: () => window.removeEventListener('devicemotion', motionHandler) };
}

function haversine(latitude, longitude, targetLatitude, targetLongitude) {
  const earthRadius = 6371000;
  const radians = (value) => value * Math.PI / 180;
  const deltaLatitude = radians(targetLatitude - latitude);
  const deltaLongitude = radians(targetLongitude - longitude);
  const a = Math.sin(deltaLatitude / 2) ** 2 + Math.cos(radians(latitude)) * Math.cos(radians(targetLatitude)) * Math.sin(deltaLongitude / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function scanQrCode(videoElement) {
  if (!('BarcodeDetector' in window)) throw new Error('Este navegador no soporta escaneo QR. Usa Chrome en móvil.');
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  videoElement.srcObject = stream;
  await videoElement.play();
  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  const codes = await detector.detect(videoElement);
  stream.getTracks().forEach((track) => track.stop());
  return codes[0]?.rawValue || null;
}

export async function captureIncident() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('La cámara no está disponible.');
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  stream.getTracks().forEach((track) => track.stop());
  return { capturedAt: new Date().toISOString() };
}
