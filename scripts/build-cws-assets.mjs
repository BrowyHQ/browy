// Builds the Chrome Web Store listing visuals from the in-app mascot.
//
// Produces two PNGs in extension/icons/cws/:
//   - promo-tile.png   440x280   (CWS "Small promo tile")
//   - marquee.png      1400x560  (CWS "Marquee promo tile")
//
// Both reuse the mascot palette so the listing reads as one coherent thing.
// The "BROWY" wordmark is hand-drawn from a 5x7 bitmap so it stays crisp at
// any scale without depending on system fonts.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT = path.join(REPO, 'extension/icons/cws');
fs.mkdirSync(OUT, { recursive: true });

// ── Palette (matches extension/icons/icon.svg) ───────────────────────────
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

// ── 5x7 pixel font for the wordmark ──────────────────────────────────────
// Each glyph is 5 columns × 7 rows. '#' is on, '.' is off.
const FONT = {
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  Y: ['#...#', '#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..'],
  // tagline-only glyphs (5x7) for "AI AGENT IN YOUR BROWSER"
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  G: ['.####', '#....', '#....', '#..##', '#...#', '#...#', '.####'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  N: ['#...#', '##..#', '##..#', '#.#.#', '#.#.#', '#..##', '#...#'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  J: ['..###', '....#', '....#', '....#', '....#', '#...#', '.###.'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
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
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '..#..', '..#..'],
};

function drawWord(word, scale, color, gap = 1) {
  // Returns an SVG fragment (rects only) and the natural pixel width.
  const rows = 7, cols = 5;
  let x = 0;
  let svg = '';
  for (const ch of word.toUpperCase()) {
    const glyph = FONT[ch];
    if (!glyph) { x += (cols + gap) * scale; continue; }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (glyph[r][c] === '#') {
          svg += `<rect x="${x + c * scale}" y="${r * scale}" width="${scale}" height="${scale}" fill="${color}"/>`;
        }
      }
    }
    x += (cols + gap) * scale;
  }
  return { svg, width: x - gap * scale, height: rows * scale };
}

// ── Mascot (load + strip its own backdrop so it sits on our canvas color) ─
const mascotRaw = fs.readFileSync(path.join(REPO, 'extension/icons/icon.svg'), 'utf8');
// Drop the three backdrop rects (top notch, body, bottom notch) — the canvas
// already provides the dark background and the mascot ends up framed by it.
const mascotInner = mascotRaw
  .replace(/<rect x="2"\s+y="0"[^/]*\/>/, '')
  .replace(/<rect x="0"\s+y="2"[^/]*\/>/, '')
  .replace(/<rect x="2"\s+y="78"[^/]*\/>/, '')
  .match(/<svg[^>]*>([\s\S]*?)<\/svg>/)[1];

function mascotG(x, y, size) {
  // The source viewBox is 0 0 80 80. Use a transform to place + scale.
  const s = size / 80;
  return `<g transform="translate(${x},${y}) scale(${s})" shape-rendering="crispEdges">${mascotInner}</g>`;
}

// ── Subtle pixel-grid background (CRT-ish) ───────────────────────────────
function gridBg(w, h, step = 8) {
  let s = `<rect width="${w}" height="${h}" fill="${C.bg}"/>`;
  // Faint horizontal scanlines
  for (let y = 0; y < h; y += 2) {
    s += `<rect x="0" y="${y}" width="${w}" height="1" fill="${C.bgGrid}" opacity="0.55"/>`;
  }
  return s;
}

