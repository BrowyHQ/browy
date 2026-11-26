// Browy background service worker.
//
// Responsibilities:
//   1. Open the side panel when the user clicks the toolbar icon.
//   2. Maintain ONE long-lived native-messaging port to the Browy host.
//   3. Multiplex multiple in-extension clients (side panel, DevTools panel)
//      onto that single host port via internal session ids.
//   4. (Phase E) Bridge chrome.debugger ↔ host CDP commands.
//
// The native-messaging port keeps the SW alive for the duration of the
// connection — no manual keep-alive trick needed.

const HOST_NAME = 'com.browy.host';
// Must match PROTOCOL_VERSION in src/protocol.ts.
const PROTOCOL = 2;

/** chrome.runtime.Port to the native host. Lazily created on first need. */
let nativePort = null;
let nativeReady = false;
let supportsBrowserPolicy = false;
let supportsParallelChats = false;
const preparingChats = new Map();
const browserTurns = new Map();
let nativeServerVersion = null;
/** Protocol the connected host reported in hello.ack. Clients compare it
 *  against their own minimum to decide whether to ask for a host update. */
let nativeProtocol = null;
/** Chrome said the host is missing or not allowed, or connectNative threw.
 *  Retrying can't help until the user acts, so nothing retries by itself. */
let hostGaveUp = false;

/** Map of internal port name → chrome.runtime.Port (the panel/devtools client). */
const clients = new Map();

/** Map of sessionId → client port name. Used to route server messages back. */
const sessionToClient = new Map();
/** Map<sessionId, tabId> — per-session "preferred tab", set from
 *  session.start.inspectedTabId. Used so two DevTools panels on different
 *  tabs don't fight over `getActiveTabId()`. */
const sessionToTab = new Map();
/** Map<sessionId, windowId> — the window a side panel lives in, from
 *  session.start.windowId. A session without a pinned tab acts on the active
 *  tab of its own window, so two windows' panels don't fight over focus. */
const sessionToWindow = new Map();

// ── Native host wiring ─────────────────────────────────────────────────────

function ensureNativeHost() {
  if (nativePort) return nativePort;
  supportsBrowserPolicy = false;
  supportsParallelChats = false;
  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    const m = String(e?.message || e);
    console.error('[browy] connectNative threw:', m);
    // Chrome returns three distinct errors here:
    //   "Specified native messaging host not found." → manifest absent
    //   "Access to the specified native messaging host is forbidden."
    //     OR "...not allowed..."                      → manifest exists but
    //                                                    allowed_origins doesn't include
    //                                                    THIS extension id. Almost
    //                                                    always means the user has an
    //                                                    older host than this extension.
    const forbidden  = /forbidden|not allowed/i.test(m);
    const notFound   = /not found|specified native messaging host/i.test(m) && !forbidden;
    const type = forbidden ? '__host_stale' : (notFound ? '__host_missing' : '__host_error');
    hostGaveUp = true;
    broadcastToClients({ type, message: m });
    return null;
  }

  const connectedPort = nativePort;
  nativePort.onMessage.addListener((msg) => {
    if (nativePort !== connectedPort) return;
    if (msg?.type === 'chat.done' || (msg?.type === 'chat.error' && msg.code !== 'busy')) browserTurns.delete(msg.sessionId);
    if (msg?.type === 'chat.done' && msg.stopped) cancelSessionPickers(msg.sessionId);
    // Server → CDP/tab bridge (Phase E): SW handles these directly.
    if (msg && (msg.type === 'cdp.send' || msg.type === 'tab.new'
              || msg.type === 'tab.activate' || msg.type === 'tab.list'
              || msg.type === 'tab.getActive' || msg.type === 'tab.close' || msg.type === 'browser.native')) {
      handleBridgeRequest(msg);
      return;
    }

    // Server → client routing. A session-scoped message goes to its owner
    // only. If nobody owns the session any more (its panel closed or moved to
    // another chat) it is dropped: until 0.1.11 it fell through to the
    // broadcast below, which streamed one window's turn into every other
    // open Browy panel.
    const sid = msg && msg.sessionId;
    if (sid) {
      const cp = clients.get(sessionToClient.get(sid));
      if (cp) { try { cp.postMessage(msg); } catch {} }
      return;
    }
    // Broadcast events (no sessionId): fan out to every client.
    if (msg.type === 'hello.ack') {
      nativeReady = true;
      supportsBrowserPolicy = msg.browserPolicy === true;
      supportsParallelChats = msg.parallelChats === true;
      hostGaveUp = false;
      nativeServerVersion = msg.serverVersion;
      nativeProtocol = typeof msg.protocol === 'number' ? msg.protocol : 1;
      reconnectDelay = 1000; // reset backoff on successful handshake
      broadcastToClients({ type: '__host_ready', serverVersion: msg.serverVersion, protocol: nativeProtocol });
      return;
    }
    broadcastToClients(msg);
  });

  nativePort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    if (nativePort !== connectedPort) return;
    const msg = (err && err.message) || 'native host disconnected';
    console.warn('[browy] native host disconnected:', msg);
    nativePort = null;
    nativeReady = false;
    sessionToClient.clear();
    preparingChats.clear();
    browserTurns.clear();
    sessionToTab.clear();
    sessionToWindow.clear();
    canceledSessions.clear();
    sessionDownloads.clear();
    sessionTabs.clear();
    gcDetachedDebuggers();
    // Distinguish three cases so the UI can show the right CTA:
    //   __host_missing — manifest absent, user needs to run the installer
    //   __host_stale   — manifest exists but allowed_origins doesn't include
    //                    this extension id (typically pre-0.1.3 host + CWS install)
    //   __host_disconnected — transient crash, will reconnect
    const forbidden = /forbidden|not allowed/i.test(msg);
    const notFound  = /not found|specified native messaging host/i.test(msg) && !forbidden;
    const stop = forbidden || notFound;
    hostGaveUp = stop;
    const type  = forbidden ? '__host_stale'
                : notFound  ? '__host_missing'
                :             '__host_disconnected';
    broadcastToClients({ type, message: msg });
    if (stop) {
      // Stop hammering chrome.runtime.connectNative — it'll never succeed
      // until the user installs/upgrades the host. Reconnect on next user
      // action (a fresh client connect kicks ensureNativeHost again).
      return;
    }
    // Auto-reconnect if any clients are still attached. Backoff so a hard
    // crash loop doesn't hammer the host.
    scheduleReconnect();
  });

  // Handshake.
  try {
    nativePort.postMessage({ type: 'hello', client: 'extension', protocol: PROTOCOL });
  } catch (e) {
    console.error('[browy] hello postMessage failed:', e);
  }
  return nativePort;
}

