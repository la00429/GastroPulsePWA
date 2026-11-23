import sharp from 'sharp';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(__dirname, 'public', 'icons');
const svgBuffer = readFileSync(join(iconsDir, 'icon.svg'));

for (const size of [192, 512]) {
  await sharp(svgBuffer).resize(size, size).png().toFile(join(iconsDir, `icon-${size}.png`));
  console.log(`✓ icon-${size}.png`);
}
console.log('Iconos generados.');
