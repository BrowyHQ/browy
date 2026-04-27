// Render extension/icons/icon.svg → PNGs at 16/32/48/128/256/512.
// Run with: node scripts/render-icons.mjs
import sharp from 'sharp';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..');
const svgPath = path.join(repo, 'extension', 'icons', 'icon.svg');
const outDir = path.join(repo, 'extension', 'icons');

const sizes = [16, 32, 48, 128, 256, 512];

const svg = await readFile(svgPath);

for (const s of sizes) {
  const outPath = path.join(outDir, `icon${s}.png`);
  await sharp(svg, { density: Math.max(72, s * 4) })
    .resize(s, s, { kernel: 'nearest', fit: 'contain' })
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  console.log(`  wrote ${outPath}  (${s}x${s})`);
}

// Also emit a 512px PNG for the GitHub org avatar (the user wants to upload it manually).
console.log('\nDone. Upload icon512.png as the BrowyHQ org avatar.');
