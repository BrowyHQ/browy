#!/usr/bin/env node
/**
 * Builds marketing/video/browy-demo-shorts.mp4: a 1080x1920 (9:16)
 * vertical reel for YouTube Shorts, Reels, and TikTok. Same scene
 * order, palette, mascot, and chiptune audio as build-demo-video.mjs,
 * but laid out for portrait viewing with safe zones for the mobile
 * UI overlays (top channel name ~150px, right action buttons ~140px,
 * bottom description / hashtags ~250px).
 *
 * Active content area kept inside x=60-980, y=180-1670 so essential
 * text and screenshots stay clear of the YouTube Shorts overlays.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import ffmpeg from '@ffmpeg-installer/ffmpeg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT_DIR  = path.join(REPO, 'marketing/video');
const TMP_DIR  = path.join(REPO, '.cache/demo-shorts-frames');
const OUT_MP4  = path.join(OUT_DIR, 'browy-demo-shorts.mp4');
const SHOT_DIR = path.resolve(REPO, '../browy-docs/src/assets/screenshots');
const MASCOT_SVG_PATH = path.join(REPO, 'extension/icons/icon.svg');

fs.rmSync(TMP_DIR, { recursive: true, force: true });
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const W = 1080, H = 1920;
const FPS = 30;

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

function mascotG(x, y, size, opacity = 1) {
  const s = size / 80;
  return `<g transform="translate(${x},${y}) scale(${s})" opacity="${opacity}">${MASCOT_INNER}</g>`;
}

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const easeOut   = (t) => 1 - Math.pow(1 - t, 3);
const clamp     = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

// Contain-fit each shot inside the mid-scene slot with headroom for Ken
// Burns zoom. Earlier this resized purely by width, which produced images
// far taller than the slot for tall portrait screenshots (panel-summarize
// 800×1320 became 880×1452, taller than the 1120 slot). The centering
// math then made imgY negative and the image spilled over the caption at
// the top AND the CTA at the bottom. Pre-fitting eliminates both.
async function loadShot(file, maxW, maxH) {
  // Allow files to live either next to the docs screenshots (default
  // capture dir) or in marketing/cws (synthesized mockups like the REPL).
  let p = path.join(SHOT_DIR, file);
  if (!fs.existsSync(p)) {
    const alt = path.join(REPO, 'marketing/cws', file);
    if (fs.existsSync(alt)) p = alt; else return null;
  }
  const meta = await sharp(p).metadata();
  const scale = Math.min(maxW / meta.width, maxH / meta.height);
  const w = Math.max(1, Math.round(meta.width * scale));
  const h = Math.max(1, Math.round(meta.height * scale));
  const buf = await sharp(p).resize(w, h).png().toBuffer();
  return { buf, w, h };
}

// Mid-scene slot is 880×1060. Reserve 16 px safety on each side and 4 %
// Ken Burns zoom headroom so the image can never reach the caption above
// or the CTA below.
const SHOT_MAX_W = Math.floor((880 - 32) / 1.04); // 815
const SHOT_MAX_H = Math.floor((1060 - 32) / 1.04); // 988

const shots = {
  panel:    await loadShot('panel-empty.png',           SHOT_MAX_W, SHOT_MAX_H),
  summary:  await loadShot('panel-summarize.png',       SHOT_MAX_W, SHOT_MAX_H),
  devtools: await loadShot('devtools-repl-mockup.png',  SHOT_MAX_W, SHOT_MAX_H)
            || await loadShot('devtools-panel.png',     SHOT_MAX_W, SHOT_MAX_H),
  form:     await loadShot('panel-fillform.png',        SHOT_MAX_W, SHOT_MAX_H),
  network:  await loadShot('panel-network.png',         SHOT_MAX_W, SHOT_MAX_H),
};

function frameRect(x, y, w, h) {
  return `<rect x="${x - 4}" y="${y - 4}" width="${w + 8}" height="${h + 8}" fill="${C.brandDeep}"/>`;
}

const SCENES = [];

// ── Scene 1: Title (4s) ─────────────────────────────────────────────────
SCENES.push({
  dur: 4,
  render(t) {
    // Mascot fades in.
    const mAlpha = clamp(t / 0.35);
    const mScale = 0.7 + 0.3 * easeOut(mAlpha);
    const baseSize = 560;
    const size = baseSize * mScale;
    const mx = (W - size) / 2;
    const my = 280 + (1 - easeOut(mAlpha)) * 30;

    // Wordmark types out.
    const word = 'BROWY';
    const typeT = clamp((t - 0.4) / 1.2);
    const visible = Math.round(typeT * word.length);
    const shown = word.slice(0, visible);
    const wm = drawWord(shown, 22, C.brandLite, 2);
    const wmFullW = (5 * 5 + 4 * 2) * 22;
    const wmX = (W - wmFullW) / 2;
    const wmY = 1000;

    // Tagline 2 lines.
    const tagAlpha = clamp((t - 1.6) / 0.6);
    const tag1 = drawWord('AI AGENT THAT LIVES', 8, C.brandSoft, 1);
    const tag2 = drawWord('IN YOUR BROWSER', 8, C.brandSoft, 1);
    const tag1X = (W - tag1.w) / 2;
    const tag2X = (W - tag2.w) / 2;
    const tag1Y = wmY + 22 * 7 + 60;
    const tag2Y = tag1Y + 8 * 7 + 30;

    // Subtitle.
    const subAlpha = clamp((t - 2.2) / 0.6);
    const sub = drawWord('FREE AND OPEN SOURCE', 5, C.inkDim, 1);
    const subX = (W - sub.w) / 2;
    const subY = tag2Y + 8 * 7 + 60;

    // LED bar grows.
    const ledW = clamp(t / 1) * 200;

    // Vignette fade-out 3.5..4.
    const vAlpha = clamp((t - 3.5) / 0.5);

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" shape-rendering="crispEdges">
  ${gridBg()}
  ${mascotG(mx, my, size, mAlpha)}
  <g transform="translate(${wmX},${wmY})" opacity="${clamp(typeT * 1.5)}">${wm.svg}</g>
  <g transform="translate(${tag1X},${tag1Y})" opacity="${tagAlpha}">${tag1.svg}</g>
  <g transform="translate(${tag2X},${tag2Y})" opacity="${tagAlpha}">${tag2.svg}</g>
  <g transform="translate(${subX},${subY})" opacity="${subAlpha}">${sub.svg}</g>
  <rect x="${(W - 200) / 2}" y="${H - 100}" width="${ledW}" height="4" fill="${C.led}"/>
  <rect x="0" y="0" width="${W}" height="${H}" fill="#000" opacity="${vAlpha}"/>
</svg>`;
    return { svg, composites: [] };
  },
});

// ── Mid-scenes: caption top, screenshot below, brand bar ────────────────
function shotScene({ shot, caption, blurb, dur }) {
  return {
    dur,
    render(t) {
      const t01 = t / dur;
      // Gentle ken-burns: small zoom + small vertical drift. Bounds chosen
      // so that even at max zoom + drift the image stays inside the slot
      // (loadShot pre-fits to (slotW-32)/1.04, (slotH-32)/1.04).
      const zoom = 1 + 0.04 * easeInOut(t01);
      const drift = -8 + 16 * easeInOut(t01);
      const drawW = Math.round(shot.w * zoom);
      const drawH = Math.round(shot.h * zoom);
      // Slot pulled in from the original 380-1500 range so the top clears
      // the blurb (ends at y≈399) and the bottom clears the CTA divider
      // (at y=1500), even at max zoom + max drift.
      const slotX = 70, slotY = 420, slotW = 880, slotH = 1060;
      const imgX = slotX + Math.round((slotW - drawW) / 2);
      const imgY = slotY + Math.round((slotH - drawH) / 2) + Math.round(drift);

      const fadeIn  = clamp(t / 0.25);
      const fadeOut = 1 - clamp((t - (dur - 0.25)) / 0.25);
      const sceneAlpha = Math.min(fadeIn, fadeOut);

      // Caption typewriter at top.
      const typeT = clamp((t - 0.3) / 1.2);
      const capShown = caption.slice(0, Math.round(typeT * caption.length));
      const cap = drawWord(capShown, 9, C.brandLite, 1);
      const capX = 70;
      const capY = 220;

      // Blurb fades in below caption.
      const blurbAlpha = clamp((t - 1.4) / 0.6);
      const b1 = drawWord(blurb[0] || '', 5, C.brandSoft, 1);
      const b2 = drawWord(blurb[1] || '', 5, C.brandSoft, 1);
      const bY = capY + 9 * 7 + 30;

      // Top BROWY watermark (small).
      const wm = drawWord('BROWY', 5, C.brandDeep, 1);

      // Persistent bottom CTA zone — fades in at scene start so the
      // lower third never reads as dead space.
      const ctaAlpha = clamp((t - 0.4) / 0.4);
      const ctaText = drawWord('ADD TO CHROME', 7, C.led, 1);
      const ctaX = (W - ctaText.w) / 2;
      const ctaY = 1560;
      const repoText = drawWord('BROWYHQ.GITHUB.IO', 5, C.inkDim, 1);
      const repoX = (W - repoText.w) / 2;
      const repoY = ctaY + 7 * 7 + 30;
      const dividerY = 1500;
      const dividerW = 260;
      const dividerX = (W - dividerW) / 2;

      const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" shape-rendering="crispEdges">
  ${gridBg()}
  <g transform="translate(70,140)" opacity="${sceneAlpha * 0.7}">${wm.svg}</g>
  <rect x="70" y="190" width="80" height="3" fill="${C.brandDeep}" opacity="${sceneAlpha}"/>
  <g transform="translate(${capX},${capY})" opacity="${sceneAlpha}">${cap.svg}</g>
  <g transform="translate(${capX},${bY})" opacity="${sceneAlpha * blurbAlpha}">${b1.svg}</g>
  <g transform="translate(${capX},${bY + 5 * 7 + 16})" opacity="${sceneAlpha * blurbAlpha}">${b2.svg}</g>
  ${frameRect(imgX, imgY, drawW, drawH)}
  <rect x="${dividerX}" y="${dividerY}" width="${dividerW}" height="3" fill="${C.brandDeep}" opacity="${sceneAlpha * ctaAlpha}"/>
  <g transform="translate(${ctaX},${ctaY})" opacity="${sceneAlpha * ctaAlpha}">${ctaText.svg}</g>
  <g transform="translate(${repoX},${repoY})" opacity="${sceneAlpha * ctaAlpha}">${repoText.svg}</g>
  <rect x="0" y="${H - 60}" width="${W}" height="3" fill="${C.brandDeep}" opacity="${sceneAlpha}"/>
  <rect x="120" y="${H - 57}" width="120" height="3" fill="${C.led}" opacity="${sceneAlpha}"/>
</svg>`;
      const composites = [];
      if (shot && shot.buf) {
        composites.push({ input: shot.buf, top: imgY, left: imgX });
      }
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

function pick(...keys) { for (const k of keys) if (shots[k]) return shots[k]; return null; }

const sPanel    = pick('summary', 'panel', 'form', 'network', 'devtools');
const sDevtools = pick('devtools', 'panel', 'summary', 'form', 'network');
const sForm     = pick('form', 'panel', 'summary', 'network', 'devtools');
const sNetwork  = pick('network', 'form', 'summary', 'panel', 'devtools');

if (sPanel)    SCENES.push(shotScene({ shot: sPanel,    caption: 'SIDE PANEL',    blurb: ['TALK TO YOUR TABS',     'GET ANSWERS BACK'],    dur: 4 }));
if (sDevtools) SCENES.push(shotScene({ shot: sDevtools, caption: 'DEVTOOLS CLI', blurb: ['TERMINAL REPL',         'NEXT TO INSPECTOR'],   dur: 4 }));
if (sForm)     SCENES.push(shotScene({ shot: sForm,     caption: 'FILL FORMS',    blurb: ['IN ONE PROMPT',         'STOPS BEFORE SUBMIT'], dur: 4 }));
if (sNetwork)  SCENES.push(shotScene({ shot: sNetwork,  caption: 'READ NETWORK',  blurb: ['REQUESTS AND CONSOLE',  'STRAIGHT FROM CHAT'],  dur: 4 }));

// ── Scene N: Outro (4s) ─────────────────────────────────────────────────
SCENES.push({
  dur: 4,
  render(t) {
    const fadeIn = clamp(t / 0.5);
    const mascotSize = 360;
    const mx = (W - mascotSize) / 2;
    const my = 280;

    const head = drawWord('TRY IT', 18, C.brandLite, 1);
    const headX = (W - head.w) / 2;
    const headY = 800;
    const headAlpha = clamp((t - 0.4) / 0.5);

    const url = 'ADD TO CHROME';
    const typeT = clamp((t - 1.0) / 1.5);
    const shown = url.slice(0, Math.round(typeT * url.length));
    const u1 = drawWord(shown, 11, C.brandSoft, 1);
    const u1FullW = (url.length * 5 + (url.length - 1)) * 11;
    const u1X = (W - u1FullW) / 2;
    const u1Y = headY + 18 * 7 + 80;

    const repoAlpha = clamp((t - 2.6) / 0.6);
    const u2 = drawWord('BROWYHQ.GITHUB.IO', 6, C.inkDim, 1);
    const u2X = (W - u2.w) / 2;
    const u2Y = u1Y + 11 * 7 + 60;

    const caretOn = (Math.floor(t * 2) % 2) === 0;
    let caret = '';
    if (typeT > 0 && typeT < 1) {
      const caretX = u1X + shown.length * 6 * 11;
      caret = `<rect x="${caretX}" y="${u1Y}" width="${4 * 11}" height="${7 * 11}" fill="${C.brand}" opacity="${caretOn ? 0.7 : 0.15}"/>`;
    }

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" shape-rendering="crispEdges">
  ${gridBg()}
  ${mascotG(mx, my, mascotSize, fadeIn)}
  <g transform="translate(${headX},${headY})" opacity="${headAlpha}">${head.svg}</g>
  <g transform="translate(${u1X},${u1Y})">${u1.svg}</g>
  ${caret}
  <g transform="translate(${u2X},${u2Y})" opacity="${repoAlpha}">${u2.svg}</g>
  <rect x="0" y="${H - 60}" width="${W}" height="4" fill="${C.brandDeep}"/>
  <rect x="120" y="${H - 56}" width="200" height="4" fill="${C.led}"/>
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

// ── Synthesise chiptune audio (same as horizontal) ─────────────────────
console.log('\nSynthesising audio...');
const SR = 44100;
const TOTAL_SAMPLES = Math.round(totalDur * SR);
const audio = new Float32Array(TOTAL_SAMPLES);

const NOTE = {
  F2: 87.31,  G2: 98.00,  A2: 110.00, C3: 130.81,
  F4: 349.23, G4: 392.00, A4: 440.00, B4: 493.88,
  C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46,
  G5: 783.99, A5: 880.00, B5: 987.77, C6: 1046.50,
};

function square(buf, freq, start, dur, vol) {
  const period = SR / freq;
  const attack = SR * 0.005;
  for (let i = 0; i < dur && start + i < buf.length; i++) {
    const env = Math.min(1, i / attack) * Math.max(0, 1 - i / dur);
    const phase = (i % period) / period;
    buf[start + i] += (phase < 0.5 ? 1 : -1) * vol * env;
  }
}

function triangle(buf, freq, start, dur, vol) {
  const period = SR / freq;
  const attack = SR * 0.02;
  for (let i = 0; i < dur && start + i < buf.length; i++) {
    const env = Math.min(1, i / attack) * Math.max(0.4, 1 - i / dur);
    const phase = (i % period) / period;
    buf[start + i] += (4 * Math.abs(phase - 0.5) - 1) * vol * env;
  }
}

const progression = [
  { bass: 'A2', arp: ['A4', 'C5', 'E5', 'A5', 'E5', 'C5'] },
  { bass: 'F2', arp: ['F4', 'A4', 'C5', 'F5', 'C5', 'A4'] },
  { bass: 'C3', arp: ['C5', 'E5', 'G5', 'C6', 'G5', 'E5'] },
  { bass: 'G2', arp: ['G4', 'B4', 'D5', 'G5', 'D5', 'B4'] },
];

const CHORD_DUR_S = 2;
const CHORDS_TOTAL = Math.floor(totalDur / CHORD_DUR_S);
for (let c = 0; c < CHORDS_TOTAL; c++) {
  const chord = progression[c % progression.length];
  const start = c * CHORD_DUR_S * SR;
  const dur = CHORD_DUR_S * SR;
  triangle(audio, NOTE[chord.bass], start, dur, 0.18);
  const noteDur = Math.floor(dur / chord.arp.length);
  for (let n = 0; n < chord.arp.length; n++) {
    square(audio, NOTE[chord.arp[n]], start + n * noteDur, noteDur, 0.10);
  }
}

const fadeIn = SR * 0.5;
const fadeOut = SR * 1.0;
for (let i = 0; i < fadeIn && i < audio.length; i++) audio[i] *= i / fadeIn;
for (let i = 0; i < fadeOut && i < audio.length; i++) {
  audio[audio.length - 1 - i] *= i / fadeOut;
}

const WAV_PATH = path.join(TMP_DIR, 'audio.wav');
const dataBytes = audio.length * 2;
const wav = Buffer.alloc(44 + dataBytes);
wav.write('RIFF', 0);
wav.writeUInt32LE(36 + dataBytes, 4);
wav.write('WAVE', 8);
wav.write('fmt ', 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(SR, 24);
wav.writeUInt32LE(SR * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(dataBytes, 40);
for (let i = 0; i < audio.length; i++) {
  const v = Math.max(-1, Math.min(1, audio[i]));
  wav.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
}
fs.writeFileSync(WAV_PATH, wav);
console.log(`  audio.wav  ${(wav.length / 1024).toFixed(1)} KB`);

// ── Encode with ffmpeg ──────────────────────────────────────────────────
console.log('\nEncoding mp4 (video + audio)...');
const args = [
  '-y',
  '-framerate', String(FPS),
  '-i', path.join(TMP_DIR, 'f%05d.png'),
  '-i', WAV_PATH,
  '-c:v', 'libx264',
  '-pix_fmt', 'yuv420p',
  '-preset', 'medium',
  '-crf', '20',
  '-c:a', 'aac',
  '-b:a', '128k',
  '-shortest',
  '-movflags', '+faststart',
  OUT_MP4,
];
const r = spawnSync(ffmpeg.path, args, { stdio: 'inherit' });
if (r.status !== 0) {
  console.error('ffmpeg failed with code', r.status);
  process.exit(1);
}

const { size } = fs.statSync(OUT_MP4);
console.log(`\n✓ ${path.relative(REPO, OUT_MP4)}  ${(size / 1024).toFixed(1)} KB  ${totalDur}s  ${W}x${H}`);

fs.rmSync(TMP_DIR, { recursive: true, force: true });
