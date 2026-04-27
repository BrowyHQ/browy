// Render the Browy UIs to PNG screenshots so we can review styling.
// Output: test-screenshots/ui-*.png
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';

function findChrome() {
  const guesses = [
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const g of guesses) if (existsSync(g)) return g;
  throw new Error('No Chromium browser found');
}

mkdirSync('test-screenshots', { recursive: true });

const fixtures = {
  // Mock WS messages we'll inject into each page so we don't need a live backend
  browsers: { type: 'browsers_status', browsers: [
    { brand: 'Brave',  port: 9222, installed: true,  connected: true  },
    { brand: 'Edge',   port: 9223, installed: true,  connected: false },
    { brand: 'Chrome', port: 9224, installed: false, connected: false },
  ]},
  active: { type: 'active_browsers', active: [
    { brand: 'Brave', port: 9222, tabCount: 14, activeUrl: 'https://news.ycombinator.com/', activeTitle: 'Hacker News' },
  ]},
  models: { type: 'models_list', models: [
    { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', vendor: 'Anthropic' },
    { id: 'gpt-5.2-2', name: 'GPT-5.2', vendor: 'OpenAI' },
    { id: 'gpt-5-mini', name: 'GPT-5 mini', vendor: 'OpenAI' },
  ]},
  current: { type: 'current_model', id: 'claude-sonnet-4.5' },
  focused: { type: 'focused_tab', url: 'https://news.ycombinator.com/', title: 'Hacker News', brand: 'Brave', tabCount: 14 },
  delta: { type: 'delta', text: 'Sure — here are the top stories on Hacker News right now: ...' },
};

async function shoot(page, file, w, h) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(200);
  await page.screenshot({ path: file, omitBackground: false });
  console.log(' →', file);
}

(async () => {
  const browser = await chromium.launch({ executablePath: findChrome(), headless: true });

  // Helper to install fake-WS on a context. Uses dispatchEvent so it works
  // for both `ws.onmessage =` (index.html) and `ws.addEventListener` (settings.html).
  async function installStub(ctx, msgs) {
    await ctx.addInitScript((data) => {
      class FakeWS extends EventTarget {
        constructor() {
          super();
          this.readyState = 0;
          setTimeout(() => {
            this.readyState = 1;
            this.dispatchEvent(new Event('open'));
            if (this.onopen) this.onopen(new Event('open'));
            for (const m of data) {
              const ev = new MessageEvent('message', { data: JSON.stringify(m) });
              this.dispatchEvent(ev);
              if (this.onmessage) this.onmessage(ev);
            }
          }, 50);
        }
        send() {} close() {}
      }
      window.WebSocket = FakeWS;
      window.winctl = {
        closeSelf: () => {}, openSettings: () => {}, close: () => {},
        minimize: () => {}, hide: () => {},
        getBounds: async () => ({ x: 0, y: 0, width: 460, height: 600 }),
        setPos: () => {}, setSize: () => {}, dragStart: () => {}, dragEnd: () => {},
      };
    }, msgs);
  }

  const indexUrl = 'file:///' + path.resolve('src/ui/index.html').replace(/\\/g, '/');
  const settingsUrl = 'file:///' + path.resolve('src/ui/settings.html').replace(/\\/g, '/');

  // ── Main UI (populated) ─────────────────────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 400, height: 620 }, deviceScaleFactor: 1 });
    await installStub(ctx, [fixtures.browsers, fixtures.focused, fixtures.delta]);
    const page = await ctx.newPage();
    await page.goto(indexUrl);
    await page.waitForTimeout(800);
    await shoot(page, 'test-screenshots/ui-main.png', 400, 620);
    await page.evaluate(() => document.body.classList.add('focused'));
    await shoot(page, 'test-screenshots/ui-main-focused.png', 400, 620);
    await ctx.close();
  }

  // ── Settings UI (populated) ─────────────────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 460, height: 600 }, deviceScaleFactor: 1 });
    await installStub(ctx, [fixtures.browsers, fixtures.active, fixtures.current, fixtures.models]);
    const page = await ctx.newPage();
    await page.goto(settingsUrl);
    await page.waitForTimeout(800);
    await shoot(page, 'test-screenshots/ui-settings.png', 460, 600);
    await ctx.close();
  }

  // ── Settings UI — empty (WS connects but no data) ───────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 460, height: 600 } });
    await installStub(ctx, []);
    const page = await ctx.newPage();
    await page.goto(settingsUrl);
    await page.waitForTimeout(600);
    await shoot(page, 'test-screenshots/ui-settings-empty.png', 460, 600);
    await ctx.close();
  }

  // ── Main UI — offline (WS throws) ───────────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 400, height: 620 } });
    await ctx.addInitScript(() => {
      window.WebSocket = class { constructor() { throw new Error('refused'); } };
      window.winctl = {
        closeSelf:()=>{}, openSettings:()=>{}, close:()=>{}, minimize:()=>{}, hide:()=>{},
        getBounds: async () => ({x:0,y:0,width:400,height:620}),
        setPos:()=>{}, setSize:()=>{}, dragStart:()=>{}, dragEnd:()=>{},
      };
    });
    const page = await ctx.newPage();
    await page.goto(indexUrl).catch(()=>{});
    await page.waitForTimeout(400);
    await shoot(page, 'test-screenshots/ui-main-offline.png', 400, 620);
    await ctx.close();
  }

  // ── Settings UI — offline (WS throws) ───────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 460, height: 600 } });
    await ctx.addInitScript(() => {
      window.WebSocket = class { constructor() { throw new Error('refused'); } };
      window.winctl = { closeSelf:()=>{} };
    });
    const page = await ctx.newPage();
    await page.goto(settingsUrl).catch(()=>{});
    await page.waitForTimeout(400);
    await shoot(page, 'test-screenshots/ui-settings-offline.png', 460, 600);
    await ctx.close();
  }

  await browser.close();
  console.log('done.');
})().catch((e) => { console.error(e); process.exit(1); });