let reconnectTimer = null;
let reconnectDelay = 1000; // ms — exponential up to 15s
function scheduleReconnect() {
  if (reconnectTimer) return;
  if (clients.size === 0) return; // no one is listening; respawn on demand
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (nativePort || clients.size === 0) return;
    console.log('[browy] auto-reconnecting native host…');
    broadcastToClients({ type: '__host_pending' });
    ensureNativeHost();
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
    // If the host comes up, hello.ack will reset delay; if it dies again, the
    // disconnect handler reschedules with the bigger delay.
  }, reconnectDelay);
}

function sendToHost(msg) {
  const port = ensureNativeHost();
  if (!port) return false;
  try {
    port.postMessage(msg);
    return true;
  } catch (e) {
    console.error('[browy] postMessage to host failed:', e);
    return false;
  }
}

/** Send to the host that is connected now, without starting one. Answers to
 *  its calls and events from its tabs belong to that host; a new host has no
 *  use for them, and starting one from here skipped the reconnect backoff. */
function postToHost(msg) {
  if (!nativePort) return false;
  try {
    nativePort.postMessage(msg);
    return true;
  } catch {
    return false;
  }
}

/** A side panel's port was open but the host wasn't, and nothing was set to
 *  reconnect, e.g. after the computer woke up. Runs on the minute alarm. */
function healNativePort() {
  if (nativePort || reconnectTimer || hostGaveUp || clients.size === 0) return;
  console.warn('[browy] native host is down with panels open; reconnecting');
  broadcastToClients({ type: '__host_pending' });
  ensureNativeHost();
}

/** Replace the native host with a fresh process. Disconnecting our end closes
 *  the host's stdin, so the old process exits. Chrome doesn't fire
 *  onDisconnect for a disconnect we make ourselves, so tidy up here. */
function restartNativeHost() {
  console.warn('[browy] restarting the native host for a panel whose Stop went unanswered');
  if (nativePort) {
    const old = nativePort;
    nativePort = null;
    nativeReady = false;
    sessionToClient.clear();
    preparingChats.clear();
    browserTurns.clear();
    sessionToTab.clear();
    sessionToWindow.clear();
    canceledSessions.clear();
    sessionDownloads.clear();
    sessionTabs.clear();
    gcDetachedDebuggers();
    try { old.disconnect(); } catch {}
  }
  broadcastToClients({ type: '__host_pending' });
  ensureNativeHost();
}

function broadcastToClients(msg) {
  for (const port of clients.values()) {
    try { port.postMessage(msg); } catch {}
  }
}

/** Should a `session.start` be refused because another live client already owns
 *  this session id?
 *
 *  The side panel persists one session id under a single chrome.storage key, so
 *  every window reads the same one. Unique port names stop panels overwriting
 *  each other in `clients`, but `sessionToClient` is keyed by session id, so a
 *  second panel would still silently steal the routing from the first.
 *
 *  Only refuse when the incumbent port is still connected. A stale mapping left
 *  by a closed panel must be claimable, otherwise a session id becomes
 *  permanently unusable after a crash.
 *
 *  Exported as a pure function so the rule can be tested without a browser. */
function isSessionOwnedByAnotherClient(sessionToClientMap, clientsMap, sessionId, portName) {
  const existing = sessionToClientMap.get(sessionId);
  if (!existing) return false;
  if (existing === portName) return false;
  return clientsMap.has(existing);
}

if (typeof globalThis !== 'undefined') {
  globalThis.__browyTestables = { isSessionOwnedByAnotherClient };
}

// Only extension storage supplies standing rules and opt-ins, never a page or
// a field copied from chat. Take a fresh snapshot for each message.
async function readBrowserPolicy() {
  const { settings, 'browy.guidelines': saved = '' } = await chrome.storage.local.get(['settings', 'browy.guidelines']);
  if (typeof saved !== 'string' || saved.length > 4000) throw new Error('Invalid saved guidelines. Check Browy Settings.');
  const hostTools = new Set(['run_script', 'read_file', 'write_file', 'bash', 'grep', 'glob', 'web_fetch']);
  const disabledTools = [], enabledHostTools = [];
  for (const [k, v] of Object.entries(settings?.tools || {})) {
    if (hostTools.has(k)) { if (v === true) enabledHostTools.push(k); }
    else if (v === false) disabledTools.push(k);
  }
  return { guidelines: saved.trim(), disabledTools, enabledHostTools };
}

