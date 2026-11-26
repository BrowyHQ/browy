// Real panel, service worker, tab bridge and scheduler in a throwaway browser.
// Both workers use the bundled Copilot CLI. Only model responses are fixtures.
// --live uses a hosted model instead (requires normal Copilot authentication).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const live = process.argv.includes('--live');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'browy-parallel-'));
const ext = path.join(tmp, 'extension');
const cache = path.join(root, 'tests', '.cache');
await fs.mkdir(cache, { recursive: true });
const out = await fs.mkdtemp(path.join(cache, 'parallel-'));
const codes = { '/a': 'AMBER-' + randomUUID().slice(0, 8), '/b': 'JADE-' + randomUUID().slice(0, 8) };
const model = live ? process.env.BA_MODEL || 'claude-haiku-4.5' : 'gpt-4.1';
const cwd = process.cwd();
const server = http.createServer(async (req, res) => {
  if (req.url === '/v1/models') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model', owned_by: 'fixture' }] }));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { messages, tools, stream } = JSON.parse(Buffer.concat(chunks).toString());
    const info = tools?.find(t => t.function?.name === 'get_page_info');
    const result = JSON.stringify(messages.filter(m => m.role === 'tool')).match(/(?:JADE|AMBER)-[a-f0-9]{8}/)?.[0];
    const call = !result && info ? { id: 'call_' + randomUUID(), type: 'function', function: { name: info.function.name, arguments: '{}' } } : null;
    const delta = call ? { tool_calls: [call] } : { content: result || 'Fixture chat' };
    const meta = { id: 'chatcmpl-fixture', model, created: Math.floor(Date.now() / 1000) };
    const finish_reason = call ? 'tool_calls' : 'stop';
    if (stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (call) call.index = 0;
      for (const choice of [{ delta: { role: 'assistant', ...delta }, finish_reason: null }, { delta: {}, finish_reason }]) {
        res.write('data: ' + JSON.stringify({ ...meta, object: 'chat.completion.chunk', choices: [{ index: 0, ...choice }] }) + '\n\n');
      }
      res.end('data: [DONE]\n\n');
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ...meta, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', ...delta }, finish_reason }] }));
    }
    return;
  }
  if (!(req.url in codes)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<title>Fixture</title><p>${codes[req.url] || 'fixture'}</p>`);
});
let browser, runner, pumping, pumpError, done = false;
const sent = [], received = [], held = [], children = [];
const until = async (why, predicate, ms = live ? 90000 : 30000) => {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (pumpError) throw pumpError;
    const failure = received.find(m => m.type === 'chat.error' || (m.type === 'chat.done' && /^Error:/.test(m.text)));
    if (failure) throw new Error(`${why}: ${failure.message || failure.text}`);
    if (Date.now() >= end) throw new Error(`Timed out: ${why}`);
    await delay(20);
  }
};

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  await fs.cp(path.join(root, 'extension'), ext, { recursive: true });
  const sw = path.join(ext, 'background.js');
  // Exchange native frames through Playwright instead of installing or
  // registering a native host on the machine running the test.
  await fs.writeFile(sw, `
    const testOutbound = [], testListeners = [];
    chrome.runtime.connectNative = () => ({
      postMessage: m => testOutbound.push(m), onMessage: { addListener: f => testListeners.push(f) },
      onDisconnect: { addListener() {} }, disconnect() {}
    });
    globalThis.exchange = incoming => {
      for (const m of incoming) for (const f of testListeners) f(m);
      return testOutbound.splice(0);
    };
  ` + await fs.readFile(sw, 'utf8'));
  const bundle = path.join(out, 'host.mjs');
  await build({ stdin: { contents: `export { Runner } from './src/agent/runner.ts'; export { Agent } from './src/agent/loop.ts';`, resolveDir: root },
    bundle: true, packages: 'external', platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' });
  const profile = path.join(tmp, 'profile');
  const executablePath = process.env.BROWY_TEST_CHROMIUM || chromium.executablePath();
  browser = await chromium.launchPersistentContext(profile, { executablePath, headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  const a = browser.pages()[0], b = await browser.newPage(), panel = await browser.newPage();
  await Promise.all([a.goto(url + '/a'), b.goto(url + '/b')]);
  // No normal Browy prefs, coding sessions or signed-in browser data.
  const home = path.join(tmp, 'home');
  await fs.mkdir(home);
  process.chdir(home);
  process.env.USERPROFILE = process.env.HOME = home;
  process.env.COPILOT_HOME = path.join(home, '.copilot');
  delete process.env.COPILOT_CLI_PATH;
  if (!live) {
    for (const name of Object.keys(process.env)) if (name.startsWith('COPILOT_PROVIDER')) delete process.env[name];
    Object.assign(process.env, { COPILOT_OFFLINE: 'true', COPILOT_PROVIDER_BASE_URL: url + '/v1',
      COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_WIRE_API: 'completions', COPILOT_MODEL: model,
      COPILOT_AUTO_UPDATE: 'false' });
    // SDK sessions select their provider explicitly, separately from the
    // interactive CLI default. Keep the product path and bundled runtime.
    const { CopilotClient } = createRequire(import.meta.url)('@github/copilot-sdk');
    const provider = { type: 'openai', baseUrl: url + '/v1', wireApi: 'completions' };
    const { createSession, resumeSession } = CopilotClient.prototype;
    CopilotClient.prototype.createSession = function (opts) { return createSession.call(this, { ...opts, provider }); };
    CopilotClient.prototype.resumeSession = function (id, opts) { return resumeSession.call(this, id, { ...opts, provider }); };
  }
  const { Runner, Agent } = await import(pathToFileURL(bundle));
  const agent = new Agent({ model, cdpEndpoints: [] });
  runner = new Runner(agent, { serverVersion: 'fixture', wakeWatch: false });
  await agent.initCopilot();
  children.push(agent.copilotClient.cliProcess);
  runner.markSdkReady(true);
  let deliver, holding = true;
  const inbox = [];
  runner.attach({ id: 'fixture', onMessage: fn => { deliver = fn; }, onClose() {},
    send(m) {
      received.push(m);
      // Both workers must reach a real page read before either gets its
      // result. A serialized host cannot get past this barrier.
      if (holding && m.type === 'cdp.send' && m.method === 'Runtime.evaluate') held.push(m);
      else inbox.push(m);
    } });
  pumping = (async () => {
    while (!done) {
      const batch = await worker.evaluate(frames => globalThis.exchange(frames), inbox.splice(0));
      for (const m of batch) { sent.push(m); deliver(m); }
      await delay(10);
    }
  })().catch(e => { pumpError = e; });
  await worker.evaluate(() => chrome.storage.local.set({ 'browy.guidelines':
    'Only use get_page_info on your starting tab, then give the code in its body. Do not change any tabs.' }));
  await panel.goto(new URL('sidepanel.html', worker.url()).href);
  await panel.waitForFunction(() => sessionReady && parallelChats);
  const sid = () => panel.evaluate(() => BROWY_SESSION_ID);
  const first = await sid();
  const send = async (page, prompt) => {
    await page.bringToFront();
    await panel.evaluate(text => { inp.value = text; inp.dispatchEvent(new Event('input')); goBtn.click(); }, prompt);
  };
  const newChat = async (previous) => {
    await panel.evaluate(() => newChatBtn.click());
    await panel.waitForFunction(id => BROWY_SESSION_ID !== id && sessionReady, previous);
    return sid();
  };
  const show = async (id, running = true) => {
    await panel.evaluate(() => chatsBtn.click());
    const row = panel.locator(`.chat-row[data-id="${id}"]`);
    await row.waitFor();
    await row.evaluate(el => el.click());
    await panel.waitForFunction(([want, running]) => BROWY_SESSION_ID === want && busy === running, [id, running]);
  };
  await send(a, 'Read the code from this page with get_page_info. Reply with just the code.');
  await until('first worker reaches its page', () => held.some(m => m.sessionId === first));
  const secondWindow = browser.waitForEvent('page');
  await worker.evaluate(url => chrome.windows.create({ url, focused: false }), panel.url());
  const otherPanel = await secondWindow;
  await otherPanel.waitForFunction(() => sessionReady && parallelChats);
  assert.notEqual(await otherPanel.evaluate(() => BROWY_SESSION_ID), first);
  assert.ok(!(await otherPanel.locator('#msgs').textContent()).includes('Read the code from this page'));
  await otherPanel.close();
  const second = await newChat(first);
  await send(b, 'Use get_page_info on this tab and reply with just the code.');
  await until('both workers concurrently waiting for different tabs', () => held.some(m => m.sessionId === second));
  const targets = new Map(held.map(m => [m.sessionId, m.tabId]));
  assert.notEqual(targets.get(first), targets.get(second));
  assert.equal(received.filter(m => m.type === 'chat.done').length, 0);
  children.push(runner.sessions.get(second).worker.copilotClient.cliProcess);
  assert.ok(children.every(p => p.pid && p.exitCode == null));
  assert.notEqual(children[0].pid, children[1].pid);
  console.log(`Two concurrent Copilot CLI processes: ${children.map(p => p.pid).join(', ')}`);
  const third = await newChat(second);
  await send(a, 'Queue on the first tab.');
  await until('third request queues behind its original tab', () => received.some(m =>
    m.type === 'chat.queued' && m.sessionId === third && m.tabId === targets.get(first)));
  await panel.evaluate(() => stopBtn.click());
  await until('queued chat stopped', () => received.some(m => m.type === 'chat.done' && m.sessionId === third && m.stopped));
  await show(first);
  await panel.evaluate(() => stopBtn.click());
  await until('first chat stopped independently', () => received.some(m => m.type === 'chat.done' && m.sessionId === first && m.stopped));
  assert.ok(!received.some(m => m.type === 'chat.done' && m.sessionId === second));
  holding = false;
  inbox.push(...held.filter(m => m.sessionId === second));
  await until('surviving worker reads its own tab and finishes', () => received.some(m => m.type === 'chat.done' && m.sessionId === second));
  const reply = received.find(m => m.type === 'chat.done' && m.sessionId === second);
  assert.ok(!reply.stopped && reply.text.includes(codes['/b']) && !reply.text.includes(codes['/a']), reply.text);
  await until('background completion releases the hidden chat', () => sent.some(m => m.type === 'session.end' && m.sessionId === second));
  assert.ok(!(await panel.locator('#msgs').textContent()).includes(codes['/b']));
  await show(second, false);
  await panel.waitForFunction(code => !busy && msgs.textContent.includes(code), codes['/b']);
  assert.ok(!sent.some(m => m.type === '__restart_host'));
  assert.ok(!sent.some(m => m.type === 'chat.cancel' && m.sessionId === second));
  await panel.close();
  await until('panel closure unregisters all chats', () => !runner.sessions.size);
  console.log(`PASS: ${live ? 'hosted' : 'fixture'} model, parallel CLI workers, chat picker, same-tab queuing and independent Stop`);
} finally {
  done = true;
  await pumping;
  try { await runner?.shutdown(); }
  finally {
    await browser?.close();
    server.close();
    process.chdir(cwd);
    await fs.rm(out, { recursive: true, force: true, maxRetries: 3 });
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}
assert.ok(children.every(p => p.exitCode !== null || p.signalCode !== null), 'all test CLIs exited');
