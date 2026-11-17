import { getAll, saveOrder } from './db.js';

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export function isVoiceSupported() {
  return Boolean(SpeechRecognition);
}

export function parseOrderSpeech(transcript, menu) {
  const normalized = transcript.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const tableMatch = normalized.match(/mesa\s+(\d+)/);
  const items = [];
  menu.forEach((product) => {
    const name = product.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const words = name.split(/\s+/);
    if (words.some((word) => word.length > 3 && normalized.includes(word))) {
      const beforeProduct = normalized.slice(0, normalized.indexOf(words.find((word) => normalized.includes(word))));
      const quantityMatch = beforeProduct.match(/(?:^|\D)(\d+)\s*$/);
      items.push({ productId: product.id, name: product.name, quantity: quantityMatch ? Number(quantityMatch[1]) : 1, notes: /sin\s+cebolla/.test(normalized) && product.id === 'hamburguesa' ? 'Sin cebolla' : '' });
    }
  });
  return { table: tableMatch ? Number(tableMatch[1]) : null, items };
}

export function createVoiceController({ onResult, onState }) {
  if (!SpeechRecognition) return { supported: false, start: () => onState?.('unsupported') };
  const recognition = new SpeechRecognition();
  recognition.lang = 'es-ES';
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.onstart = () => onState?.('listening');
  recognition.onend = () => onState?.('idle');
  recognition.onerror = (event) => onState?.('error', event.error);
  recognition.onresult = (event) => {
    const transcript = Array.from(event.results).map((result) => result[0].transcript).join(' ');
    onResult?.(transcript, event.results[event.results.length - 1].isFinal);
  };
  return { supported: true, start: () => recognition.start(), stop: () => recognition.stop() };
}

export async function parseAndSaveVoiceOrder(transcript) {
  const menu = await getAll('menu');
  const parsed = parseOrderSpeech(transcript, menu);
  if (!parsed.items.length) throw new Error('No reconocí productos del menú.');
  return saveOrder({ table: parsed.table || 1, items: parsed.items, status: 'pending', source: 'voice' });
}