chrome.runtime.onConnect.addListener((port) => {
  // Expected names: "sidepanel", "devtools-panel", "console-bridge-<rand>"
  clients.set(port.name, port);

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (['session.end', 'chat.cancel', 'history.clear'].includes(msg.type) && sessionToClient.get(msg.sessionId) !== port.name) return;

    // Track session ↔ client routing on session.start
    if (msg.type === 'session.start' && msg.sessionId) {
      // Two panels can arrive holding the same session id, because the side
      // panel persists one id under a single chrome.storage key and every
      // window reads it. Unique port names stop them overwriting each other in
      // `clients`, but `sessionToClient` is keyed by session id, so the second
      // panel would still steal the routing for the first. Detect that and ask
      // the newcomer to mint a fresh id rather than silently taking over.
      if (isSessionOwnedByAnotherClient(sessionToClient, clients, msg.sessionId, port.name)) {
        try { port.postMessage({ type: '__session_conflict', sessionId: msg.sessionId }); } catch {}
        return;
      }
      sessionToClient.set(msg.sessionId, port.name);
      // The worker, not a particular panel, implements these requests.
      if (msg.capabilities?.includes('cdp.activeTab')) msg.capabilities = [...new Set([...msg.capabilities, 'browser.nativeIO'])];
      // Bind the session to a specific tab so agent tools target THIS panel's
      // inspected tab rather than whichever tab happens to be foregrounded.
      if (msg.inspectedTabId != null) {
        sessionToTab.set(msg.sessionId, Number(msg.inspectedTabId));
      }
      if (msg.windowId != null) {
        sessionToWindow.set(msg.sessionId, Number(msg.windowId));
      }
      // Stamp the per-user tool blocklist from chrome.storage onto every
      // session.start. The host keeps no preference state of its own — the
      // extension is the source of truth, so reloads + multiple panels
      // always converge on the user's most recent setting.
      readBrowserPolicy().then(({ disabledTools, enabledHostTools }) => {
        if (sessionToClient.get(msg.sessionId) === port.name) sendToHost({ ...msg, disabledTools, enabledHostTools });
      }).catch((e) => postToSessionClient(msg.sessionId, { type: 'chat.error', sessionId: msg.sessionId, message: `Could not read Browy Settings: ${e.message}` }));
      return;
    }
    if (msg.type === 'session.end' && msg.sessionId) {
      sessionToClient.delete(msg.sessionId);
      sessionToTab.delete(msg.sessionId);
      sessionToWindow.delete(msg.sessionId);
      canceledSessions.delete(msg.sessionId);
      releaseSessionTabs(msg.sessionId);
    }
    // A new message is the go-ahead to use the browser again after the user
    // clicked Cancel on Chrome's debugging bar.
    if (msg.type === 'chat.send' && msg.sessionId) {
      const sid = msg.sessionId;
      if (sessionToClient.get(sid) !== port.name) {
        port.postMessage({ type: 'chat.error', code: 'no_session', sessionId: sid, message: 'Reconnect this chat before sending.' });
        return;
      }
      if (preparingChats.has(sid) || browserTurns.has(sid)) {
        port.postMessage({ type: 'chat.error', code: 'busy', sessionId: sid, message: 'A message is already starting.' });
        return;
      }
      canceledSessions.delete(sid);
      preparingChats.set(sid, msg);
      const target = sessionToTab.get(sid) ?? activeTabFor(sid).then((tab) => tab?.id);
      Promise.all([readBrowserPolicy(), target]).then(([policy, tabId]) => {
        if (preparingChats.get(sid) !== msg) return;
        if (policy.guidelines && !supportsBrowserPolicy) throw new Error('Update the Browy backend to use your saved guidelines. This message was not sent.');
        if (!Number.isInteger(tabId) || tabId < 0) throw new Error('No target tab for this chat. Select a tab and send again.');
        if (!postToHost({ ...msg, policy, tabId })) throw new Error('The Browy backend is not connected.');
        if (supportsParallelChats) browserTurns.set(sid, new Set());
      }).catch((e) => {
        if (preparingChats.get(sid) === msg) postToSessionClient(sid, { type: 'chat.error', sessionId: sid, message: e.message });
      }).finally(() => { if (preparingChats.get(sid) === msg) preparingChats.delete(sid); });
      return;
    }
    if (msg.type === 'chat.cancel' && msg.sessionId) {
      canceledSessions.set(msg.sessionId, 'Stopped by the user. No further browser actions for this turn.');
      cancelSessionPickers(msg.sessionId);
      if (preparingChats.delete(msg.sessionId)) {
        port.postMessage({ type: 'chat.done', sessionId: msg.sessionId, text: '', toolCalls: [], stopped: true });
        return;
      }
    }

    // Internal client → SW commands (not forwarded)
    if (msg.type === '__ping') {
      try { port.postMessage({ type: '__pong', nativeReady, nativeServerVersion, nativeProtocol }); } catch {}
      return;
    }
    // A panel's Stop went unanswered for ten seconds: the backend is wedged.
    // Restart it, which is what reloading the extension used to achieve.
    if (msg.type === '__restart_host') {
      if (!supportsParallelChats) restartNativeHost();
      return;
    }
    // "Is the backend there yet?" from the first-run screen. After a missing
    // or stale verdict we deliberately stop reconnecting, so something has to
    // ask again. Deliberately does NOT emit __host_pending: for a missing host
    // that would flash the booting UI on every probe. The verdict arrives the
    // normal way — __host_missing / __host_stale within milliseconds, or
    // __host_ready once a real host finishes starting.
    if (msg.type === '__retry_host') {
      if (nativeReady) {
        try {
          port.postMessage({ type: '__host_ready', serverVersion: nativeServerVersion, protocol: nativeProtocol });
        } catch {}
        return;
      }
      ensureNativeHost();
      return;
    }

    // Client-direct tab listing (used by the in-page `browy.tabs()` API).
    // Handled in SW so it works even if the native host is down.
    if (msg.type === 'tab.list' && msg.id) {
      chrome.tabs.query({}).then((tabs) => {
        try {
          port.postMessage({ type: 'tab.list.result', id: msg.id, tabs: tabs.map(tabSummary) });
        } catch {}
      }).catch((err) => {
        try { port.postMessage({ type: 'tab.list.result', id: msg.id, tabs: [], error: String(err) }); } catch {}
      });
      return;
    }

    // history.clear with a client-supplied id: forward to host AND ack
    // immediately so the in-page Promise resolves without waiting on the host.
    if (msg.type === 'history.clear' && msg.id) {
      sendToHost({ type: 'history.clear', sessionId: msg.sessionId });
      try { port.postMessage({ type: 'history.cleared', id: msg.id }); } catch {}
      return;
    }

    sendToHost(msg);
  });

  port.onDisconnect.addListener(() => {
    clients.delete(port.name);
    // Drop any sessions owned by this port
    for (const [sid, name] of sessionToClient) {
      if (name === port.name) {
        postToHost({ type: 'session.end', sessionId: sid });
        sessionToClient.delete(sid);
        sessionToTab.delete(sid);
        sessionToWindow.delete(sid);
        canceledSessions.delete(sid);
        // Detach debugger from tabs no other session still references —
        // critical: leaving chrome.debugger attached pins the page's V8
        // isolate and keeps Network/Runtime/Log events firing into the void
        // (causing Chrome's memory to balloon over hours of idle time).
        releaseSessionTabs(sid);
      }
    }
  });

  // Eagerly ensure host is up so the first message doesn't race.
  ensureNativeHost();
  // Tell the new client whether host is already alive.
  try {
    port.postMessage({
      type: nativeReady ? '__host_ready' : '__host_pending',
      serverVersion: nativeServerVersion,
      protocol: nativeProtocol,
    });
  } catch {}
});

