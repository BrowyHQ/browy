// Builds extension/icons/video/browy-demo.mp4 — a fully-synthesised motion
// reel for the Chrome Web Store listing. No screen recording required.
//
// Pipeline:
//   1. Render N PNG frames (1280x720) into a tmp dir using sharp + SVG.
//   2. Stitch them with ffmpeg into an H.264 mp4.
//
// Aesthetic: same mascot, palette, and 5x7 pixel font as the listing tiles
// and title cards. Scanline grid background. Letter-by-letter wordmark
// reveals. Ken-Burns drift across the gallery screenshots with crossfades.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import ffmpeg from '@ffmpeg-installer/ffmpeg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT_DIR  = path.join(REPO, 'marketing/video');
const TMP_DIR  = path.join(REPO, '.cache/demo-frames');
const OUT_MP4  = path.join(OUT_DIR, 'browy-demo.mp4');
const SHOT_DIR = path.resolve(REPO, '../browy-docs/src/assets/screenshots');
const MASCOT_SVG_PATH = path.join(REPO, 'extension/icons/icon.svg');

fs.rmSync(TMP_DIR, { recursive: true, force: true });
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

// ── canvas / timing ─────────────────────────────────────────────────────
const W = 1280, H = 720;
const FPS = 30;

// Palette (mirrors extension/icons/icon.svg).
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

// ── 5x7 pixel font (subset; extend as needed) ───────────────────────────
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
  '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
  ':': ['.....', '..#..', '.....', '.....', '.....', '..#..', '.....'],
  '>': ['#....', '.#...', '..#..', '...#.', '..#..', '.#...', '#....'],
};