// ── Compose: small promo tile (440x280) ──────────────────────────────────
function composePromo() {
  const W = 440, H = 280;
  const word = drawWord('BROWY', 7, C.brandLite, 1); // ~232 wide, 49 tall
  const tag  = drawWord('AI IN YOUR BROWSER', 3, C.brandSoft, 1); // ~342 wide, 21 tall
  const sub  = drawWord('GITHUB COPILOT INSIDE', 2, C.inkDim, 1); // ~228 wide, 14 tall

  // Mascot 200x200, vertically centered on left
  const mascotSize = 200;
  const mascotX = 22;
  const mascotY = (H - mascotSize) / 2;

  // Right column starts after mascot + breathing room
  const rx = mascotX + mascotSize + 28;
  // Fit tagline inside the canvas — scale 3 gives 342w, but our right column
  // only has 440 - rx = ~168px. So the tagline needs scale 2 to fit cleanly.
  const tagFit = drawWord('AI IN YOUR BROWSER', 2, C.brandSoft, 1); // 5*2*18 + gaps ≈ 230
  // Still too wide for 168px — wrap as two lines.
  const tag1 = drawWord('AI AGENT', 3, C.brandSoft, 1);
  const tag2 = drawWord('IN YOUR', 3, C.brandSoft, 1);
  const tag3 = drawWord('BROWSER',  3, C.brandSoft, 1);

  // Wordmark BROWY at scale 7 = 49 tall, ~232 wide. Right column has ~168px,
  // so the wordmark goes at scale 5 (5*5 + 4*1 = 29 wide per glyph chain;
  // 5 glyphs × 5 cols × 5 + 4 gaps × 5 = 145 wide, 35 tall).
  const wm = drawWord('BROWY', 5, C.brandLite, 1); // ~145 wide, 35 tall

  // Layout in right column (rx, top of mascot):
  //   y=mascotY        wordmark
  //   y=mascotY+50     tag1
  //   y=mascotY+70     tag2
  //   y=mascotY+90     tag3
  //   y=mascotY+125    sub line
  const ry0 = mascotY + 6;

  // LED bar on bottom right
  const ledY = H - 18;
  const ledStrip = `
    <rect x="${rx}" y="${ledY}" width="${W - rx - 22}" height="2" fill="${C.brandDeep}"/>
    <rect x="${rx}" y="${ledY + 2}" width="6" height="2" fill="${C.led}"/>
  `;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">
  ${gridBg(W, H)}
  ${mascotG(mascotX, mascotY, mascotSize)}
  <g transform="translate(${rx},${ry0})">${wm.svg}</g>
  <g transform="translate(${rx},${ry0 + 50})">${tag1.svg}</g>
  <g transform="translate(${rx},${ry0 + 74})">${tag2.svg}</g>
  <g transform="translate(${rx},${ry0 + 98})">${tag3.svg}</g>
  <g transform="translate(${rx},${ry0 + 138})">${drawWord('GITHUB COPILOT', 2, C.inkDim, 1).svg}</g>
  ${ledStrip}
</svg>`;
}

// ── Compose: marquee 1400x560 ───────────────────────────────────────────
function composeMarquee() {
  const W = 1400, H = 560;

  const mascotSize = 380;
  const mascotX = 80;
  const mascotY = (H - mascotSize) / 2;

  const rx = mascotX + mascotSize + 80;

  // Big wordmark: scale 16 → 80 wide per glyph chain piece, 5 letters x 5 cols
  // *16 + 4 gaps *16 = 464 wide, 112 tall. Fits.
  const wm = drawWord('BROWY', 16, C.brandLite, 1);

  // Tagline scale 5 = 30 wide per char chain. 24 chars ≈ 720, fits.
  const tag = drawWord('AI AGENT IN YOUR BROWSER', 5, C.brandSoft, 1);

  // Sub line: scale 4. 25 chars × 24 = 600 wide.
  const sub = drawWord('POWERED BY GITHUB COPILOT', 4, C.inkDim, 1);

  const wmY = 130;
  const tagY = wmY + 112 + 40;
  const subY = tagY + 35 + 32;

  // Faux "tab strip" decoration at top (suggests browser context without a
  // literal screenshot — keeps the tile abstract + approval-friendly).
  let tabs = `<rect x="0" y="0" width="${W}" height="36" fill="${C.bgGrid}"/>`;
  let tx = 80;
  for (let i = 0; i < 4; i++) {
    const tw = i === 1 ? 220 : 140;
    const fill = i === 1 ? C.bg : C.bgGrid;
    const stroke = i === 1 ? C.brandDeep : 'transparent';
    tabs += `<rect x="${tx}" y="6" width="${tw}" height="30" rx="4" ry="4" fill="${fill}" stroke="${stroke}"/>`;
    if (i === 1) {
      // little active-tab dot
      tabs += `<rect x="${tx + 14}" y="18" width="6" height="6" fill="${C.brandLite}"/>`;
    }
    tx += tw + 6;
  }

  // LED strip along the bottom
  const ledStrip = `
    <rect x="0" y="${H - 8}" width="${W}" height="2" fill="${C.brandDeep}"/>
    <rect x="80" y="${H - 6}" width="60" height="2" fill="${C.led}"/>
    <rect x="160" y="${H - 6}" width="20" height="2" fill="${C.brand}"/>
  `;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">
  ${gridBg(W, H)}
  ${tabs}
  ${mascotG(mascotX, mascotY, mascotSize)}
  <g transform="translate(${rx},${wmY})">${wm.svg}</g>
  <g transform="translate(${rx},${tagY})">${tag.svg}</g>
  <g transform="translate(${rx},${subY})">${sub.svg}</g>
  ${ledStrip}
</svg>`;
}

