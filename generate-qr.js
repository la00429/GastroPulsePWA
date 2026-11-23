import QRCode from 'qrcode';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, 'public', 'qr');
mkdirSync(outDir, { recursive: true });

const BASE_URL = 'https://gastropulse-pwa.vercel.app';
const TABLES = [
  { id: 1, zone: 'Terraza' },
  { id: 2, zone: 'Terraza' },
  { id: 3, zone: 'Salón' },
  { id: 4, zone: 'Salón' },
  { id: 5, zone: 'Salón' },
  { id: 6, zone: 'Barra' },
];

for (const table of TABLES) {
  const url = `${BASE_URL}/?view=customer&mesa=${table.id}`;
  const svg = await QRCode.toString(url, { type: 'svg', width: 220, margin: 2, color: { dark: '#17202b', light: '#ffffff' } });
  writeFileSync(join(outDir, `mesa-${table.id}.svg`), svg);
  console.log(`✓ mesa-${table.id}.svg → ${url}`);
}
console.log('QRs generados en public/qr/');