// ── chrome.debugger / chrome.tabs bridge (Phase E) ─────────────────────────
//
// Native host emits cdp.send / tab.* requests. SW fulfils them via the
// chrome.* APIs and replies with tool.result. Debugger events from any
// attached tab are forwarded back as cdp.event.

/** Set<tabId> of tabs we've attached the debugger to. */
const attachedTabs = new Set();
/** Map<sessionId, Set<tabId>> — which sessions are listening on which tabs. */
const sessionTabs = new Map();
const DEBUGGER_VERSION = '1.3';

// ── Losing the debugger on a tab ───────────────────────────────────────────
//
// Chrome takes the debugger off a tab when it closes, when it goes to a page
// extensions can't touch (chrome://, the Web Store), when the user clicks
// Cancel on the "started debugging this browser" bar, and so on. Calls still
// running on the tab then fail with the reason straight away, the host and
// the tab's panels are told, and the next call reattaches. After a Cancel the
// session leaves the browser alone until the user sends another message.

/** Map<tabId, Set<call>>: CDP calls still running, so a detach can fail them. */
const pendingCdp = new Map();
const pageWatches = new Map();
const pagePrompts = new Map();
const chooserActions = new Map();
const sessionDownloads = new Map();
/** Map<tabId, detach>: detaches still being sorted out (see beginDetach). */
const detaching = new Map();
/** Tabs that lost the debugger and still exist; reattaching one is news. */
const recentlyDetached = new Set();
/** Map<sessionId, message>: sessions whose user clicked Cancel on the
 *  debugging bar. Their CDP calls fail with the message until they send
 *  another chat message. */
const canceledSessions = new Map();
const DETACH_SETTLE_MS = 250;

/** What the model is told. Keep in step with detachMessage() in
 *  src/agent/extension-context.ts, which covers extensions older than this. */
function detachMessage(reason, tabGone) {
  if (reason === 'canceled_by_user') {
    return "You clicked Cancel on Chrome's debugging bar, so Browy lost this tab. Ask me to try again and I'll reattach.";
  }
  if (tabGone) return "This tab was closed, so it's gone. Use list_tabs to pick another tab, or new_tab to open one.";
  if (reason === 'target_closed') {
    return "This tab went to a page Browy can't work on, like a chrome:// page, so Browy lost it. Go back to a normal web page, or pick another tab with list_tabs.";
  }
  if (reason === 'replaced_with_devtools') {
    return 'Chrome DevTools took over this tab, so Browy lost it. Close DevTools on that tab and ask me to try again.';
  }
  return 'Browy lost its connection to this tab. It reattaches on the next step, so try again.';
}

function sessionsUsingTab(tabId) {
  const out = new Set();
  if (supportsParallelChats) {
    for (const [sid, tabs] of browserTurns) if (tabs.has(tabId)) out.add(sid);
    return out;
  }
  for (const [sid, tabs] of sessionTabs) if (tabs.has(tabId)) out.add(sid);
  for (const [sid, t] of sessionToTab) if (t === tabId) out.add(sid);
  for (const call of pendingCdp.get(tabId) || []) if (call.sessionId) out.add(call.sessionId);
  return out;
}

function postToSessionClient(sessionId, msg) {
  const cp = clients.get(sessionToClient.get(sessionId));
  if (cp) { try { cp.postMessage(msg); } catch {} }
}

/** Start sorting out a detach on `tabId`, or join the one under way. Chrome
 *  answers a running command itself ("Detached while handling command.")
 *  but without the reason, onDetach brings the reason, and the two arrive in
 *  either order. A detach this extension made itself brings no onDetach at
 *  all. So each detach waits a moment to collect both, then reports once. */
function beginDetach(tabId, reason) {
  let d = detaching.get(tabId);
  if (!d) {
    d = { tabId, reason: null, tabGone: undefined, message: '', failed: new Map(),
      sessions: new Map([...sessionsUsingTab(tabId)].map(sid => [sid, browserTurns.get(sid)])) };
    d.settled = new Promise((resolve) => { d.resolve = resolve; });
    detaching.set(tabId, d);
    attachedTabs.delete(tabId);
    forgetPrompts(tabId);
    setTimeout(() => { finishDetach(d).catch((e) => console.warn('[browy] detach report failed:', e)); }, DETACH_SETTLE_MS);
  }
  if (reason && !d.reason) d.reason = reason;
  return d;
}

/** A call failed because of detach `d`; the model hears about it from that. */
function countDetachFailure(d, sessionId) {
  if (!sessionId) return;
  d.failed.set(sessionId, (d.failed.get(sessionId) || 0) + 1);
  if (!d.sessions.has(sessionId)) d.sessions.set(sessionId, browserTurns.get(sessionId));
}

