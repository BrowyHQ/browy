// Live browser probe: independently inspect what the user's browser
// actually shows, so we can verify the agent's claims (ground truth).
//
// Connects directly to Brave/Chrome over CDP — separate from the agent.

import { chromium } from 'playwright-core';

const CDP_URL = process.env.CDP_URL || 'http://localhost:9222';

export async function probe() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  if (!ctx) { await browser.close(); return { tabs: [], focused: null }; }
  const pages = ctx.pages();

  const tabs = [];
  let focused = null;
  for (const p of pages) {
    let visibility = 'unknown';
    let title = '';
    try {
      visibility = await p.evaluate(() => document.visibilityState).catch(() => 'unknown');
      title = await p.title().catch(() => '');
    } catch {}
    const entry = { url: p.url(), title, visibility };
    tabs.push(entry);
    if (visibility === 'visible' && !p.url().startsWith('about:')) focused = entry;
  }
  await browser.close();
  return { tabs, focused };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  probe().then((r) => console.log(JSON.stringify(r, null, 2))).catch((e) => { console.error(e); process.exit(1); });
}
