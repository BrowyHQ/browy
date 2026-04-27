// One-off: generate a 512x512 Browy icon PNG via playwright headless render.
import { chromium } from 'playwright-core';
import { writeFileSync, existsSync } from 'fs';

function findChrome() {
  const guesses = [
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const g of guesses) if (existsSync(g)) return g;
  throw new Error('No Chromium-based browser found');
}

const html = `<!DOCTYPE html><html><body style="margin:0;background:transparent">
<canvas id="c" width="512" height="512"></canvas>
<script>
const ctx = document.getElementById('c').getContext('2d');
ctx.imageSmoothingEnabled = false;
ctx.fillStyle = '#0d1310';
ctx.fillRect(0, 0, 512, 512);
const G = 16, S = 32;
function px(x, y, c) { ctx.fillStyle = c; ctx.fillRect(x*S, y*S, S, S); }
const BODY = '#c5f04b', EYE = '#0d1310', BLU = '#4ade80';
const body = [
  '..############..',
  '.##############.',
  '################',
  '################',
  '################',
  '##.##########.##',
  '################',
  '################',
  '################',
  '##..########..##',
  '################',
  '################',
  '.##############.',
  '..############..',
  '...##########...',
  '....########....',
];
for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) if (body[y][x] === '#') px(x, y, BODY);
px(5, 6, EYE); px(6, 6, EYE); px(10, 6, EYE); px(11, 6, EYE);
px(7, 9, EYE); px(8, 9, EYE);
px(3, 8, BLU); px(12, 8, BLU);
</script></body></html>`;

(async () => {
  const exe = findChrome();
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.setContent(html);
  await page.waitForTimeout(150);
  const buf = await page.locator('#c').screenshot({ omitBackground: true });
  writeFileSync('src/ui/icon.png', buf);
  writeFileSync('build-resources/icon.png', buf);
  console.log('icon.png written:', buf.length, 'bytes');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
