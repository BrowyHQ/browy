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
let nativeServerVersion = null;
/** Protocol the connected host reported in hello.ack. Clients compare it
 *  against their own minimum to decide whether to ask for a host update. */
let nativeProtocol = null;

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
    broadcastToClients({ type, message: m });
    return null;
  }

  nativePort.onMessage.addListener((msg) => {
    // Server → CDP/tab bridge (Phase E): SW handles these directly.
    if (msg && (msg.type === 'cdp.send' || msg.type === 'tab.new'
              || msg.type === 'tab.activate' || msg.type === 'tab.list'
              || msg.type === 'tab.getActive' || msg.type === 'tab.close')) {
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
    const msg = (err && err.message) || 'native host disconnected';
    console.warn('[browy] native host disconnected:', msg);
    nativePort = null;
    nativeReady = false;
    sessionToClient.clear();
    // Distinguish three cases so the UI can show the right CTA:
    //   __host_missing — manifest absent, user needs to run the installer
    //   __host_stale   — manifest exists but allowed_origins doesn't include
    //                    this extension id (typically pre-0.1.3 host + CWS install)
    //   __host_disconnected — transient crash, will reconnect
    const forbidden = /forbidden|not allowed/i.test(msg);
    const notFound  = /not found|specified native messaging host/i.test(msg) && !forbidden;
    const stop = forbidden || notFound;
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

// ── chrome.downloads: silent auto-save (Phase E.1) ──────────────────────────
//
// Many sites (Overleaf, etc.) trigger a Save-As dialog that the agent can't
// dismiss. We listen for every download created in any tab and override the
// suggested filename via onDeterminingFilename — passing { conflictAction:
// 'uniquify' } silently routes it to the default Downloads folder without a
// prompt. This works regardless of the user's "Ask where to save each file"
// browser setting because suggest() takes precedence.
try {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    try {
      const safe = (item.filename || 'download').replace(/[\\/:*?"<>|]+/g, '_');
      suggest({ filename: 'Browy/' + safe, conflictAction: 'uniquify' });
    } catch {
      try { suggest(); } catch {}
    }
  });
} catch (e) {
  console.warn('[browy] downloads listener failed:', e);
}



chrome.runtime.onConnect.addListener((port) => {
  // Expected names: "sidepanel", "devtools-panel", "console-bridge-<rand>"
  clients.set(port.name, port);

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;

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
      if (msg.disabledTools === undefined) {
        chrome.storage.local.get(['settings']).then(({ settings }) => {
          const toolsMap = settings && settings.tools;
          // Names used for the opt-in tools (must match OPT_IN_TOOLS in
          // src/agent/tool-policy.ts and the optIn entries in options.js).
          const HOST_TOOL_NAMES = new Set([
            'run_script', 'read_file', 'write_file', 'bash', 'grep', 'glob', 'web_fetch',
          ]);
          let disabled = [];
          let enabledHost = [];
          if (toolsMap && typeof toolsMap === 'object') {
            for (const [k, v] of Object.entries(toolsMap)) {
              if (HOST_TOOL_NAMES.has(k)) {
                if (v === true) enabledHost.push(k);
              } else if (v === false) {
                disabled.push(k);
              }
            }
          }
          sendToHost({ ...msg, disabledTools: disabled, enabledHostTools: enabledHost });
        }).catch(() => sendToHost(msg));
        return;
      }
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
    if (msg.type === 'chat.send' && msg.sessionId) canceledSessions.delete(msg.sessionId);

    // Internal client → SW commands (not forwarded)
    if (msg.type === '__ping') {
      try { port.postMessage({ type: '__pong', nativeReady, nativeServerVersion, nativeProtocol }); } catch {}
      return;
    }
    // A panel's Stop went unanswered for ten seconds: the backend is wedged.
    // Restart it, which is what reloading the extension used to achieve.
    if (msg.type === '__restart_host') {
      restartNativeHost();
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
        sendToHost({ type: 'session.end', sessionId: sid });
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
    d = { tabId, reason: null, tabGone: undefined, message: '', failed: new Map(), sessions: sessionsUsingTab(tabId) };
    d.settled = new Promise((resolve) => { d.resolve = resolve; });
    detaching.set(tabId, d);
    attachedTabs.delete(tabId);
    setTimeout(() => { finishDetach(d).catch((e) => console.warn('[browy] detach report failed:', e)); }, DETACH_SETTLE_MS);
  }
  if (reason && !d.reason) d.reason = reason;
  return d;
}

/** A call failed because of detach `d`; the model hears about it from that. */
function countDetachFailure(d, sessionId) {
  if (!sessionId) return;
  d.failed.set(sessionId, (d.failed.get(sessionId) || 0) + 1);
  d.sessions.add(sessionId);
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
  for (const sid of d.sessions) {
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
    const call = { sessionId, done: false, fail: null };
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
  }
}

/** Remove a session from the tab map AND detach any tabs that become
 *  orphaned as a result. Use after session.end. */
function releaseSessionTabs(sessionId) {
  sessionTabs.delete(sessionId);
  gcDetachedDebuggers();
}

// Defensive periodic sweep — catches anything missed by the explicit
// session.end / port.onDisconnect path (e.g. SW restarted, port recycled).
// Use chrome.alarms instead of setInterval: a plain setInterval keeps the
// MV3 service worker hot 24/7 (drains battery, prevents Chrome from
// suspending the SW), while alarms wake us up only when needed.
try {
  chrome.alarms.create('browy-debugger-gc', { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === 'browy-debugger-gc') gcDetachedDebuggers();
  });
} catch {}

async function ensureAttached(tabId) {
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
async function runCdpCall(sessionId, tabId, method, params) {
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
  addSessionTab(sessionId, tabId);
  if (recentlyDetached.delete(tabId)) {
    for (const sid of sessionsUsingTab(tabId)) postToSessionClient(sid, { type: '__debugger_attached', sessionId: sid, tabId });
  }
  try {
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

/** The tab a session acts on when it hasn't pinned one: the active tab of the
 *  panel's own window, or of the last-focused window when the panel didn't
 *  say (DevTools panels, older side panels) or its window has closed. */
async function activeTabFor(sessionId) {
  const windowId = sessionToWindow.get(sessionId);
  if (windowId != null) {
    const [own] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
    if (own) return own;
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

function tabSummary(t) {
  return { tabId: t.id, url: t.url || '', title: t.title || '', active: !!t.active, windowId: t.windowId };
}

async function handleBridgeRequest(msg) {
  const reply = (ok, payload) => {
    const out = { type: 'tool.result', sessionId: msg.sessionId, callId: msg.callId, ok };
    if (ok) out.result = payload; else out.error = String(payload?.message || payload);
    postToHost(out);
  };
  try {
    if (msg.type === 'cdp.send') {
      // The user clicked Cancel on Chrome's debugging bar during this task.
      const canceled = canceledSessions.get(msg.sessionId);
      if (canceled) throw new Error(canceled);
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
      const result = await runCdpCall(msg.sessionId, tabId, msg.method, msg.params);
      reply(true, { tabId, result });
    } else if (msg.type === 'tab.new') {
      const opts = { url: msg.url || 'about:blank', active: msg.active !== false };
      const windowId = sessionToWindow.get(msg.sessionId);
      let t;
      try { t = await chrome.tabs.create(windowId != null ? { ...opts, windowId } : opts); }
      catch { t = await chrome.tabs.create(opts); }
      reply(true, tabSummary(t));
    } else if (msg.type === 'tab.activate') {
      const t = await chrome.tabs.update(Number(msg.tabId), { active: true });
      reply(true, tabSummary(t));
    } else if (msg.type === 'tab.close') {
      const tab = await chrome.tabs.get(Number(msg.tabId));
      await chrome.tabs.remove(tab.id);
      // Report the tab the browser shows next in that window, so the agent
      // carries on there rather than jumping to another window.
      const [next] = await chrome.tabs.query({ active: true, windowId: tab.windowId }).catch(() => []);
      reply(true, next ? tabSummary(next) : null);
    } else if (msg.type === 'tab.list') {
      const tabs = await chrome.tabs.query({});
      reply(true, tabs.map(tabSummary));
    } else if (msg.type === 'tab.getActive') {
      const t = await activeTabFor(msg.sessionId);
      reply(true, t ? tabSummary(t) : null);
    }
  } catch (e) {
    reply(false, e);
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  for (const [sessionId, tabs] of sessionTabs) {
    if (tabs.has(tabId)) {
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

// ── OAuth / sign-in popup auto-attach ─────────────────────────────────────
//
// Many sign-in flows open a child window via window.open (Google OAuth,
// GitHub OAuth, SSO redirects). chrome.debugger does NOT auto-attach to
// child tabs, so the agent loses sight of the popup. Listen for new tabs
// whose openerTabId is one we already track, and attach the debugger to
// them too so they show up in tab.list / inspect_page.
chrome.tabs.onCreated.addListener((tab) => {
  try {
    if (!tab || tab.id == null) return;
    if (tab.openerTabId == null) return;
    if (!attachedTabs.has(tab.openerTabId)) return;
    // Inherit every session that was watching the opener so the agent's
    // current sessions see CDP events from the popup too.
    for (const [sid, tabs] of sessionTabs) {
      if (tabs.has(tab.openerTabId)) tabs.add(tab.id);
    }
    // Attach lazily — wait for the popup's first commit so attach doesn't
    // race with the tab's initial about:blank.
    setTimeout(() => { ensureAttached(tab.id).catch(() => {}); }, 250);
  } catch {}
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
