#!/usr/bin/env node
/**
 * Builds marketing/video/browy-thumbnail-shorts.png: a 1080x1920 (9:16)
 * vertical thumbnail for YouTube Shorts / Reels / TikTok previews.
 * Same retro pixel aesthetic as the horizontal thumbnail and demo video.
 *
 * Stays clear of the mobile UI overlays: no essential text in the
 * top ~150px, right ~140px, or bottom ~250px.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO, 'marketing/video');
const OUT_PNG = path.join(OUT_DIR, 'browy-thumbnail-shorts.png');
const MASCOT_SVG_PATH = path.join(REPO, 'extension/icons/icon.svg');

fs.mkdirSync(OUT_DIR, { recursive: true });

const W = 1080, H = 1920;

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
  // Strip ONLY the 3 backdrop rects (top notch, full body, bottom notch) so
  // the mascot composites onto our scanline grid. Earlier this matched any
  // rect with the dark fill, which was eating the pupils, the CRT inset,
  // the corner bolts, and the speaker grille — leaving the eyes dead-white.
  .replace(/<rect\s+x="2"\s+y="0"[^/]*\/>/, '')
  .replace(/<rect\s+x="0"\s+y="2"[^/]*\/>/, '')
  .replace(/<rect\s+x="2"\s+y="78"[^/]*\/>/, '');

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

// Vertical layout: everything stacks centrally, well away from the
// mobile UI overlays (top ~150px, right ~140px, bottom ~250px).
const wordmark = word('BROWY', 26, C.brandLite, 2);
const tagline1 = word('AI AGENT', 14, C.ink, 1);
const tagline2 = word('THAT LIVES IN', 9, C.brandSoft, 1);
const tagline3 = word('YOUR BROWSER', 9, C.brandSoft, 1);
const cta      = word('ADD TO CHROME', 8, C.led, 1);
const badge    = word('OPEN SOURCE BROWSER AGENT', 5, C.inkDim, 1);

// Mascot top-center, large.
const mascotSize = 560;
const mascotX = (W - mascotSize) / 2;
const mascotY = 240;

const wordmarkX = (W - wordmark.w) / 2;
const wordmarkY = mascotY + mascotSize + 80;
const tagline1X = (W - tagline1.w) / 2;
const tagline1Y = wordmarkY + wordmark.h + 60;
const tagline2X = (W - tagline2.w) / 2;
const tagline2Y = tagline1Y + tagline1.h + 40;
const tagline3X = (W - tagline3.w) / 2;
const tagline3Y = tagline2Y + tagline2.h + 24;
const ctaX      = (W - cta.w) / 2;
const ctaY      = tagline3Y + tagline3.h + 70;
const badgeX    = (W - badge.w) / 2;
const badgeY    = ctaY + cta.h + 60;

const mascotPlatform = `
  <ellipse cx="${mascotX + mascotSize / 2}" cy="${mascotY + mascotSize - 8}" rx="${mascotSize / 2.4}" ry="14" fill="${C.brandDeep}" opacity="0.45"/>
`;

// Corner brackets in the safe zone (inside top/bottom margins).
const cornerTL = `
  <rect x="40" y="180" width="80" height="6" fill="${C.brand}"/>
  <rect x="40" y="180" width="6" height="80" fill="${C.brand}"/>
`;
const cornerTR = `
  <rect x="${W - 120}" y="180" width="80" height="6" fill="${C.brand}"/>
  <rect x="${W - 46}" y="180" width="6" height="80" fill="${C.brand}"/>
`;
const cornerBL = `
  <rect x="40" y="${H - 260}" width="80" height="6" fill="${C.brand}"/>
  <rect x="40" y="${H - 340}" width="6" height="80" fill="${C.brand}"/>
`;
const cornerBR = `
  <rect x="${W - 120}" y="${H - 260}" width="80" height="6" fill="${C.brand}"/>
  <rect x="${W - 46}" y="${H - 340}" width="6" height="80" fill="${C.brand}"/>
`;

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${gridBg()}
  ${cornerTL}${cornerTR}${cornerBL}${cornerBR}
  ${mascotPlatform}
  ${mascot(mascotX, mascotY, mascotSize)}
  <g transform="translate(${wordmarkX},${wordmarkY})">${wordmark.svg}</g>
  <g transform="translate(${tagline1X},${tagline1Y})">${tagline1.svg}</g>
  <g transform="translate(${tagline2X},${tagline2Y})">${tagline2.svg}</g>
  <g transform="translate(${tagline3X},${tagline3Y})">${tagline3.svg}</g>
  <g transform="translate(${ctaX},${ctaY})">${cta.svg}</g>
  <g transform="translate(${badgeX},${badgeY})">${badge.svg}</g>
</svg>`;

await sharp(Buffer.from(svg)).png({ compressionLevel: 6 }).toFile(OUT_PNG);
const { size } = fs.statSync(OUT_PNG);
console.log(`✓ ${path.relative(REPO, OUT_PNG)}  ${(size / 1024).toFixed(1)} KB  ${W}x${H}`);
