import { getAll, saveOrder } from './db.js';

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export function isVoiceSupported() {
  return Boolean(SpeechRecognition);
}

// ── Number word → digit map (Spanish) ────────────────────────────────────
const WORD_NUMBERS = {
  un: 1, uno: 1, una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
};

function normalize(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^\w\s]/g, ' ')        // punctuation → space
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Main parser ────────────────────────────────────────────────────────────
export function parseOrderSpeech(transcript, menu) {
  const text  = normalize(transcript);
  const words = text.split(' ');

  // ── Table number ──────────────────────────────────────────────────────
  let table = null;
  const tableIdx = words.indexOf('mesa');
  if (tableIdx !== -1 && words[tableIdx + 1]) {
    const next = words[tableIdx + 1];
    table = parseInt(next, 10) || WORD_NUMBERS[next] || null;
  }

  const items = [];

  menu.forEach((product) => {
    const productWords = normalize(product.name)
      .split(' ')
      .filter((w) => w.length > 2);

    // Find the first product keyword that appears in the transcript
    const firstKeyword = productWords.find((pw) => text.includes(pw));
    if (!firstKeyword) return;

    // ── Find quantity ─────────────────────────────────────────────────
    // Strategy: find the char position of the keyword in the text,
    // extract the substring before it, split into words, look back up to 3.
    const keywordCharIdx = text.indexOf(firstKeyword);
    const before = text.slice(0, keywordCharIdx).trim();
    const beforeWords = before.split(' ').filter(Boolean);

    let quantity = 1;
    for (let offset = 1; offset <= 3; offset++) {
      const candidate = beforeWords[beforeWords.length - offset];
      if (!candidate) break;
      // Skip connectors and stop words
      if (['y', 'e', 'con', 'de', 'la', 'el', 'un', 'una'].includes(candidate)) continue;
      const digit = parseInt(candidate, 10);
      if (!isNaN(digit) && digit > 0) { quantity = digit; break; }
      if (WORD_NUMBERS[candidate]) { quantity = WORD_NUMBERS[candidate]; break; }
    }

    const notes = extractNotes(text, product);
    items.push({ productId: product.id, name: product.name, quantity, notes });
  });

  return { table, items };
}

function extractNotes(text, product) {
  const modifiers = [
    { pattern: /sin\s+cebolla/, note: 'Sin cebolla' },
    { pattern: /sin\s+gluten/, note: 'Sin gluten' },
    { pattern: /sin\s+lactosa/, note: 'Sin lactosa' },
    { pattern: /extra\s+queso/, note: 'Extra queso' },
    { pattern: /bien\s+hecho/, note: 'Bien hecho' },
    { pattern: /poco\s+hecho/, note: 'Poco hecho' },
    { pattern: /sin\s+hielo/, note: 'Sin hielo' },
    { pattern: /con\s+hielo/, note: 'Con hielo' },
    { pattern: /para\s+llevar/, note: 'Para llevar' },
  ];
  return modifiers
    .filter(({ pattern }) => pattern.test(text))
    .map(({ note }) => note)
    .join(', ');
}

// ── Voice controller ───────────────────────────────────────────────────────
export function createVoiceController({ onResult, onState, onInterim }) {
  if (!SpeechRecognition) {
    return { supported: false, start: () => onState?.('unsupported'), stop: () => {} };
  }

  const recognition = new SpeechRecognition();
  recognition.lang = 'es-ES';
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => onState?.('listening');
  recognition.onend = () => onState?.('idle');

  recognition.onerror = (event) => {
    // 'no-speech' is harmless — user just didn't say anything
    if (event.error === 'no-speech') {
      onState?.('idle');
    } else if (event.error === 'network') {
      onState?.('error', 'Sin conexión. El dictado requiere internet.');
    } else if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      onState?.('error', 'Permiso de micrófono denegado.');
    } else {
      onState?.('error', `Error de voz: ${event.error}`);
    }
  };

  recognition.onresult = (event) => {
    const results = Array.from(event.results);
    const transcript = results.map((r) => r[0].transcript).join(' ');
    const isFinal = results[results.length - 1].isFinal;
    if (!isFinal) {
      onInterim?.(transcript); // partial transcript for live display
    } else {
      onResult?.(transcript, true);
    }
  };

  return {
    supported: true,
    start: () => {
      try { recognition.start(); } catch (_) { /* already running */ }
    },
    stop: () => {
      try { recognition.stop(); } catch (_) {}
    },
  };
}

// ── Convenience: parse + save directly ────────────────────────────────────
export async function parseAndSaveVoiceOrder(transcript) {
  const menu = await getAll('menu');
  const parsed = parseOrderSpeech(transcript, menu);
  if (!parsed.items.length) throw new Error('No reconocí productos del menú en tu comanda.');
  return saveOrder({ table: parsed.table || 1, items: parsed.items, status: 'pending', source: 'voice' });
}