async function finishDetach(d) {
  if (d.tabGone === undefined) d.tabGone = !(await chrome.tabs.get(d.tabId).then(() => true, () => false));
  d.reason = d.reason || 'unknown';
  d.message = detachMessage(d.reason, d.tabGone);
  // Calls Chrome hasn't answered (older builds may never answer them).
  for (const call of [...(pendingCdp.get(d.tabId) || [])]) {
    countDetachFailure(d, call.sessionId);
    call.fail(d.message);
  }
  detaching.delete(d.tabId);
  if (!d.tabGone) recentlyDetached.add(d.tabId);
  d.resolve(d);
  console.warn(`[browy] debugger detached from tab ${d.tabId}: ${d.reason}${d.tabGone ? ' (tab closed)' : ''}`);
  for (const [sid, turn] of d.sessions) {
    if (supportsParallelChats && (!turn || browserTurns.get(sid) !== turn)) continue;
    if (d.reason === 'canceled_by_user') canceledSessions.set(sid, d.message);
    postToHost({
      type: 'cdp.detached', sessionId: sid, tabId: d.tabId, reason: d.reason,
      tabGone: d.tabGone, message: d.message, failed: d.failed.get(sid) || 0,
    });
    postToSessionClient(sid, {
      type: '__debugger_detached', sessionId: sid, tabId: d.tabId, reason: d.reason, tabGone: d.tabGone,
    });
  }
}

/** chrome.debugger.sendCommand, kept in pendingCdp while it runs. */
function trackedSendCommand(tabId, sessionId, method, params) {
  return new Promise((resolve, reject) => {
    let calls = pendingCdp.get(tabId);
    if (!calls) { calls = new Set(); pendingCdp.set(tabId, calls); }
    const call = { sessionId, method, done: false, fail: null };
    const settle = (fn) => {
      if (call.done) return;
      call.done = true;
      calls.delete(call);
      if (calls.size === 0 && pendingCdp.get(tabId) === calls) pendingCdp.delete(tabId);
      fn();
    };
    call.fail = (message) => settle(() => {
      const e = new Error(message);
      e.detach = true;
      reject(e);
    });
    calls.add(call);
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      const err = chrome.runtime.lastError;
      settle(() => (err ? reject(new Error(err.message)) : resolve(result)));
    });
  });
}

// A service worker that restarted can find tabs still attached from before
// it stopped, with Chrome's debugging bar still up, that nothing uses. Calls
// reattach as they need to.
try {
  chrome.debugger.getTargets((targets) => {
    for (const t of targets || []) {
      if (!t.attached || t.tabId == null || t.type !== 'page') continue;
      chrome.debugger.detach({ tabId: t.tabId }, () => { void chrome.runtime.lastError; });
    }
  });
} catch {}

function addSessionTab(sessionId, tabId) {
  if (!sessionId) return;
  let s = sessionTabs.get(sessionId);
  if (!s) { s = new Set(); sessionTabs.set(sessionId, s); }
  s.add(tabId);
}

/** Detach the debugger from any tab currently attached but not referenced
 *  by any active session. Called after a session ends and periodically.
 *  Without this, chrome.debugger stays attached forever, pinning the page's
 *  V8 isolate and forwarding a firehose of Network/Runtime/Log events with
 *  nobody listening — the single biggest memory leak we have. */
function gcDetachedDebuggers() {
  const stillNeeded = new Set();
  for (const tabs of sessionTabs.values()) {
    for (const t of tabs) stillNeeded.add(t);
  }
  for (const tabId of [...attachedTabs]) {
    if (stillNeeded.has(tabId)) continue;
    try {
      chrome.debugger.detach({ tabId }, () => {
        // chrome.runtime.lastError fires when the tab is already gone /
        // never attached / Chrome decided to detach itself. All harmless.
        void chrome.runtime.lastError;
      });
    } catch {}
    attachedTabs.delete(tabId);
    forgetPrompts(tabId);
  }
}

/** Remove a session from the tab map AND detach any tabs that become
 *  orphaned as a result. Use after session.end. */
function releaseSessionTabs(sessionId) {
  preparingChats.delete(sessionId);
  browserTurns.delete(sessionId);
  sessionTabs.delete(sessionId);
  sessionDownloads.delete(sessionId);
  cancelSessionPickers(sessionId);
  gcDetachedDebuggers();
}

function cancelSessionPickers(sessionId) {
  for (const action of chooserActions.values()) {
    if (action.owner === sessionId) action.cancel('The upload action ended. No files attached.');
  }
  for (const [tabId, p] of pagePrompts) {
    if (p.owner === sessionId) pagePrompts.delete(tabId);
  }
}

// Defensive periodic sweep — catches anything missed by the explicit
// session.end / port.onDisconnect path (e.g. SW restarted, port recycled).
// Use chrome.alarms instead of setInterval: a plain setInterval keeps the
// MV3 service worker hot 24/7 (drains battery, prevents Chrome from
// suspending the SW), while alarms wake us up only when needed.
try {
  chrome.alarms.create('browy-debugger-gc', { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === 'browy-debugger-gc') {
      gcDetachedDebuggers();
      healNativePort();
    }
  });
} catch {}

async function ensureAttached(tabId) {
  const tab = await chrome.tabs.get(tabId).catch((e) => {
    if (/no tab with/i.test(e.message)) throw new Error(detachMessage('target_closed', true));
    throw e;
  });
  if ([tab.url, tab.pendingUrl].some((url) => url?.startsWith('chrome-extension://'))) {
    throw new Error("Browy can't drive extension pages, including its own Settings. Only the user changes browser permissions and guidelines.");
  }
  if (attachedTabs.has(tabId)) return;
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, DEBUGGER_VERSION, () => {
      const err = chrome.runtime.lastError;
      if (err && !/already attached/i.test(err.message || '')) {
        reject(new Error(err.message));
      } else {
        resolve();
      }
    });
  });
  attachedTabs.add(tabId);
}