// ── Render ──────────────────────────────────────────────────────────────
async function render(svg, name, w, h) {
  const svgPath = path.join(OUT, name + '.svg');
  const pngPath = path.join(OUT, name + '.png');
  fs.writeFileSync(svgPath, svg);
  await sharp(Buffer.from(svg)).resize(w, h).png({ compressionLevel: 9 }).toFile(pngPath);
  const { size } = fs.statSync(pngPath);
  console.log(`✓ ${name}.png  ${w}x${h}  ${(size / 1024).toFixed(1)} KB`);
}

await render(composePromo(),    'promo-tile', 440,  280);
await render(composeMarquee(),  'marquee',    1400, 560);

// ── CWS screenshots: place each source side-panel capture on a 1280x800 ──
// canvas so the listing's gallery reads as a coherent set instead of a pile
// of variously-sized vertical strips.

const SCREENSHOT_SRC = path.resolve(REPO, '../browy-docs/src/assets/screenshots');
const SHOTS = [
  { src: 'panel-empty.png',     caption: 'SIDE PANEL',         blurb: ['DRAG IT OPEN ON ANY TAB',     'TYPE  WATCH IT WORK'] },
  { src: 'panel-summarize.png', caption: 'SUMMARIZE A PAGE',   blurb: ['ASK IN PLAIN ENGLISH',        'NO COPY  NO PASTE'] },
  { src: 'devtools-panel.png',  caption: 'DEVTOOLS PANEL',     blurb: ['REPL NEXT TO INSPECTOR',      'SLASH COMMANDS  JS REPL'] },
  { src: 'panel-fillform.png',  caption: 'FILL THIS FORM',     blurb: ['MULTI STEP AUTOMATION',       'WORKS WITH YOUR LOGINS'] },
  { src: 'panel-network.png',   caption: 'INSPECT NETWORK',    blurb: ['LIVE NETWORK  CONSOLE TAPS',  'NO DEVTOOLS GYMNASTICS'] },
];

async function composeShotEntry(s, idx) {
  return composeShot(s.src, s.caption, s.blurb, idx);
}

async function composeShot(srcRel, caption, blurb, idx) {
  const W = 1280, H = 800;
  const srcPath = path.join(SCREENSHOT_SRC, srcRel);
  if (!fs.existsSync(srcPath)) {
    console.warn(`  skip ${srcRel} (not found)`);
    return;
  }
  const img = sharp(srcPath);
  const meta = await img.metadata();
  // Right column hosts the screenshot; left column hosts the marketing copy.
  // Right column width = 760 (x: 480..1240). Fit screenshot inside 720-tall slot.
  const slotH = 720;
  const slotW = 720;
  const scale = Math.min(slotW / meta.width, slotH / meta.height);
  const drawW = Math.round(meta.width * scale);
  const drawH = Math.round(meta.height * scale);
  const innerBuf = await sharp(srcPath).resize(drawW, drawH).png().toBuffer();
  const imgX = 480 + Math.round((slotW - drawW) / 2);
  const imgY = 40 + Math.round((slotH - drawH) / 2);

  // Left-column copy.
  const cap     = drawWord(caption, 4, C.brandLite, 1);
  const blurb1  = drawWord(blurb[0] || '', 3, C.brandSoft, 1);
  const blurb2  = drawWord(blurb[1] || '', 3, C.brandSoft, 1);
  const counter = drawWord((idx + 1) + ' OF ' + SHOTS.length, 2, C.inkDim, 1);
  const wm      = drawWord('BROWY', 3, C.brandLite, 1);

  const lx = 60;
  const bgSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">
  ${gridBg(W, H)}
  <g transform="translate(${lx},80)">${wm.svg}</g>
  <g transform="translate(${lx},170)">${cap.svg}</g>
  <rect x="${lx}" y="240" width="60" height="3" fill="${C.brandDeep}"/>
  <g transform="translate(${lx},280)">${blurb1.svg}</g>
  <g transform="translate(${lx},${blurb[1] ? 320 : 280})">${blurb2.svg}</g>
  <g transform="translate(${lx},${H - 50})">${counter.svg}</g>
  <rect x="${imgX - 4}" y="${imgY - 4}" width="${drawW + 8}" height="${drawH + 8}" fill="${C.brandDeep}"/>
</svg>`;

  const out = path.join(OUT, 'screenshot-' + (idx + 1) + '.png');
  await sharp(Buffer.from(bgSvg))
    .composite([{ input: innerBuf, top: imgY, left: imgX }])
    .png({ compressionLevel: 9 })
    .toFile(out);
  const { size } = fs.statSync(out);
  console.log(`✓ screenshot-${idx + 1}.png  ${W}x${H}  ${(size / 1024).toFixed(1)} KB  (${srcRel})`);
}

console.log('\nCWS gallery screenshots:');
for (let i = 0; i < SHOTS.length; i++) {
  await composeShotEntry(SHOTS[i], i);
}

console.log('\nAssets written to:', path.relative(REPO, OUT));