function glyphSvg(ch, scale, color) {
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

function drawWord(word, scale, color, gap = 1) {
  let out = '';
  let x = 0;
  for (const ch of word.toUpperCase()) {
    out += `<g transform="translate(${x},0)">${glyphSvg(ch, scale, color)}</g>`;
    x += (5 + gap) * scale;
  }
  const w = x - gap * scale;
  const h = 7 * scale;
  return { svg: out, w, h };
}

function gridBg(opacity = 0.55) {
  let lines = '';
  for (let y = 0; y < H; y += 4) {
    lines += `<rect x="0" y="${y}" width="${W}" height="1" fill="${C.bgGrid}" opacity="${opacity}"/>`;
  }
  return `<rect width="${W}" height="${H}" fill="${C.bg}"/>${lines}`;
}

// ── Mascot SVG (strip its own backdrop so it composites onto our canvas) ─
const RAW_MASCOT = fs.readFileSync(MASCOT_SVG_PATH, 'utf8');
const MASCOT_INNER = RAW_MASCOT
  .replace(/<\?xml[^?]*\?>/, '')
  .replace(/<svg[^>]*>/, '')
  .replace(/<\/svg>/, '')
  .replace(/<rect[^>]*fill="#0a1f12"[^/]*\/>/g, '');

function mascotG(x, y, size, opacity = 1) {
  const s = size / 256;
  return `<g transform="translate(${x},${y}) scale(${s})" opacity="${opacity}">${MASCOT_INNER}</g>`;
}

// ── Easing ──────────────────────────────────────────────────────────────
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const easeOut   = (t) => 1 - Math.pow(1 - t, 3);
const clamp     = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

// ── Pre-render each gallery screenshot to a buffer at canvas-friendly
// dimensions so we can composite + transform without re-decoding each frame.
async function loadShot(file, targetH = 640) {
  const p = path.join(SHOT_DIR, file);
  if (!fs.existsSync(p)) return null;
  const meta = await sharp(p).metadata();
  const scale = targetH / meta.height;
  const w = Math.round(meta.width * scale);
  const buf = await sharp(p).resize(w, targetH).png().toBuffer();
  return { buf, w, h: targetH };
}

const shots = {
  panel:    await loadShot('panel-empty.png'),
  summary:  await loadShot('panel-summarize.png'),
  devtools: await loadShot('devtools-panel.png'),
  form:     await loadShot('panel-fillform.png'),
  network:  await loadShot('panel-network.png'),
};

// Crisp framing rectangle behind each screenshot.
function frameRect(x, y, w, h) {
  return `<rect x="${x - 4}" y="${y - 4}" width="${w + 8}" height="${h + 8}" fill="${C.brandDeep}"/>`;
}

// ── Scene definitions ───────────────────────────────────────────────────
// Each scene has a duration in seconds and a render(t01, frame) returning
// { svg, composites } where composites is an array of { input, top, left }.

const SCENES = [];

// ── Scene 1: Title (4s) ─────────────────────────────────────────────────
SCENES.push({
  dur: 4,
  render(t) {
    // Mascot fades in 0..0.4, scales from 0.7 to 1.
    const mAlpha = clamp(t / 0.35);
    const mScale = 0.7 + 0.3 * easeOut(mAlpha);
    const baseSize = 380;
    const size = baseSize * mScale;
    const mx = (W - size) / 2;
    const my = 60 + (1 - easeOut(mAlpha)) * 30;

    // Wordmark types out letter by letter starting t=0.4.
    const word = 'BROWY';
    const typeT = clamp((t - 0.4) / 1.2);
    const visible = Math.round(typeT * word.length);
    const shown = word.slice(0, visible);
    const wm = drawWord(shown, 12, C.brandLite, 1);
    const wmFullW = (5 * 5 + 4) * 12;
    const wmX = (W - wmFullW) / 2;
    const wmY = 420;

    // Tagline fades in t=1.6..2.2.
    const tagAlpha = clamp((t - 1.6) / 0.6);
    const tag = drawWord('AI AGENT IN YOUR BROWSER', 4, C.brandSoft, 1);
    const tagX = (W - tag.w) / 2;
    const tagY = wmY + 12 * 7 + 40;

    // Sub fades in t=2.2..2.8.
    const subAlpha = clamp((t - 2.2) / 0.6);
    const sub = drawWord('POWERED BY GITHUB COPILOT', 3, C.inkDim, 1);
    const subX = (W - sub.w) / 2;
    const subY = tagY + 4 * 7 + 30;

    // LED bar grows.
    const ledW = clamp(t / 1) * 120;

    // Vignette fade-out 3.5..4.
    const vAlpha = clamp((t - 3.5) / 0.5);

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" shape-rendering="crispEdges">
  ${gridBg()}
  ${mascotG(mx, my, size, mAlpha)}
  <g transform="translate(${wmX},${wmY})" opacity="${clamp(typeT * 1.5)}">${wm.svg}</g>
  <g transform="translate(${tagX},${tagY})" opacity="${tagAlpha}">${tag.svg}</g>
  <g transform="translate(${subX},${subY})" opacity="${subAlpha}">${sub.svg}</g>
  <rect x="${(W - 200)/2}" y="${H - 60}" width="${ledW}" height="3" fill="${C.led}"/>
  <rect x="0" y="0" width="${W}" height="${H}" fill="#000" opacity="${vAlpha}"/>
</svg>`;
    return { svg, composites: [] };
  },
});

// ── Helper: shot scene with Ken Burns + caption + side wordmark ─────────
function shotScene({ shot, caption, blurb, dur }) {
  return {
    dur,
    render(t) {
      const t01 = t / dur;
      // Ken Burns: zoom from 1.0 to 1.08, drift 30px right.
      const zoom = 1 + 0.08 * easeInOut(t01);
      const drift = -15 + 30 * easeInOut(t01);
      const drawW = Math.round(shot.w * zoom);
      const drawH = Math.round(shot.h * zoom);
      const slotX = 540, slotY = 40, slotW = 700, slotH = 640;
      const imgX = slotX + Math.round((slotW - drawW) / 2) + Math.round(drift);
      const imgY = slotY + Math.round((slotH - drawH) / 2);

      // Fade in (0..0.25s), fade out (last 0.25s). Brief enough to read as
      // a beat, not a long dip to black.
      const fadeIn  = clamp(t / 0.25);
      const fadeOut = 1 - clamp((t - (dur - 0.25)) / 0.25);
      const sceneAlpha = Math.min(fadeIn, fadeOut);

      // Caption typewriter, 0.3..1.5s.
      const typeT = clamp((t - 0.3) / 1.2);
      const capShown = caption.slice(0, Math.round(typeT * caption.length));
      const cap = drawWord(capShown, 5, C.brandLite, 1);
      const capX = 60;
      const capY = 220;

      // Blurb fades in.
      const blurbAlpha = clamp((t - 1.4) / 0.6);
      const b1 = drawWord(blurb[0] || '', 3, C.brandSoft, 1);
      const b2 = drawWord(blurb[1] || '', 3, C.brandSoft, 1);
      const bY = capY + 5 * 7 + 50;

      // Side wordmark.
      const wm = drawWord('BROWY', 3, C.brandDeep, 1);

      const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" shape-rendering="crispEdges">
  ${gridBg()}
  <g transform="translate(60,80)" opacity="${sceneAlpha * 0.7}">${wm.svg}</g>
  <rect x="60" y="180" width="60" height="3" fill="${C.brandDeep}" opacity="${sceneAlpha}"/>
  <g transform="translate(${capX},${capY})" opacity="${sceneAlpha}">${cap.svg}</g>
  <g transform="translate(${capX},${bY})" opacity="${sceneAlpha * blurbAlpha}">${b1.svg}</g>
  <g transform="translate(${capX},${bY + 3 * 7 + 16})" opacity="${sceneAlpha * blurbAlpha}">${b2.svg}</g>
  ${frameRect(imgX, imgY, drawW, drawH)}
  <rect x="0" y="${H - 12}" width="${W}" height="2" fill="${C.brandDeep}" opacity="${sceneAlpha}"/>
  <rect x="60" y="${H - 10}" width="60" height="2" fill="${C.led}" opacity="${sceneAlpha}"/>
</svg>`;
      // Composite the (already resized) image with global scene alpha
      // applied as an opacity layer baked via composite blend.
      const composites = [];
      if (shot && shot.buf) {
        composites.push({
          input: shot.buf,
          top: imgY,
          left: imgX,
          // sharp's composite doesn't support per-input opacity directly,
          // but the scene alpha is already low only at 0.4s edges and the
          // bg behind the frame is pure C.bg so a black overlay on top
          // gives an acceptable in/out fade.
        });
      }
      // If we need fading on the image, draw a scrim over it.
      const scrimAlpha = 1 - sceneAlpha;
      if (scrimAlpha > 0.01) {
        const scrim = Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
             <rect width="${W}" height="${H}" fill="#0a1f12" opacity="${scrimAlpha}"/>
           </svg>`
        );
        composites.push({ input: scrim, top: 0, left: 0 });
      }
      return { svg, composites };
    },
  };
}

// Define content-driven shots only if their source exists; fall back to
// other shots so we always end up with 4 mid-scenes.
function pick(...keys) { for (const k of keys) if (shots[k]) return shots[k]; return null; }

const sPanel    = pick('panel', 'summary', 'form', 'network', 'devtools');
const sSummary  = pick('summary', 'panel', 'form', 'network', 'devtools');
const sDevtools = pick('devtools', 'panel', 'summary', 'form', 'network');
const sNetwork  = pick('network', 'form', 'summary', 'panel', 'devtools');

if (sPanel)    SCENES.push(shotScene({ shot: sPanel,    caption: 'SIDE PANEL',     blurb: ['ASK IN PLAIN ENGLISH', 'ON ANY OPEN TAB'],    dur: 4 }));
if (sSummary)  SCENES.push(shotScene({ shot: sSummary,  caption: 'WATCH IT WORK',  blurb: ['TOOL STEPS STREAM LIVE', 'NO COPY  NO PASTE'], dur: 4 }));
if (sDevtools) SCENES.push(shotScene({ shot: sDevtools, caption: 'DEVTOOLS NATIVE',blurb: ['SLASH COMMANDS', 'LIVE JS REPL'],            dur: 4 }));
if (sNetwork)  SCENES.push(shotScene({ shot: sNetwork,  caption: 'INSPECT THE PAGE', blurb: ['NETWORK  CONSOLE  DOM', 'AT YOUR REQUEST'], dur: 4 }));

// ── Scene N: Outro (4s) ─────────────────────────────────────────────────
SCENES.push({
  dur: 4,
  render(t) {
    // Fade in scrim.
    const fadeIn = clamp(t / 0.5);
    const mascotSize = 220;
    const mx = (W - mascotSize) / 2;
    const my = 110;

    const head = drawWord('TRY IT', 10, C.brandLite, 1);
    const headX = (W - head.w) / 2;
    const headY = 380;
    const headAlpha = clamp((t - 0.4) / 0.5);

    // URL types out from t=1.0..2.5.
    const url = 'BROWY.DEV';
    const typeT = clamp((t - 1.0) / 1.5);
    const shown = url.slice(0, Math.round(typeT * url.length));
    const u1 = drawWord(shown, 8, C.brandSoft, 1);
    const u1FullW = (url.length * 5 + (url.length - 1)) * 8;
    const u1X = (W - u1FullW) / 2;
    const u1Y = headY + 10 * 7 + 50;

    // Repo URL fades in 2.6..3.2.
    const repoAlpha = clamp((t - 2.6) / 0.6);
    const u2 = drawWord('GITHUB.COM/BROWYHQ', 4, C.inkDim, 1);
    const u2X = (W - u2.w) / 2;
    const u2Y = u1Y + 8 * 7 + 36;

    // Caret blink at end of typing url.
    const caretOn = (Math.floor(t * 2) % 2) === 0;
    let caret = '';
    if (typeT > 0 && typeT < 1) {
      const caretX = u1X + shown.length * 6 * 8;
      caret = `<rect x="${caretX}" y="${u1Y}" width="${4 * 8}" height="${7 * 8}" fill="${C.brand}" opacity="${caretOn ? 0.7 : 0.15}"/>`;
    }

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" shape-rendering="crispEdges">
  ${gridBg()}
  ${mascotG(mx, my, mascotSize, fadeIn)}
  <g transform="translate(${headX},${headY})" opacity="${headAlpha}">${head.svg}</g>
  <g transform="translate(${u1X},${u1Y})">${u1.svg}</g>
  ${caret}
  <g transform="translate(${u2X},${u2Y})" opacity="${repoAlpha}">${u2.svg}</g>
  <rect x="0" y="${H - 12}" width="${W}" height="3" fill="${C.brandDeep}"/>
  <rect x="120" y="${H - 9}" width="120" height="3" fill="${C.led}"/>
</svg>`;
    return { svg, composites: [] };
  },
});

// ── Render frames ───────────────────────────────────────────────────────
const totalDur = SCENES.reduce((a, s) => a + s.dur, 0);
const totalFrames = Math.round(totalDur * FPS);
console.log(`Rendering ${SCENES.length} scenes · ${totalDur}s · ${totalFrames} frames @ ${FPS}fps...`);

let frameIdx = 0;
const t0 = Date.now();
for (const scene of SCENES) {
  const frames = Math.round(scene.dur * FPS);
  for (let f = 0; f < frames; f++) {
    const tInScene = f / FPS;
    const { svg, composites } = scene.render(tInScene, f);
    const out = path.join(TMP_DIR, `f${String(frameIdx).padStart(5, '0')}.png`);
    let pipe = sharp(Buffer.from(svg));
    if (composites.length) pipe = pipe.composite(composites);
    await pipe.png({ compressionLevel: 6 }).toFile(out);
    frameIdx++;
    if (frameIdx % 30 === 0) {
      const dt = (Date.now() - t0) / 1000;
      process.stdout.write(`\r  ${frameIdx}/${totalFrames}  (${(frameIdx / dt).toFixed(1)} fps render)`);
    }
  }
}
process.stdout.write(`\r  ${totalFrames}/${totalFrames}  done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

// ── Encode with ffmpeg ──────────────────────────────────────────────────
console.log('\nEncoding mp4...');
const args = [
  '-y',
  '-framerate', String(FPS),
  '-i', path.join(TMP_DIR, 'f%05d.png'),
  '-c:v', 'libx264',
  '-pix_fmt', 'yuv420p',
  '-preset', 'medium',
  '-crf', '20',
  '-movflags', '+faststart',
  OUT_MP4,
];
const r = spawnSync(ffmpeg.path, args, { stdio: 'inherit' });
if (r.status !== 0) {
  console.error('ffmpeg failed with code', r.status);
  process.exit(1);
}

const { size } = fs.statSync(OUT_MP4);
console.log(`\n✓ ${path.relative(REPO, OUT_MP4)}  ${(size / 1024).toFixed(1)} KB  ${totalDur}s`);

// Clean up frame cache (keep only the mp4).
fs.rmSync(TMP_DIR, { recursive: true, force: true });
