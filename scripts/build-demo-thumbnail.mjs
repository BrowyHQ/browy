#!/usr/bin/env node
/**
 * Builds the YouTube thumbnail for the demo video at
 * marketing/video/browy-thumbnail.png (1280x720, the standard
 * YouTube custom-thumbnail size).
 *
 * Reuses the same retro-pixel aesthetic as the video and CWS assets:
 * scanline grid background, 5x7 pixel font, mascot prominent on the
 * left, brand wordmark + tagline on the right, brand strip at the
 * bottom. No external assets fetched.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO, 'marketing/video');
const OUT_PNG = path.join(OUT_DIR, 'browy-thumbnail.png');
const MASCOT_SVG_PATH = path.join(REPO, 'extension/icons/icon.svg');

fs.mkdirSync(OUT_DIR, { recursive: true });

const W = 1280, H = 720;

const C = {
  bg:        '#0a1f12',
  bgGrid:    '#0f2a18',
  brand:     '#22c55e',
  brandLite: '#4ade80',
  brandSoft: '#a3f3b8',
  brandDeep: '#15803d',
  ink:       '#d8e3d8',
  inkDim:    '#7da78a',
  led:       '#c5f04b',
};

const FONT = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.####', '#....', '#....', '#..##', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  J: ['..###', '....#', '....#', '....#', '....#', '#...#', '.###.'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '##..#', '#.#.#', '#.#.#', '#..##', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
  '·': ['.....', '.....', '.....', '..#..', '.....', '.....', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.....', '..#..'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  ':': ['.....', '..#..', '.....', '.....', '.....', '..#..', '.....'],
  '>': ['#....', '.#...', '..#..', '...#.', '..#..', '.#...', '#....'],
};

function glyph(ch, scale, color) {
  const g = FONT[ch] || FONT[' '];
  let s = '';
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 5; c++) {
      if (g[r][c] === '#') {
        s += `<rect x="${c * scale}" y="${r * scale}" width="${scale}" height="${scale}" fill="${color}"/>`;
      }
    }
  }
  return s;
}

function word(text, scale, color, gap = 1) {
  let out = '';
  let x = 0;
  for (const ch of text.toUpperCase()) {
    out += `<g transform="translate(${x},0)">${glyph(ch, scale, color)}</g>`;
    x += (5 + gap) * scale;
  }
  return { svg: out, w: x - gap * scale, h: 7 * scale };
}

const RAW_MASCOT = fs.readFileSync(MASCOT_SVG_PATH, 'utf8');
const MASCOT_INNER = RAW_MASCOT
  .replace(/<\?xml[^?]*\?>/, '')
  .replace(/<svg[^>]*>/, '')
  .replace(/<\/svg>/, '')
  .replace(/<rect[^>]*fill="#0a1f12"[^/]*\/>/g, '');

function mascot(x, y, size) {
  const s = size / 80;
  return `<g transform="translate(${x},${y}) scale(${s})">${MASCOT_INNER}</g>`;
}

function gridBg() {
  let lines = '';
  for (let y = 0; y < H; y += 4) {
    lines += `<rect x="0" y="${y}" width="${W}" height="1" fill="${C.bgGrid}" opacity="0.55"/>`;
  }
  return `<rect width="${W}" height="${H}" fill="${C.bg}"/>${lines}`;
}

const wordmark = word('BROWY', 18, C.brandLite, 2);
const tagline1 = word('AI AGENT THAT LIVES', 5, C.ink, 1);
const tagline2 = word('IN YOUR BROWSER', 5, C.brandSoft, 1);
const badge    = word('OPEN SOURCE BROWSER AGENT', 4, C.inkDim, 1);

const mascotSize = 520;
const mascotX = 40;
const mascotY = (H - mascotSize) / 2 - 20;

const textX = 620;
const wordmarkY = 220;
const tagline1Y = wordmarkY + wordmark.h + 50;
const tagline2Y = tagline1Y + tagline1.h + 16;
const badgeY    = H - 60;

const mascotPlatform = `
  <ellipse cx="${mascotX + mascotSize / 2}" cy="${mascotY + mascotSize - 8}" rx="${mascotSize / 2.4}" ry="14" fill="${C.brandDeep}" opacity="0.45"/>
`;

const cornerTL = `
  <rect x="40" y="40" width="60" height="6" fill="${C.brand}"/>
  <rect x="40" y="40" width="6" height="60" fill="${C.brand}"/>
`;
const cornerTR = `
  <rect x="${W - 100}" y="40" width="60" height="6" fill="${C.brand}"/>
  <rect x="${W - 46}" y="40" width="6" height="60" fill="${C.brand}"/>
`;
const cornerBL = `
  <rect x="40" y="${H - 46}" width="60" height="6" fill="${C.brand}"/>
  <rect x="40" y="${H - 100}" width="6" height="60" fill="${C.brand}"/>
`;
const cornerBR = `
  <rect x="${W - 100}" y="${H - 46}" width="60" height="6" fill="${C.brand}"/>
  <rect x="${W - 46}" y="${H - 100}" width="6" height="60" fill="${C.brand}"/>
`;

const bottomStrip = `
  <rect x="0" y="${H - 12}" width="${W}" height="3" fill="${C.brandDeep}"/>
  <rect x="120" y="${H - 9}" width="120" height="3" fill="${C.led}"/>
`;

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${gridBg()}
  ${cornerTL}${cornerTR}${cornerBL}${cornerBR}
  ${mascotPlatform}
  ${mascot(mascotX, mascotY, mascotSize)}
  <g transform="translate(${textX},${wordmarkY})">${wordmark.svg}</g>
  <g transform="translate(${textX},${tagline1Y})">${tagline1.svg}</g>
  <g transform="translate(${textX},${tagline2Y})">${tagline2.svg}</g>
  <g transform="translate(${(W - badge.w) / 2},${badgeY})">${badge.svg}</g>
  ${bottomStrip}
</svg>`;

await sharp(Buffer.from(svg)).png({ compressionLevel: 6 }).toFile(OUT_PNG);
const { size } = fs.statSync(OUT_PNG);
console.log(`✓ ${path.relative(REPO, OUT_PNG)}  ${(size / 1024).toFixed(1)} KB  ${W}x${H}`);