/** One CDP call for a session: attach if needed, run it, and turn a lost
 *  debugger into an error that says what happened. */
async function runCdpCall(sessionId, tabId, method, params, observePrompts, check) {
  // A detach on this tab is still being sorted out: this call shares its fate.
  const settling = detaching.get(tabId);
  if (settling) {
    countDetachFailure(settling, sessionId);
    throw new Error((await settling.settled).message);
  }
  try {
    await ensureAttached(tabId);
  } catch (e) {
    if (/no tab with given id/i.test(String(e?.message))) throw new Error(detachMessage('target_closed', true));
    throw e;
  }
  check();
  addSessionTab(sessionId, tabId);
  if (recentlyDetached.delete(tabId)) {
    for (const sid of sessionsUsingTab(tabId)) postToSessionClient(sid, { type: '__debugger_attached', sessionId: sid, tabId });
  }
  try {
    if (observePrompts) {
      await watchPage(tabId, sessionId);
      check();
      const p = pagePrompts.get(tabId);
      if (p && p.type !== 'file') throw new Error(dialogNotice(p));
      if (mayOpenChooser(method, params)) return await sendWithChooser(tabId, sessionId, method, params, false, check);
    }
    return await trackedSendCommand(tabId, sessionId, method, params);
  } catch (e) {
    if (e?.detach) throw e;
    // "Detached while handling command." or, after a detach Chrome didn't
    // announce, "Debugger is not attached to the tab with id: N."
    if (/detached while handling|not attached/i.test(String(e?.message))) {
      const d = beginDetach(tabId, null);
      countDetachFailure(d, sessionId);
      throw new Error((await d.settled).message);
    }
    throw e;
  }
}

function forgetPrompts(tabId) {
  pageWatches.delete(tabId);
  pagePrompts.delete(tabId);
  chooserActions.get(tabId)?.cancel('The tab disconnected. No files attached.');
  chooserActions.delete(tabId);
}

function watchPage(tabId, sid) {
  let watch = pageWatches.get(tabId);
  if (!watch) {
    watch = trackedSendCommand(tabId, sid, 'Page.enable', {}).catch((error) => {
      if (pageWatches.get(tabId) === watch) pageWatches.delete(tabId);
      throw error;
    });
    pageWatches.set(tabId, watch);
  }
  // Chrome can attach but not answer Page.enable when a dialog predates
  // this debugger. It doesn't reveal what we'd be accepting in that case.
  let timer;
  return Promise.race([watch, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Chrome has not exposed the tab to Browy. If a dialog was already open before Browy connected, close it once; Browy can handle subsequent page dialogs.')), 2000);
  })]).finally(() => clearTimeout(timer));
}

function dialogNotice(p) {
  return `A page ${p.type} is open. Use handle_dialog with action "inspect" before deciding how to answer. Don't repeat the action that opened it.`;
}

function mayOpenChooser(method, p) {
  return (method === 'Input.dispatchMouseEvent' && ['mousePressed', 'mouseReleased'].includes(p?.type))
    || (method === 'Input.dispatchKeyEvent' && ['Enter', ' '].includes(p?.key))
    || (method === 'Runtime.evaluate' && p?.userGesture === true);
}

// Intercept only during a Browy gesture, never while the person browses the tab.
async function sendWithChooser(tabId, sid, method, params, expectPicker, check) {
  if (chooserActions.has(tabId)) throw new Error('Another input action is running on this tab.');
  const action = { owner: sid, expectPicker };
  const opened = new Promise((resolve) => { action.opened = resolve; });
  const canceled = new Promise((_, reject) => {
    action.cancel = (why) => reject(new Error(why));
  });
  chooserActions.set(tabId, action);
  const timer = setTimeout(() => action.cancel(expectPicker ? 'No HTML file chooser appeared for the requested upload control. No files attached.'
    : 'No answer to the browser gesture. Inspect the tab before doing anything else.'), expectPicker ? 5000 : 60_000);
  let result;
  try {
    await Promise.race([trackedSendCommand(tabId, sid, 'Page.setInterceptFileChooserDialog', { enabled: true }), canceled]);
    check();
    const sent = trackedSendCommand(tabId, sid, method, params);
    const dispatch = expectPicker ? sent.then((r) => {
      if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return opened;
    }) : sent;
    result = await Promise.race([dispatch, canceled]);
  } finally {
    try {
      if (chooserActions.get(tabId) === action) {
        // Chrome may acknowledge mouseReleased before it delivers the picker
        // event. Keep the owner until Chrome acknowledges the reset as well.
        const reset = trackedSendCommand(tabId, sid, 'Page.setInterceptFileChooserDialog', { enabled: false })
          .finally(() => { if (chooserActions.get(tabId) === action) chooserActions.delete(tabId); });
        if (pagePrompts.has(tabId) && pagePrompts.get(tabId).type !== 'file') {
          // Don't hold the model that can answer a JS dialog behind the renderer.
          reset.catch((e) => console.warn('[browy] could not release file chooser interception:', e));
        } else {
          await Promise.race([reset, canceled]);
        }
      }
    } finally { clearTimeout(timer); }
  }
  if (action.picker) {
    if (expectPicker) return action.picker;
    throw new Error(action.picker.node
      ? `An upload picker opened. No files attached. Call upload_file with chooser_id "${action.picker.id}" and the files the user authorized. Do not click again.`
      : 'This picker has no HTML file input. Use await_user and let the user open it from the page.');
  }
  return result;
}

