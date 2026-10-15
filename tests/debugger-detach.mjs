// Losing the debugger on a tab (0.1.14).
//
// Chrome takes chrome.debugger off a tab when it closes, when the user clicks
// Cancel on the "started debugging this browser" bar, and so on. Up to 0.1.13
// the service worker only forgot the attachment: a call running on the tab
// failed with Chrome's bare "Detached while handling command." (or, on builds
// that don't answer it, waited out the host's minute-long deadline), the host
// was never told why, and the next call quietly reattached, bar and all.
//
// This loads extension/background.js against a stand-in chrome API and plays
// the events in the order Chrome 153 sends them.
//
// Run: node tests/debugger-detach.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'extension', 'background.js'), 'utf8');

const failures = [];
const check = (name, cond, detail = '') => { if (!cond) failures.push(`${name}${detail ? `\n    ${detail}` : ''}`); };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const event = () => {
  const listeners = [];
  return { addListener: (f) => listeners.push(f), fire: (...a) => listeners.forEach((f) => f(...a)) };
};

// ── the stand-in chrome API ────────────────────────────────────────────────

const tabs = new Map([[11, { id: 11, windowId: 1 }], [12, { id: 12, windowId: 1 }], [13, { id: 13, windowId: 1 }]]);
const attached = new Set();
const commands = []; // { tabId, method, cb, done }
let attachCalls = 0;
let connectCalls = 0;
const toHost = [];
const toPanel = [];
let nativePort = null;

