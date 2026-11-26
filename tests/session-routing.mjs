// Regression test for session routing across multiple panels.
//
// The bug this guards against: every side panel connected with the constant
// port name 'sidepanel', and every side panel read the same session id from a
// single chrome.storage key. So opening Browy in a second window overwrote the
// first panel's entry in the background's `clients` map, every host reply
// routed to the newer window, and the older one went silently dead. Whichever
// panel closed first then deleted the survivor's entry and ended its session.
//
// Run: node tests/session-routing.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.join(here, '..', 'extension');
const bg = readFileSync(path.join(ext, 'background.js'), 'utf8');
const sidepanel = readFileSync(path.join(ext, 'sidepanel.js'), 'utf8');
const panel = readFileSync(path.join(ext, 'panel.js'), 'utf8');

const failures = [];
const check = (name, cond) => { if (!cond) failures.push(name); };

// ── the ownership rule, exercised directly ─────────────────────────────────
// Pull the real function out of background.js rather than reimplementing it,
// so this test fails if the rule changes.

const start = bg.indexOf('function isSessionOwnedByAnotherClient');
if (start === -1) throw new Error('isSessionOwnedByAnotherClient not found in background.js');
const end = bg.indexOf('\n}', start) + 2;
const isOwned = new Function(`${bg.slice(start, end)}; return isSessionOwnedByAnotherClient;`)();

{
  const clients = new Map([['sidepanel-aaa', {}], ['sidepanel-bbb', {}]]);
  const s2c = new Map([['sp-1', 'sidepanel-aaa']]);

  check('a second live panel claiming the same id is refused',
    isOwned(s2c, clients, 'sp-1', 'sidepanel-bbb') === true);

  check('the owning panel may re-start its own session (reconnect)',
    isOwned(s2c, clients, 'sp-1', 'sidepanel-aaa') === false);

  check('an unclaimed id is free',
    isOwned(s2c, clients, 'sp-2', 'sidepanel-bbb') === false);
}

{
  // A stale mapping left behind by a panel that closed must be claimable,
  // otherwise a session id becomes permanently unusable after a crash.
  const clients = new Map([['sidepanel-bbb', {}]]);
  const s2c = new Map([['sp-1', 'sidepanel-aaa']]);
  check('a stale mapping from a dead port does not block a new claim',
    isOwned(s2c, clients, 'sp-1', 'sidepanel-bbb') === false);
}

// ── port names must be unique per instance ─────────────────────────────────

check('side panel does not connect with a constant port name',
  !/chrome\.runtime\.connect\(\s*\{\s*name:\s*['"]sidepanel['"]\s*\}/.test(sidepanel));
check('side panel derives a unique port name',
  /const PORT_NAME\s*=\s*['"]sidepanel-['"]\s*\+/.test(sidepanel));

check('devtools panel does not connect with a constant port name',
  !/chrome\.runtime\.connect\(\s*\{\s*name:\s*['"]devtools-panel['"]\s*\}/.test(panel));
check('devtools panel derives a unique port name',
  /const PORT_NAME\s*=\s*['"]devtools-panel-['"]\s*\+/.test(panel));

// ── conflicts must be handled, not ignored ─────────────────────────────────

check('background emits __session_conflict', bg.includes('__session_conflict'));
check('side panel handles __session_conflict', sidepanel.includes('__session_conflict'));

// A host from before parallel chats must keep its original switch behavior.
const leave = sidepanel.slice(sidepanel.indexOf('function leaveChat()'), sidepanel.indexOf('\n}', sidepanel.indexOf('function leaveChat()')) + 2);
const switches = new Function('parallelChats', 'sessionReady', 'busy', `
  const BROWY_SESSION_ID = 'sp-1', chat = {}, liveChats = new Map([['sp-1', chat]]), view = {}, sent = [];
  let loadToken = 0, pendingChat, resendOnReady, lastChatText, currentAction, previewingId, pendingHostMsgs = [];
  const browyPost = m => sent.push(m.type), onRouteLost = () => {}, dropPendingRpcs = () => {},
    resetLive = () => {}, setBusy = () => {}, setTtl = () => {};
  ${leave}
  leaveChat(); return { sent: sent.join(','), parked: chat.view === view };
`);
check('a new host keeps the running chat registered when the panel switches', switches(true, true, true).parked);
check('an old host stops and releases the previous chat', switches(false, true, true).sent === 'chat.cancel,session.end');

if (failures.length) {
  console.error('FAIL:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
console.log('PASS: session routing and chat switching');