function onPromptEvent(tabId, method, params) {
  if (!pageWatches.has(tabId)) return;
  const prev = pagePrompts.get(tabId);
  if (method === 'Page.javascriptDialogOpening') {
    const p = { id: crypto.randomUUID(), type: params.type, message: String(params.message).slice(0, 1000),
      url: params.url, frameId: params.frameId };
    pagePrompts.set(tabId, p);
    chooserActions.get(tabId)?.cancel(dialogNotice(p));
    // A click/evaluate which opened the dialog cannot return until it is
    // answered. Release the caller, not the dialog. Never retry that click.
    for (const call of [...(pendingCdp.get(tabId) || [])]) {
      if (!['Page.enable', 'Page.handleJavaScriptDialog', 'Page.setInterceptFileChooserDialog'].includes(call.method)) call.fail(dialogNotice(p));
    }
  } else if (method === 'Page.javascriptDialogClosed' && prev?.type !== 'file') {
    pagePrompts.delete(tabId);
  } else if (method === 'Page.fileChooserOpened') {
    const action = chooserActions.get(tabId);
    if (!action) return;
    if (action.picker) {
      pagePrompts.delete(tabId);
      action.cancel('More than one file picker opened. No files attached.');
      return;
    }
    const p = { id: crypto.randomUUID(), type: 'file', owner: action.owner, node: params.backendNodeId,
      frameId: params.frameId, multiple: params.mode === 'selectMultiple' };
    pagePrompts.set(tabId, p);
    action.picker = p;
    action.opened();
  } else if (method === 'Page.frameNavigated' || method === 'Page.frameDetached') {
    const main = method === 'Page.frameNavigated' && !params.frame.parentId;
    const action = chooserActions.get(tabId);
    if (main && action?.expectPicker) action.cancel('The page navigated before the picker was handled. Inspect the new page.');
    if (prev?.type === 'file' && (main || (params.frame?.id ?? params.frameId) === prev.frameId)) pagePrompts.delete(tabId);
  }
}