const chrome = {
  runtime: {
    id: 'test',
    lastError: undefined,
    onConnect: event(),
    connectNative() {
      connectCalls++;
      nativePort = { onMessage: event(), onDisconnect: event(), postMessage: (m) => toHost.push(m), disconnect() {} };
      return nativePort;
    },
  },
  downloads: { onDeterminingFilename: event() },
  alarms: { create() {}, onAlarm: event() },
  action: { onClicked: event() },
  sidePanel: { setPanelBehavior: async () => {} },
  storage: { local: { get: async () => ({}) } },
  tabs: {
    get: async (id) => { if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`); return tabs.get(id); },
    query: async () => [...tabs.values()],
    onRemoved: event(),
    onCreated: event(),
  },
  debugger: {
    onEvent: event(),
    onDetach: event(),
    getTargets: (cb) => cb([]),
    attach({ tabId }, _v, cb) {
      attachCalls++;
      answer(cb, tabs.has(tabId) ? null : `No tab with given id ${tabId}.`, () => attached.add(tabId));
    },
    detach({ tabId }, cb) { attached.delete(tabId); answer(cb, null); },
    sendCommand({ tabId }, method, _params, cb) {
      if (!attached.has(tabId)) return answer(cb, `Debugger is not attached to the tab with id: ${tabId}.`);
      commands.push({ tabId, method, cb, done: false });
    },
  },
};
/** Call a chrome callback the way Chrome does, with lastError set during it. */
function answer(cb, error, before = () => {}, result) {
  setTimeout(() => {
    if (!error) before();
    chrome.runtime.lastError = error ? { message: error } : undefined;
    try { cb && cb(result); } finally { chrome.runtime.lastError = undefined; }
  }, 0);
}
/** Chrome answering the oldest command still open on a tab. */
function finishCommand(tabId, error, result = { result: { value: 1 } }) {
  const c = commands.find((x) => x.tabId === tabId && !x.done);
  if (!c) return false;
  c.done = true;
  answer(c.cb, error, () => {}, result);
  return true;
}

vm.runInNewContext(source, { chrome, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval });

const panel = { name: 'sidepanel-test', onMessage: event(), onDisconnect: event(), postMessage: (m) => toPanel.push(m) };
chrome.runtime.onConnect.fire(panel);
nativePort.onMessage.fire({ type: 'hello.ack', serverVersion: 'test', protocol: 2 });
panel.onMessage.fire({ type: 'session.start', sessionId: 'sp-1', capabilities: ['cdp.activeTab'], disabledTools: [] });
await tick();

const fromHost = (m) => nativePort.onMessage.fire(m);
const cdp = (callId, tabId) => fromHost({ type: 'cdp.send', sessionId: 'sp-1', callId, tabId, method: 'Runtime.evaluate', params: {} });
const resultFor = (callId) => toHost.find((m) => m.type === 'tool.result' && m.callId === callId);
const detachedFor = (tabId) => toHost.filter((m) => m.type === 'cdp.detached' && m.tabId === tabId);

// ── Cancel on the debugging bar, with a call running ───────────────────────
{
  cdp('c1', 11);
  await tick(5);
  const t0 = Date.now();
  chrome.debugger.onDetach.fire({ tabId: 11 }, 'canceled_by_user');
  finishCommand(11, 'Detached while handling command.');
  while (!resultFor('c1') && Date.now() - t0 < 2000) await tick(5);
  const r = resultFor('c1');
  check('a call running when the user clicks Cancel fails at once, saying so',
    r && !r.ok && /You clicked Cancel on Chrome's debugging bar, so Browy lost this tab/.test(r.error) && Date.now() - t0 < 1000, JSON.stringify(r));
  const d = detachedFor(11);
  check('the host is told once, with the reason and the failed call', d.length === 1 && d[0].reason === 'canceled_by_user' && d[0].failed === 1 && d[0].sessionId === 'sp-1', JSON.stringify(d));
  check('so is the panel', toPanel.some((m) => m.type === '__debugger_detached' && m.reason === 'canceled_by_user' && m.sessionId === 'sp-1'));

  const before = attachCalls;
  cdp('c2', 11);
  await tick(5);
  check('until the next message, the chat leaves the browser alone', /clicked Cancel/.test(resultFor('c2')?.error) && attachCalls === before, JSON.stringify(resultFor('c2')));

  panel.onMessage.fire({ type: 'chat.send', sessionId: 'sp-1', text: 'try again' });
  check('the message goes to the host', toHost.some((m) => m.type === 'chat.send' && m.text === 'try again'));
  cdp('c3', 11);
  await tick(5);
  finishCommand(11, null);
  await tick(5);
  check('after it, the next call reattaches and works', attachCalls === before + 1 && resultFor('c3')?.ok === true, JSON.stringify(resultFor('c3')));
  check('and the panel hears the tab is back', toPanel.some((m) => m.type === '__debugger_attached' && m.tabId === 11));
}

// ── the tab is closed with a call running ──────────────────────────────────
{
  cdp('c4', 12);
  await tick(5);
  // Chrome 153's order: the tab is removed, the command fails, then onDetach.
  tabs.delete(12);
  chrome.tabs.onRemoved.fire(12);
  finishCommand(12, 'Detached while handling command.');
  chrome.debugger.onDetach.fire({ tabId: 12 }, 'target_closed');
  const t0 = Date.now();
  while (!resultFor('c4') && Date.now() - t0 < 2000) await tick(5);
  check('a call on a closed tab says the tab is gone', /This tab was closed, so it's gone/.test(resultFor('c4')?.error), JSON.stringify(resultFor('c4')));
  await tick(10);
  const d = detachedFor(12);
  check('and the host hears the tab is gone', d.length === 1 && d[0].tabGone === true && d[0].reason === 'target_closed', JSON.stringify(d));
  cdp('c5', 12);
  await tick(10);
  check('a later call to it says the same', /This tab was closed, so it's gone/.test(resultFor('c5')?.error), JSON.stringify(resultFor('c5')));
}

// ── a detach Chrome never announced ────────────────────────────────────────
{
  cdp('c6', 13);
  await tick(5);
  finishCommand(13, null);
  await tick(5);
  attached.delete(13); // e.g. chrome.debugger.detach() run from the service worker
  const before = attachCalls;
  cdp('c7', 13);
  const t0 = Date.now();
  while (!resultFor('c7') && Date.now() - t0 < 2000) await tick(5);
  check("a call that finds the debugger gone fails with the reason instead of Chrome's words",
    /lost its connection to this tab/.test(resultFor('c7')?.error) && detachedFor(13)[0]?.failed === 1, JSON.stringify([resultFor('c7'), detachedFor(13)]));
  cdp('c8', 13);
  await tick(5);
  finishCommand(13, null);
  await tick(5);
  check('and the next call reattaches', attachCalls === before + 1 && resultFor('c8')?.ok === true, JSON.stringify(resultFor('c8')));
}

// ── answers for a host that has gone ───────────────────────────────────────
{
  cdp('c9', 13);
  await tick(5);
  const port = nativePort;
  const connects = connectCalls;
  port.onDisconnect.fire();
  finishCommand(13, null);
  await tick(5);
  check('an answer for a host that died does not start a new one', connectCalls === connects && !resultFor('c9'));
}

if (failures.length) {
  console.error('FAIL:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
console.log('PASS: debugger detach (13 assertions)');
process.exit(0);
