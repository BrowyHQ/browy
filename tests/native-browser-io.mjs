// Real extension worker and host tools, with only the native messaging port
// replaced. No Copilot account, installed host or existing browser profile.
// BROWY_TEST_CHROMIUM may point at a local Chrome for Testing executable.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'browy-native-io-'));
const ext = path.join(temp, 'extension');
const profile = path.join(temp, 'profile');
const downloads = path.join(temp, 'downloads');
let browser;
let downloadRequests = 0;
let deniedRequests = 0;
const server = http.createServer((req, res) => {
  if (req.url === '/denied') { deniedRequests++; res.writeHead(403).end(); return; }
  if (req.url === '/report.csv') {
    downloadRequests++;
    if (!req.headers.cookie?.includes('fixture=ok')) { res.writeHead(403).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="report.csv"' });
    res.end('id,value\n1,42\n');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'fixture=ok; Path=/; HttpOnly' });
  res.end(`<title>Browser IO fixture</title><p id="result">untouched</p>
    <button id="modal" onclick="result.textContent = prompt('Which color?')">Color</button>
    <button id="confirm" onclick="result.textContent = String(confirm('Remove entry?'))">Remove entry</button>
    <script>function pick(multiple) { const f = document.createElement('input'); f.type='file'; f.hidden=true;
      f.multiple=!!multiple; f.onchange=() => result.textContent=Array.from(f.files,v=>v.name).join(',');
      document.body.append(f); f.click(); }</script>
    <button id="upload" onclick="pick(false)">Attach</button>
    <button id="later" onclick="setTimeout(() => pick(true), 150)">Upload receipts</button>
    <input id="direct" type="file" onchange="result.textContent = this.files[0].name">
    <a target="_blank" href="/child">Open report in a new tab</a>`);
});

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  await fs.cp(path.join(root, 'extension'), ext, { recursive: true });
  await fs.appendFile(path.join(ext, 'background.js'), `
    const replies = new Map();
    nativePort = { postMessage(m) { if (m.type === 'tool.result') replies.get(m.callId)?.(m); } };
    globalThis.fixtureRequest = m => new Promise(resolve => {
      sessionToClient.set(m.sessionId, 'fixture');
      replies.set(m.callId, reply => { replies.delete(m.callId); resolve(reply); });
      handleBridgeRequest(m);
    });`);
  await fs.mkdir(path.join(profile, 'Default'), { recursive: true });
  await fs.mkdir(downloads);
  await fs.writeFile(path.join(profile, 'Default', 'Preferences'), JSON.stringify({
    download: { default_directory: downloads, prompt_for_download: true },
  }));
  const upload = path.join(temp, 'example.txt');
  await fs.writeFile(upload, 'Browy test fixture');
  const bundle = path.join(temp, 'host.mjs');
  await build({ stdin: { contents: `export { ExtensionContext } from './src/agent/extension-context.ts';
    export { getAllTools } from './src/agent/tools/browser.ts';`, resolveDir: root },
    bundle: true, format: 'esm', platform: 'node', outfile: bundle, logLevel: 'silent' });
  const { ExtensionContext, getAllTools } = await import(pathToFileURL(bundle));

  browser = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.BROWY_TEST_CHROMIUM || chromium.executablePath(),
    headless: true, downloadsPath: downloads,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  const page = browser.pages()[0] || await browser.newPage();
  page.on('dialog', () => {}); // Playwright otherwise dismisses it before Browy can see it.
  await page.goto(url);
  const makeContext = (sid) => {
    const host = new ExtensionContext(sid, {
      send: (msg) => {
        worker.evaluate((m) => globalThis.fixtureRequest(m), msg).then((reply) => host.handleToolResult(reply),
          (e) => host.handleToolResult({ ...msg, ok: false, error: e.message }));
      },
    }, 5000, true);
    return host.build();
  };
  const ctx = makeContext('fixture-one');
  const other = makeContext('fixture-two');
  const tools = new Map(getAllTools().map((t) => [t.def.name, t]));
  const call = (name, args = {}, context = ctx) => tools.get(name).run(args, context).then(JSON.parse);
  const indexOf = async (selector) => {
    await tools.get('inspect_page').run({}, ctx);
    return Number(await page.locator(selector).getAttribute('data-browy-id'));
  };
  await ctx.getActiveTabInfo();
  await other.getActiveTabInfo();

  const alertOpened = page.waitForEvent('dialog');
  await page.evaluate(() => { setTimeout(() => alert('Page notice'), 0); });
  const alreadyOpen = await alertOpened;
  // Chrome won't reveal this dialog retroactively. A handoff is better than
  // accepting it blind or leaving the user with a spinning tool.
  await assert.rejects(call('handle_dialog'), /already open before Browy connected/);
  await alreadyOpen.dismiss();

  // A blocking click must return control to the model while the dialog is still open.
  await assert.rejects(call('click_element', { selector: '#modal' }), /handle_dialog/);
  const { dialog } = await call('handle_dialog');
  assert.equal(dialog.type, 'prompt');
  assert.equal(dialog.message, 'Which color?');
  await call('handle_dialog', { action: 'accept', id: dialog.id, text: 'teal' });
  assert.equal(await page.locator('#result').textContent(), 'teal');
  await assert.rejects(call('handle_dialog', { action: 'accept', id: dialog.id }), /no longer current/);
  await assert.rejects(call('click_index', { index: await indexOf('#confirm') }), /handle_dialog/);
  const confirmation = (await call('handle_dialog')).dialog;
  assert.equal(confirmation.type, 'confirm');
  await call('handle_dialog', { action: 'dismiss', id: confirmation.id });
  assert.equal(await page.locator('#result').textContent(), 'false');

  const picker = async () => {
    await assert.rejects(call('click_index', { index: await indexOf('#upload') }), /chooser_id/);
    const { dialog } = await call('handle_dialog');
    assert.equal(dialog.type, 'file');
    return dialog.id;
  };
  const id = await picker();
  await assert.rejects(call('upload_file', { chooser_id: id, path: upload }, other), /no longer current/);
  await assert.rejects(call('upload_file', { chooser_id: id, path: JSON.stringify([upload, upload]) }), /does not accept/);
  await call('upload_file', { chooser_id: id, path: upload });
  assert.equal(await page.locator('#result').textContent(), 'example.txt');
  const stale = await picker();
  await page.reload();
  await assert.rejects(call('upload_file', { chooser_id: stale, path: upload }), /no longer current/);
  const another = path.join(temp, 'second.txt');
  await fs.writeFile(another, 'Second fixture');
  await call('upload_index', { index: await indexOf('#later'), path: JSON.stringify([upload, another]), open_picker: true });
  assert.equal(await page.locator('#result').textContent(), 'example.txt,second.txt');
  await call('upload_file', { selector: '#direct', path: another });
  assert.equal(await page.locator('#result').textContent(), 'second.txt');

  // New popup tabs must appear without starting a new turn or changing the tool target.
  const popup = browser.waitForEvent('page');
  await page.locator('a').click();
  const child = await popup;
  await child.waitForLoadState();
  const list = await call('list_tabs');
  const childTab = list.tabs.find((t) => t.url === `${url}/child`);
  assert.ok(childTab);
  assert.equal(await ctx.cdp.send('Runtime.evaluate', { expression: 'location.pathname' }).then((r) => r.result.value), '/');
  const visible = () => worker.evaluate(async () => (await chrome.tabs.query({ active: true })).map(t => t.id));
  const before = await visible();
  await call('switch_tab', { index: String(childTab.index), background: true });
  assert.equal(await ctx.cdp.send('Runtime.evaluate', { expression: 'location.pathname' }).then((r) => r.result.value), '/child');
  assert.deepEqual(await visible(), before);

  const settledDownload = async (item) => {
    const until = Date.now() + 5000;
    while (item.state === 'in_progress' && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
      item = await call('download_status', { id: item.downloadId });
    }
    return item;
  };
  const download = await settledDownload(await call('download_file', { url: `${url}/report.csv`, filename: 'report.csv' }));
  await assert.rejects(call('download_status', { id: download.downloadId }, other), /this chat/);
  assert.equal(download.state, 'complete', JSON.stringify(download));
  assert.equal(path.dirname(download.path), downloads);
  assert.equal(await fs.readFile(download.path, 'utf8'), 'id,value\n1,42\n');
  await assert.rejects(call('download_file', { url: `${url}/report.csv`, filename: '../escape.csv' }), /relative to Downloads/);
  assert.equal(downloadRequests, 1);
  const denied = await settledDownload(await call('download_file', { url: `${url}/denied` }));
  assert.equal(denied.state, 'interrupted');
  assert.ok(denied.error);
  assert.equal(denied.path, undefined);
  assert.equal(deniedRequests, 1);
  const options = await browser.newPage();
  await options.goto(new URL('options.html', worker.url()).href);
  await options.locator('#guidelines').fill('Keep the tracker tab open.');
  await options.locator('#saveGuidelines').click();
  await options.getByText('guidelines saved for your next message').waitFor();
  await options.reload();
  await options.waitForFunction(() => !document.querySelector('#guidelines').disabled);
  assert.equal(await options.locator('#guidelines').inputValue(), 'Keep the tracker tab open.');
  const settingsTab = (await call('list_tabs')).tabs.find(t => t.url === options.url());
  await call('switch_tab', { index: String(settingsTab.index), background: true });
  await assert.rejects(ctx.cdp.send('Runtime.evaluate', { expression: 'document.title' }), /extension pages/);
  console.log('PASS: dialogs, custom file pickers, popup targeting, native downloads and profile guidelines');
} finally {
  await browser?.close();
  server.close();
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 3 });
}
