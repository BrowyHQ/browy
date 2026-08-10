// Regression test for the cold-start UX contract in extension/sidepanel.js.
//
// The bug this guards against: a correctly-installed user saw
// "offline — install the browy backend to chat" on a DISABLED input for the
// ~10-45s the native host takes to cold start. Boot must be visibly distinct
// from "not installed", and typing must stay possible so the queued-send path
// (wsShim -> pendingHostMsgs -> flushPendingHostMsgs) can actually be reached.
//
// Run: node tests/sidepanel-boot-state.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '..', 'extension', 'sidepanel.js'), 'utf8');

// Pull the function under test out of the panel source so we exercise the
// real implementation rather than a copy that can drift.
const start = src.indexOf('function setControlsState(state) {');
if (start === -1) throw new Error('setControlsState not found in sidepanel.js');
const end = src.indexOf('\n}', start) + 2;
const fnSrc = src.slice(start, end);

function makeEl() { return { disabled: false, value: '', placeholder: '', style: {} }; }

function run(state, { typed = '', busy = false } = {}) {
  const els = { inp: makeEl(), goBtn: makeEl(), stopBtn: makeEl(), chatsBtn: makeEl() };
  els.inp.value = typed;
  const ctx = {
    document: { getElementById: (id) => els[id] || null },
    busy,
    hostState: null,
  };
  const fn = new Function('document', 'busy', `${fnSrc}; return setControlsState;`)(ctx.document, busy);
  fn(state);
  return els;
}

const failures = [];
const check = (name, cond) => { if (!cond) failures.push(name); };

// ── booting ────────────────────────────────────────────────────────────────
{
  const e = run('booting', { typed: '' });
  check('booting: input must be ENABLED so the user can type while we warm up',
    e.inp.disabled === false);
  check('booting: must NOT tell an installed user to install the backend',
    !/install/i.test(e.inp.placeholder));
  check('booting: placeholder should say we are starting',
    /start/i.test(e.inp.placeholder));
  check('booting: chats button reachable (shows a loading state)',
    e.chatsBtn.disabled === false);
  check('booting: stop button is meaningless with no live turn',
    e.stopBtn.disabled === true);
  check('booting: send stays disabled with an empty box',
    e.goBtn.disabled === true);
}

// ── booting + typed text: the queued-send path must be reachable ───────────
{
  const e = run('booting', { typed: 'summarize this page' });
  check('booting+text: send must be ENABLED so the message can be queued',
    e.goBtn.disabled === false);
}

// ── offline ────────────────────────────────────────────────────────────────
{
  const e = run('offline');
  check('offline: input disabled', e.inp.disabled === true);
  check('offline: install CTA is correct here', /install/i.test(e.inp.placeholder));
  check('offline: chats button disabled', e.chatsBtn.disabled === true);
}

// ── online ─────────────────────────────────────────────────────────────────
{
  const e = run('online', { typed: 'hi' });
  check('online: input enabled', e.inp.disabled === false);
  check('online: placeholder clear', e.inp.placeholder === '');
  check('online: send enabled with text', e.goBtn.disabled === false);
  check('online: stop enabled', e.stopBtn.disabled === false);
}

// ── busy must still suppress send ──────────────────────────────────────────
{
  const e = run('online', { typed: 'hi', busy: true });
  check('online+busy: send suppressed', e.goBtn.disabled === true);
}

if (failures.length) {
  console.error('FAIL:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
console.log('PASS — sidepanel boot-state contract (13 assertions)');
