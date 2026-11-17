const base64ToBytes = (value) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (character) => character.charCodeAt(0));

export async function subscribeToPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    throw new Error('Las notificaciones push no están disponibles en este navegador.');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Permiso de notificaciones denegado.');
  const publicKeyResponse = await fetch('/api/push/public-key');
  if (!publicKeyResponse.ok) throw new Error('El servidor no tiene Web Push configurado.');
  const { publicKey } = await publicKeyResponse.json();
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(publicKey) });
  const response = await fetch('/api/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(subscription) });
  if (!response.ok) throw new Error('No se pudo registrar la suscripción push.');
  return subscription;
}

export async function requestPushPermission() {
  return subscribeToPush();
}