async function attachToPicker(tabId, sid, p, files, check, trigger) {
  if (!p.node || !Array.isArray(files) || !files.length || (!p.multiple && files.length !== 1)) {
    throw new Error('This picker does not accept that file selection.');
  }
  p.answering = true;
  const objectGroup = `browy-picker-${p.id}`;
  try {
    const { object } = await trackedSendCommand(tabId, sid, 'DOM.resolveNode', { backendNodeId: p.node, objectGroup });
    const { result, exceptionDetails } = await trackedSendCommand(tabId, sid, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function(trigger) { return (!trigger || trigger.ownerDocument === this.ownerDocument)
        && this.localName === 'input' && this.type === 'file' && !this.matches(':disabled') && !this.webkitdirectory; }`,
      arguments: trigger ? [{ objectId: trigger }] : [], returnByValue: true,
    });
    if (exceptionDetails || result.value !== true || pagePrompts.get(tabId) !== p) {
      throw new Error('The intended file input is no longer available on this page. No files attached.');
    }
    check();
    await trackedSendCommand(tabId, sid, 'DOM.setFileInputFiles', { files, objectId: object.objectId });
    return { attached: files.length };
  } finally {
    if (pagePrompts.get(tabId) === p) pagePrompts.delete(tabId);
    if (attachedTabs.has(tabId)) {
      trackedSendCommand(tabId, sid, 'Runtime.releaseObjectGroup', { objectGroup })
        .catch((e) => console.warn('[browy] could not release upload handle:', e));
    }
  }
}

async function nativeAction(tabId, sid, a, check) {
  if (a.kind === 'download' || a.kind === 'downloadStatus') {
    let ids = sessionDownloads.get(sid);
    let id = a.downloadId;
    if (a.kind === 'download') {
      const url = new URL(a.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('Use an HTTP or HTTPS download URL without embedded credentials.');
      }
      if (a.filename !== undefined && (typeof a.filename !== 'string' || a.filename.split(/[\\/]/).some(
        (s) => !s || s === '.' || s === '..' || /[<>:"|?*\x00-\x1f]/.test(s)))) {
        throw new Error('Use a filename relative to Downloads, without parent directories.');
      }
      if (!ids) { ids = new Set(); sessionDownloads.set(sid, ids); }
      id = await chrome.downloads.download({ url: url.href, ...(a.filename ? { filename: a.filename } : {}),
        saveAs: false, conflictAction: 'uniquify' });
      ids.add(id);
    } else if (!ids?.has(id)) {
      throw new Error('No download with this ID was started by this chat.');
    }
    const [item] = await chrome.downloads.search({ id });
    if (!item) throw new Error(`Download ${id} is no longer available in the browser.`);
    return { downloadId: id, state: item.state, danger: item.danger, paused: item.paused,
      ...(item.error ? { error: item.error } : {}),
      ...(item.state === 'complete' ? { success: true, path: item.filename, size: item.fileSize, content_type: item.mime } : {}) };
  }
  await ensureAttached(tabId);
  check();
  addSessionTab(sid, tabId);
  await watchPage(tabId, sid);
  check();
  const p = pagePrompts.get(tabId);
  const mine = p && (!p.owner || p.owner === sid);
  if (a.kind === 'pickFiles') {
    if (p && p.type !== 'file') throw new Error(dialogNotice(p));
    const picker = await sendWithChooser(tabId, sid, 'Runtime.callFunctionOn', {
      objectId: a.objectId, functionDeclaration: 'function() { this.click(); }', userGesture: true,
    }, true, check);
    if (pagePrompts.get(tabId) !== picker || !sessionToClient.has(sid)) throw new Error('The file picker changed before attachment.');
    return attachToPicker(tabId, sid, picker, a.files, check, a.objectId);
  }
  if (a.kind === 'inspect') {
    if (!mine) return { dialog: null };
    return { dialog: p.type === 'file' ? { id: p.id, type: p.type, multiple: p.multiple, supported: !!p.node }
      : { id: p.id, type: p.type, message: p.message, url: p.url } };
  }
  if (!mine || p.id !== a.id || p.answering) throw new Error('That prompt is no longer current on this tab. Inspect it again.');
  if (p.type === 'file') {
    if (a.kind === 'attach') return attachToPicker(tabId, sid, p, a.files, check);
    if (a.kind !== 'dismiss') throw new Error('Use upload_file with chooser_id for this file picker.');
  } else {
    if (!['accept', 'dismiss'].includes(a.kind) || (a.text !== undefined && (a.kind !== 'accept' || p.type !== 'prompt'))) {
      throw new Error('Use accept or dismiss. Only an accepted text prompt takes a value.');
    }
    p.answering = true;
    try {
      await trackedSendCommand(tabId, sid, 'Page.handleJavaScriptDialog', {
        accept: a.kind === 'accept', ...(a.text !== undefined ? { promptText: a.text } : {}),
      });
    } finally { p.answering = false; }
  }
  if (pagePrompts.get(tabId) === p) pagePrompts.delete(tabId);
  return { handled: a.kind, type: p.type };
}

/** The tab a session acts on when it hasn't pinned one: the active tab of the
 *  panel's own window, or of the last-focused window when the panel didn't
 *  name a window. A closed window is not permission to drive another one. */
async function activeTabFor(sessionId) {
  const windowId = sessionToWindow.get(sessionId);
  if (windowId != null) {
    const [own] = await chrome.tabs.query({ active: true, windowId });
    return own || null;
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

function tabSummary(t) {
  return { tabId: t.id, url: t.url || '', title: t.title || '', active: !!t.active, windowId: t.windowId, openerTabId: t.openerTabId };
}

async function handleBridgeRequest(msg) {
  const host = nativePort;
  const turn = browserTurns.get(msg.sessionId);
  const check = () => {
    if (nativePort !== host || !sessionToClient.has(msg.sessionId) ||
        (supportsParallelChats && (!turn || browserTurns.get(msg.sessionId) !== turn))) throw new Error('This browser turn has ended.');
    const canceled = canceledSessions.get(msg.sessionId);
    if (canceled) throw new Error(canceled);
  };
  const reply = (ok, payload) => {
    const out = { type: 'tool.result', sessionId: msg.sessionId, callId: msg.callId, ok };
    if (ok) out.result = payload; else out.error = String(payload?.message || payload);
    if (nativePort === host) postToHost(out);
  };
  try {
    check();
    if (msg.type === 'cdp.send' || msg.type === 'browser.native') {
      // Resolution order:
      //   1. explicit msg.tabId (caller pinned the tab)
      //   2. session-bound inspected tab (sessionToTab)
      //   3. fallback: foreground active tab
      let tabId;
      if (msg.tabId != null) tabId = Number(msg.tabId);
      else if (msg.sessionId && sessionToTab.has(msg.sessionId)) tabId = sessionToTab.get(msg.sessionId);
      else {
        const t = await activeTabFor(msg.sessionId);
        if (!t) throw new Error('no active tab');
        tabId = t.id;
      }
      check();
      turn?.add(tabId);
      if (msg.type === 'browser.native') {
        reply(true, await nativeAction(tabId, msg.sessionId, msg.action, check));
      } else {
        const result = await runCdpCall(msg.sessionId, tabId, msg.method, msg.params, msg.observePrompts, check);
        reply(true, { tabId, result });
      }
    } else if (msg.type === 'tab.new') {
      const opts = { url: msg.url || 'about:blank', active: msg.active !== false };
      const windowId = sessionToWindow.get(msg.sessionId);
      const t = await chrome.tabs.create(windowId != null ? { ...opts, windowId } : opts);
      reply(true, tabSummary(t));
    } else if (msg.type === 'tab.activate') {
      const t = await chrome.tabs.update(Number(msg.tabId), { active: true });
      reply(true, tabSummary(t));
    } else if (msg.type === 'tab.close') {
      const tab = await chrome.tabs.get(Number(msg.tabId));
      check();
      await chrome.tabs.remove(tab.id);
      // Report the tab the browser shows next in that window, so the agent
      // carries on there rather than jumping to another window.
      const [next] = await chrome.tabs.query({ active: true, windowId: tab.windowId }).catch(() => []);
      reply(true, next ? tabSummary(next) : null);
    } else if (msg.type === 'tab.list') {
      const tabs = await chrome.tabs.query({});
      reply(true, tabs.map(tabSummary));
    } else if (msg.type === 'tab.getActive') {
      const pinned = sessionToTab.get(msg.sessionId);
      const t = pinned != null ? await chrome.tabs.get(pinned) : await activeTabFor(msg.sessionId);
      reply(true, t ? tabSummary(t) : null);
    }
  } catch (e) {
    reply(false, e);
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!source.sessionId) onPromptEvent(tabId, method, params);
  for (const [sessionId, tabs] of sessionTabs) {
    if (tabs.has(tabId) && (!supportsParallelChats || browserTurns.get(sessionId)?.has(tabId))) {
      postToHost({ type: 'cdp.event', sessionId, tabId, method, params });
    }
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId != null) beginDetach(source.tabId, reason || 'unknown');
});

chrome.tabs.onRemoved.addListener((tabId) => {
  // Chrome reports the tab gone before the debugger's detach. Start that
  // report now, while the sessions using the tab are still on record.
  if (attachedTabs.has(tabId) || pendingCdp.has(tabId) || detaching.has(tabId)) {
    beginDetach(tabId, 'target_closed').tabGone = true;
  }
  recentlyDetached.delete(tabId);
  attachedTabs.delete(tabId);
  for (const tabs of sessionTabs.values()) tabs.delete(tabId);
  // If a panel's inspected tab is gone, drop the binding so the next
  // tool-call falls back to the active-tab heuristic instead of erroring.
  for (const [sid, t] of sessionToTab) {
    if (t === tabId) sessionToTab.delete(sid);
  }
});

// ── Toolbar action ─────────────────────────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (chrome.sidePanel && chrome.sidePanel.open) {
      await chrome.sidePanel.open({ tabId: tab.id });
    }
  } catch (e) {
    console.error('[browy] open side panel failed:', e);
  }
});

// Make side panel open via action click on every tab
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}
