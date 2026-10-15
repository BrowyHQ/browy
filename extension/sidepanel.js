
// ── winctl shim ─────────────────────────────────────────────────────────
// The original UI talked to Electron via window.winctl. In the side panel
// most of these (drag/resize/minimize/close) make no sense — the panel is
// docked. We expose a stub so the existing code's optional-chaining bails
// gracefully, and route openSettings to the extension options page.
window.winctl = window.winctl || {
  openSettings: () => { try { chrome.runtime.openOptionsPage(); } catch {} },
  close:        () => { /* side panel cannot self-close */ },
  getBounds:    async () => ({ x: 0, y: 0, width: 360, height: 600 }),
  setSize:      () => {},
  dragStart:    () => {},
  dragEnd:      () => {},
  setOpacity:   () => {},
};

const msgs   = document.getElementById('msgs');
const inp    = document.getElementById('inp');
const goBtn  = document.getElementById('goBtn');
const stopBtn= document.getElementById('stopBtn');
const newChatBtn = document.getElementById('newChatBtn');
const chatsBtn = document.getElementById('chatsBtn');
const exportBtn = document.getElementById('exportBtn');
const chatsOverlay = document.getElementById('chatsOverlay');
const chatsCloseBtn = document.getElementById('chatsCloseBtn');
const chatsList = document.getElementById('chatsList');
const chatsSearch = document.getElementById('chatsSearch');
const chatsHint = document.getElementById('chatsHint');
const chatsNewBtn = document.getElementById('chatsNewBtn');
const modeTag = document.getElementById('modeTag');
const browy  = document.getElementById('browy');
const dot    = document.getElementById('dot');
const brand  = document.getElementById('brand');
const ttl    = document.getElementById('ttl');
const tabsEl = document.getElementById('tabs');
const hostEl = document.getElementById('host');
const empty  = document.getElementById('empty');
const mascotBox = document.getElementById('mascotBox');

let ws, busy = false, lastTab = null, currentAction = null, tabTitleText = 'connecting…';
// Stop's safety net (see stop()), and whether this panel restarted the backend.
let stopWatch = null, restartingHost = false;

function setTtl() {
  if (currentAction) {
    ttl.textContent = currentAction;
    ttl.classList.add('action');
  } else {
    ttl.textContent = tabTitleText;
    ttl.classList.remove('action');
  }
}

// ── Mascot pose engine ───────────────────────────────────────────
// Pose state machine: BASE pose is what we return to after any temporary state.
// Agent calls setPose('work') to enter a state; calling pose(name, ttl) auto-decays
// back to BASE after ttl ms. setBase('work') changes the resting state itself.
const VALID_POSES = new Set(['idle','left','right','up','blink','happy','think','err','work','sleep','love','wow']);
let poseTimer = null;
let basePose = 'idle';
function setBase(name) {
  if (!VALID_POSES.has(name)) return;
  basePose = name;
  if (!poseTimer) browy.dataset.pose = name;
}
function pose(name, ttl = 0) {
  if (!VALID_POSES.has(name)) return;
  browy.dataset.pose = name;
  if (poseTimer) { clearTimeout(poseTimer); poseTimer = null; }
  if (ttl > 0) {
    poseTimer = setTimeout(() => {
      poseTimer = null;
      browy.dataset.pose = basePose;
    }, ttl);
  }
}
function react(cls, ms = 400) {
  browy.classList.remove(cls);
  void browy.offsetWidth; // restart animation
  browy.classList.add(cls);
  setTimeout(() => browy.classList.remove(cls), ms);
}

// Idle micro-life: blink occasionally, glance once in a while. All discrete.
function startIdleLoop() {
  setInterval(() => {
    if (busy) return;
    if (basePose !== 'idle') return; // don't interrupt sleep/work base states
    const r = Math.random();
    if (r < 0.55) { pose('blink', 180); }       // 55%: quick blink
    else if (r < 0.72) { pose('left', 600); }   // 17%: glance left
    else if (r < 0.88) { pose('right', 600); }  // 16%: glance right
    else if (r < 0.95) { pose('up', 700); }     //  7%: look up
    else { react('nod'); }                      //  5%: small nod
  }, 3200);
}

// Map browser brand → mascot pose direction (gives the chip its personality)
function brandPose(b) {
  if (!b) return 'idle';
  const x = b.toLowerCase();
  if (x === 'brave')  return 'left';
  if (x === 'edge')   return 'right';
  if (x === 'chrome') return 'up';
  return 'idle';
}

// ── Sound: tiny WebAudio synth. 3 sounds. ───────────────────────
let audioCtx = null;
function blip(freq, dur = 0.06, type = 'square', vol = 0.04) {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch { return; }
  }
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type; osc.frequency.setValueAtTime(freq, now);
  gain.gain.setValueAtTime(vol, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.connect(gain); gain.connect(audioCtx.destination);
  osc.start(now); osc.stop(now + dur);
}
const sndSend = () => blip(880, 0.05, 'square', 0.05);
const sndRecv = () => { blip(660, 0.05, 'square', 0.04); setTimeout(() => blip(990, 0.06, 'square', 0.04), 50); };
const sndErr  = () => { blip(220, 0.12, 'sawtooth', 0.05); setTimeout(() => blip(165, 0.18, 'sawtooth', 0.05), 80); };

// ── Markdown ────────────────────────────────────────────────────
const md = typeof marked !== 'undefined' ? marked : null;
if (md && md.setOptions) md.setOptions({ breaks: true, gfm: true });
function renderMd(text) {
  if (!md) return text.replace(/</g,'&lt;');
  try { return (md.parse || md)(text); } catch { return text.replace(/</g,'&lt;'); }
}

// ── State ───────────────────────────────────────────────────────
function setBusy(b) {
  busy = b;
  if (!b && stopWatch) { clearTimeout(stopWatch); stopWatch = null; }
  goBtn.disabled = busy || !inp.value.trim();
  stopBtn.classList.toggle('show', b);
  dot.classList.toggle('busy', b);
  if (b) {
    setBase('think');
    pose('think');
  } else {
    setBase('idle');
    pose(brandPose(lastTab?.brand), 800);
  }
}
function setError(on) {
  dot.classList.toggle('err', on);
  if (on) { pose('err', 1500); react('shake'); sndErr(); }
}
function setLive(on) { dot.classList.toggle('live', on); }

// ── Transport: chrome.runtime port → BrowyProtocol → legacy WSMessage shim ──
//
// The original UI was written against a simple WebSocket sending WSMessage
// JSON. In the extension we connect to the background SW (which forwards to
// the native host) and speak BrowyProtocol. We keep the existing handle()
// function unchanged by translating both directions.

// Stable session id (persisted in chrome.storage.local) so reloading the
// side panel resumes the same conversation on disk instead of starting fresh.
//
// The chat itself lives in its Copilot session; the panel renders what the
// host reads from it (see "Chat history" below) and keeps no transcript of
// its own:
//   browy.sessionId       current chat id
//   browy.view.<id>       the newest turns last shown, for an instant first
//                         paint; replaced as soon as the session answers
//   browy.viewIndex       ids with a cached view, newest first
//   browy.chatList        the last full chats list, for the overlay
// Up to 0.1.13 the panel stored each chat's HTML as the record:
//   browy.chat.<id>       rendered HTML for that chat
//   browy.chatMeta.<id>   { id, title, updated, preview }
//   browy.chatIndex       ordered list of ids (newest first)
// Those are only read now, for chats whose session has no event log any
// more: they show as read-only saved copies.
let BROWY_SESSION_ID = null;
const SID_KEY    = 'browy.sessionId';
const CHAT_PREFIX = 'browy.chat.';
const META_PREFIX = 'browy.chatMeta.';
const INDEX_KEY  = 'browy.chatIndex';
const VIEW_PREFIX = 'browy.view.';
const VIEW_INDEX_KEY = 'browy.viewIndex';
const LIST_CACHE_KEY = 'browy.chatList';

function newSessionId() {
  return 'sp-' + Math.random().toString(36).slice(2, 10);
}

// The window this panel lives in. Sent with session.start so the agent works
// on this window's tabs: before 0.1.11 every panel followed the last-focused
// window, so clicking into another window moved Browy's target with you.
const panelWindowId = (chrome.windows && chrome.windows.getCurrent)
  ? chrome.windows.getCurrent().then((w) => (w && w.id != null ? w.id : null)).catch(() => null)
  : Promise.resolve(null);

async function startSession() {
  const windowId = await panelWindowId;
  browyPost({
    type: 'session.start',
    sessionId: BROWY_SESSION_ID,
    capabilities: ['cdp.activeTab'],
    ...(windowId != null ? { windowId } : {}),
  });
}

async function loadStoredSessionId() {
  try {
    const r = await chrome.storage.local.get([SID_KEY]);
    if (r && typeof r[SID_KEY] === 'string' && r[SID_KEY]) return r[SID_KEY];
  } catch {}
  const fresh = newSessionId();
  try { await chrome.storage.local.set({ [SID_KEY]: fresh }); } catch {}
  return fresh;
}

/** The HTML copy 0.1.13 and earlier kept of a chat, if any. */
async function loadLegacyChatHtml(id) {
  if (!id) return null;
  try {
    const r = await chrome.storage.local.get([CHAT_PREFIX + id]);
    const v = r && r[CHAT_PREFIX + id];
    if (typeof v === 'string' && v.trim() && v.indexOf('class="empty"') === -1) return v;
  } catch {}
  return null;
}

async function loadChatIndex() {
  try {
    const r = await chrome.storage.local.get([INDEX_KEY]);
    if (Array.isArray(r?.[INDEX_KEY])) return r[INDEX_KEY];
  } catch {}
  return [];
}

async function deleteChatStorage(id) {
  try { await chrome.storage.local.remove([CHAT_PREFIX + id, META_PREFIX + id, VIEW_PREFIX + id]); } catch {}
  const idx = await loadChatIndex();
  const next = idx.filter(x => x !== id);
  try { await chrome.storage.local.set({ [INDEX_KEY]: next }); } catch {}
  try {
    const views = await loadViewIndex();
    if (views.some((v) => v.id === id)) await chrome.storage.local.set({ [VIEW_INDEX_KEY]: views.filter((v) => v.id !== id) });
  } catch {}
}

/** [{ id, title, at }], newest first: the chats with a cached view. */
async function loadViewIndex() {
  try {
    const r = await chrome.storage.local.get([VIEW_INDEX_KEY]);
    const v = r?.[VIEW_INDEX_KEY];
    if (Array.isArray(v)) return v.filter((x) => x && typeof x.id === 'string');
  } catch {}
  return [];
}

function deriveChatTitle(htmlOrText) {
  // Pull the first user bubble's text — that's the natural chat title.
  try {
    const tmp = document.createElement('div');
    tmp.innerHTML = htmlOrText || '';
    const userBub = tmp.querySelector('.bub.u, .u');
    const text = (userBub?.textContent || '').trim();
    if (text) return text.slice(0, 60);
  } catch {}
  return 'Untitled chat';
}

// Export the current chat as a Markdown file. Walks the rendered bubbles
// (the source of truth for what the user actually saw), preserving role +
// reasoning + tool-step summaries + body. Assistant bodies are already
// rendered HTML, so we round-trip them through innerText to get a plain
// readable transcript without HTML noise.
function exportChat() {
  try {
    const bubs = msgs.querySelectorAll('.bub');
    if (!bubs.length) {
      flash('nothing to export');
      return;
    }
    const lines = [];
    const title = deriveChatTitle(msgs.innerHTML) || 'Untitled chat';
    lines.push('# ' + title);
    lines.push('');
    lines.push('_Exported from Browy on ' + new Date().toISOString() + '_');
    lines.push('');
    for (const bub of bubs) {
      const isUser = bub.classList.contains('u');
      if (isUser) {
        lines.push('## You');
        lines.push('');
        lines.push((bub.innerText || bub.textContent || '').trim());
      } else {
        lines.push('## Browy');
        lines.push('');
        const reasoning = bub.querySelector('.reasoning');
        if (reasoning) {
          const txt = (reasoning.innerText || '').trim();
          if (txt) {
            lines.push('<details><summary>reasoning</summary>');
            lines.push('');
            lines.push(txt);
            lines.push('');
            lines.push('</details>');
            lines.push('');
          }
        }
        const steps = bub.querySelector('.tool-steps');
        if (steps) {
          const stepLines = [];
          steps.querySelectorAll('.step, .tool-step').forEach(s => {
            const t = (s.innerText || '').trim().replace(/\s+/g, ' ');
            if (t) stepLines.push('- ' + t);
          });
          if (stepLines.length) {
            lines.push('<details><summary>tool calls</summary>');
            lines.push('');
            lines.push(...stepLines);
            lines.push('');
            lines.push('</details>');
            lines.push('');
          }
        }
        const body = bub.querySelector('.body');
        const bodyText = body ? (body.innerText || '').trim() : (bub.innerText || '').trim();
        if (bodyText) lines.push(bodyText);
      }
      lines.push('');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeTitle = (title || 'chat').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 40);
    const a = document.createElement('a');
    a.href = url;
    a.download = `browy-${safeTitle}-${ts}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    flash('exported');
  } catch (e) {
    console.error('[browy] exportChat failed:', e);
    flash('export failed');
  }
}

// Brief toast at the top of the panel for export feedback. Uses the
// existing infobar host slot, falling back to console if it's not in the DOM.
function flash(text, ms = 1600) {
  try {
    const slot = document.getElementById('host');
    if (!slot) return;
    const prev = slot.textContent;
    slot.textContent = text;
    slot.style.opacity = '1';
    setTimeout(() => { slot.textContent = prev || ''; }, ms);
  } catch {}
}

// Each panel instance gets its own port name. This used to be the constant
// string 'sidepanel', which meant two side panels in two windows both landed
// on the same key in the background's `clients` map: the second overwrote the
// first, every host reply routed to the newer window, and the older one went
// silently dead. Worse, whichever closed first deleted the survivor's entry
// and ended its session.
const PORT_NAME = 'sidepanel-' + Math.random().toString(36).slice(2, 10);

let bgPort = null;
let sessionReady = false;
// Copilot SDK readiness is a SEPARATE, much later milestone than
// session.ready — measured ~7.7s apart on a cold host. chat.list returns
// nothing until it lands, so the overlay must not treat that as "no chats".
let sdkReady = false;
let sdkFailedDetail = null;
let pendingChat = '';

function browyPost(msg) {
  if (!bgPort) return;
  try { bgPort.postMessage(msg); } catch {}
}

// Translate legacy WSMessage (what the UI emits) → BrowyProtocol → host.
// The last message sent, kept so it can be sent once more if the backend
// turns out not to know this chat (see the 'no_session' handling below).
let lastChatText = null;
let lastChatResent = false;
let resendOnReady = null;
function browySend(legacy) {
  if (!bgPort) return;
  if (legacy.type === 'chat') {
    pendingChat = '';
    lastChatText = legacy.text;
    lastChatResent = false;
    browyPost({ type: 'chat.send', sessionId: BROWY_SESSION_ID, text: legacy.text });
  } else if (legacy.type === 'stop') {
    browyPost({ type: 'chat.cancel', sessionId: BROWY_SESSION_ID });
  } else if (legacy.type === 'clear') {
    browyPost({ type: 'history.clear', sessionId: BROWY_SESSION_ID });
  } else if (legacy.type === 'copilot_signin' || legacy.type === 'auth.signin') {
    browyPost({ type: 'auth.signin' });
  } else if (legacy.type === 'list_models') {
    browyPost({ type: 'models.list' });
  } else if (legacy.type === 'set_model') {
    browyPost({ type: 'models.set', id: legacy.id });
  } else if (legacy.type === 'launch_browser') {
    // Not yet supported in extension transport; ignore.
  }
}

// Translate BrowyProtocol ServerMessage → legacy WSMessage shape.
function browyTranslate(msg) {
  switch (msg.type) {
    case 'chat.delta':
      pendingChat += msg.text || '';
      return { type: 'delta', text: msg.text };
    case 'chat.tool_call':
      return { type: 'tool_step', id: msg.callId, name: msg.tool, args: msg.args, status: 'start' };
    case 'chat.tool_result':
      return { type: 'tool_step', id: msg.callId, name: '', status: msg.ok ? 'end' : 'error', result: msg.summary, durationMs: msg.durationMs };
    case 'chat.done':
      return { type: 'response', text: msg.text || pendingChat, toolCalls: msg.toolCalls || [], stopped: !!msg.stopped };
    case 'chat.queued':
      return { type: 'queued', position: msg.position };
    case 'chat.error':
      if (msg.code === 'auth') return { type: 'copilot_status', state: 'unauth', detail: msg.message, _fromError: true };
      return { type: 'status', status: 'error', detail: msg.message };
    case 'event.activity':
      if (msg.event && msg.event.startsWith('status.')) {
        return { type: 'status', status: msg.event.slice(7), detail: msg.text };
      }
      return { type: 'activity', event: msg.event, tool: msg.tool, args: msg.args, durationMs: msg.durationMs, inputCount: msg.inputCount };
    case 'tab.focused':
      return { type: 'focused_tab', url: msg.url, title: msg.title, brand: msg.brand, tabCount: msg.tabCount };
    case 'browsers.status':
      return { type: 'browsers_status', browsers: msg.browsers };
    case 'browsers.active':
      return { type: 'active_browsers', active: msg.active };
    case 'models.list':
      return { type: 'models_list', models: msg.models };
    case 'models.current':
      return { type: 'current_model', id: msg.id };
    case 'auth.status':
      // Probe-driven auth state arrives at session.start and after SDK init.
      // We deliberately IGNORE it for banner display — banners are reactive,
      // shown only when a real chat fails with auth. We still translate so
      // settings UI / future consumers can listen if they want.
      return { type: 'copilot_status', state: msg.state, detail: msg.detail, _fromProbe: true };
    case 'chat.list.result':
    case 'chat.history.result':
      onRpcReply(msg);
      return null;
    case 'chat.delete.result': {
      const list = pendingChatDeleteResolvers.get(msg.id);
      if (list) {
        pendingChatDeleteResolvers.delete(msg.id);
        list.forEach(fn => fn(!!msg.ok));
      }
      return null;
    }
    default:
      return null;
  }
}

// Requests for the chats list and chat history. Each carries a request id the
// host echoes back, and names this panel's session once the host has
// confirmed it, so the reply comes to this panel alone. A host before 0.1.14
// echoes nothing and sends every reply to every panel; its replies are taken
// in order of asking.
//
// Timeouts end every wait with a message. On a cold host the Copilot SDK can
// take 8 to 40 s after session.ready before it answers, and an empty answer
// then looked exactly like "you have no chats", so the wait is longer until
// sdk.ready has arrived.
let LIST_TIMEOUT_MS = 20_000;
let HISTORY_TIMEOUT_MS = 20_000;
const COLD_TIMEOUT_MS = 90_000;
const pendingRpcs = new Map();
let rpcSeq = 0;
/** Set once a reply carried our request id: the host routes and echoes. */
let hostEchoesReqId = false;
/** The session the host last confirmed with session.ready for this panel. */
let routedSid = null;
const routeWaiters = [];

function rpcTimeout(warm) { return sdkReady ? warm : COLD_TIMEOUT_MS; }

/** Send a chat.list / chat.history request. Resolves with { msg } or with
 *  { timedOut }, { offline } or { stale } (the panel moved to another chat). */
function hostRpc(kind, payload, { timeoutMs, onPartial } = {}) {
  return new Promise((resolve) => {
    const reqId = 'q' + (++rpcSeq) + Math.random().toString(36).slice(2, 6);
    const entry = { kind, id: payload.id, onPartial, timer: null, done: null };
    entry.done = (v) => {
      if (pendingRpcs.get(reqId) !== entry) return;
      clearTimeout(entry.timer);
      pendingRpcs.delete(reqId);
      resolve(v);
    };
    pendingRpcs.set(reqId, entry);
    entry.timer = setTimeout(() => entry.done({ timedOut: true }), timeoutMs);
    if (!bgPort) { entry.done({ offline: true }); return; }
    const route = routedSid && routedSid === BROWY_SESSION_ID ? { sessionId: routedSid } : {};
    browyPost({ ...payload, reqId, ...route });
  });
}

function onRpcReply(msg) {
  const kind = msg.type === 'chat.list.result' ? 'list' : 'history';
  if (msg.reqId) {
    hostEchoesReqId = true;
    const entry = pendingRpcs.get(msg.reqId);
    if (!entry) return;
    if (kind === 'list' && msg.complete === false) { try { entry.onPartial?.(msg); } catch {} return; }
    entry.done({ msg });
    return;
  }
  // No request id: an older host, or the DevTools panel's request.
  if (hostEchoesReqId) return;
  for (const entry of [...pendingRpcs.values()]) {
    if (entry.kind !== kind || (kind === 'history' && entry.id !== msg.id)) continue;
    entry.done({ msg });
  }
}

/** Requests in flight were for the chat that was on screen. */
function dropPendingRpcs(why = 'stale') {
  for (const entry of [...pendingRpcs.values()]) entry.done({ [why]: true });
}

/** Resolves 'ready' once the host confirms `sid`, so replies can be routed;
 *  'conflict' if another window holds it; 'timeout' otherwise. */
function waitRoute(sid, ms) {
  if (routedSid === sid) return Promise.resolve('ready');
  return new Promise((resolve) => {
    const w = { sid, resolve: null };
    const timer = setTimeout(() => finish('timeout'), ms);
    function finish(v) {
      clearTimeout(timer);
      const i = routeWaiters.indexOf(w);
      if (i >= 0) routeWaiters.splice(i, 1);
      resolve(v);
    }
    w.resolve = finish;
    routeWaiters.push(w);
  });
}

function onRouteReady(sid) {
  routedSid = sid || null;
  for (const w of [...routeWaiters]) if (w.sid === sid) w.resolve('ready');
}

function onRouteLost(why) {
  routedSid = null;
  for (const w of [...routeWaiters]) w.resolve(why);
}

/** Delete a chat on disk. Resolves true only when the host confirms. */
const pendingChatDeleteResolvers = new Map();
function requestChatDelete(id, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    if (!pendingChatDeleteResolvers.has(id)) pendingChatDeleteResolvers.set(id, []);
    pendingChatDeleteResolvers.get(id).push(fin);
    browyPost({ type: 'chat.delete', id });
    setTimeout(() => fin(false), timeoutMs);
  });
}

// A tiny stand-in for the legacy `ws` variable so existing code that
// does `ws.send(JSON.stringify(...))` and checks `ws.readyState` keeps
// working unchanged.
//
// `readyState` returns 1 as soon as the bg port exists. Pre-`session.ready`
// chat sends are queued and flushed once the host's session.ready arrives,
// so the send button isn't silently dead during the host's cold start.
const pendingHostMsgs = [];
function flushPendingHostMsgs() {
  if (!sessionReady) return;
  while (pendingHostMsgs.length) {
    const m = pendingHostMsgs.shift();
    browyPost(m);
  }
}
const wsShim = {
  get readyState() { return bgPort ? 1 : 0; },
  send(json) {
    try {
      const legacy = JSON.parse(json);
      if (legacy.type === 'chat' && !sessionReady) {
        // Queue the chat send until the host confirms the session is up.
        pendingHostMsgs.push({ type: 'chat.send', sessionId: BROWY_SESSION_ID, text: legacy.text });
        return;
      }
      browySend(legacy);
    } catch {}
  },
};

// Track consecutive failed reconnect attempts. After a few in a row we assume
// the extension was reloaded and our chrome.runtime context is stale → reload
// the side panel page itself so we get a fresh context.
let reconnectAttempts = 0;
const RELOAD_AFTER_FAILURES = 5;
const INSTALL_PS1_URL = 'https://browyhq.github.io/install/';
const INSTALL_SH_URL = 'https://browyhq.github.io/install/';
// The README one-liners. Running either one again updates an existing install
// in place, so they double as the update commands.
const INSTALL_CMDS = {
  win:  'irm https://github.com/BrowyHQ/browy/releases/latest/download/install.ps1 | iex',
  unix: 'curl -fsSL https://github.com/BrowyHQ/browy/releases/latest/download/install.sh | bash',
};
// Lowest host protocol this panel fully works with. Bump it together with
// PROTOCOL_VERSION in src/protocol.ts when the panel starts relying on
// something new from the host.
const MIN_HOST_PROTOCOL = 2;
const HOST_UPDATE_SNOOZE_KEY = 'browy.hostUpdateSnoozeUntil';
const FIRST_SEND_KEY = 'browy.firstSendDone';

// Reconnect / host-loss banner shown above the chat panel.
function showConnBanner(text, opts = {}) {
  const el = document.getElementById('connBanner');
  const txt = document.getElementById('connBannerText');
  const act = document.getElementById('connBannerAction');
  if (!el || !txt || !act) return;
  txt.textContent = text;
  act.innerHTML = '';
  if (opts.action) {
    const a = document.createElement('a');
    a.textContent = opts.action.label;
    a.href = opts.action.href || '#';
    if (opts.action.href) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    } else if (opts.action.onClick) {
      a.addEventListener('click', (e) => { e.preventDefault(); opts.action.onClick(); });
    }
    act.appendChild(a);
  }
  el.classList.toggle('warn', !!opts.warn);
  el.classList.add('show');
}
function hideConnBanner() {
  const el = document.getElementById('connBanner');
  if (el) el.classList.remove('show');
}

function isExtensionContextInvalidated() {
  // chrome.runtime.id is undefined once the extension's context is invalidated.
  try { return !chrome.runtime?.id; } catch { return true; }
}

// Disable/enable every interactive control that requires the backend.
//
// THREE states, not two — conflating "backend still booting" with "backend
// not installed" told correctly-installed users to go install a backend for
// the ~10s the host takes to cold start, which is the single most damaging
// first-impression bug we had.
//
//   'online'  — host + SDK up, everything live.
//   'booting' — host process is starting. Input stays ENABLED so the user
//               can type (and even send) while we warm up; sends are queued
//               by wsShim and flushed on session.ready.
//   'offline' — host missing / stale / crashed. Real install CTA.
//
// newChatBtn is intentionally never gated — it's a pure local reset.
let hostState = 'offline';
function setControlsState(state) {
  hostState = state;
  const typingAllowed = state === 'online' || state === 'booting';
  const inp_ = document.getElementById('inp');
  if (inp_) {
    inp_.disabled = !typingAllowed;
    inp_.style.opacity = typingAllowed ? '' : '0.4';
    inp_.style.cursor = typingAllowed ? '' : 'not-allowed';
    inp_.placeholder = state === 'online' ? ''
      : state === 'booting' ? 'starting browy backend — you can start typing…'
      : 'offline — install the browy backend to chat';
  }
  // Send is allowed while booting (queued), but only with actual text.
  const go = document.getElementById('goBtn');
  if (go) {
    const hasText = !!(inp_ && inp_.value.trim());
    go.disabled = !typingAllowed || busy || !hasText;
    go.style.opacity = typingAllowed ? '' : '0.4';
    go.style.cursor = typingAllowed ? '' : 'not-allowed';
  }
  // Stop only makes sense on a live turn.
  const stop_ = document.getElementById('stopBtn');
  if (stop_) {
    stop_.disabled = state !== 'online';
    stop_.style.opacity = state === 'online' ? '' : '0.4';
    stop_.style.cursor = state === 'online' ? '' : 'not-allowed';
  }
  // The chats overlay reads from the host, so it needs a live host. During
  // boot we still allow opening it — it shows a "loading history" state.
  const chats_ = document.getElementById('chatsBtn');
  if (chats_) {
    chats_.disabled = !typingAllowed;
    chats_.style.opacity = typingAllowed ? '' : '0.4';
    chats_.style.cursor = typingAllowed ? '' : 'not-allowed';
  }
}

// Back-compat shim removed — all callers use setControlsState directly.

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

// ── First-run screen ───────────────────────────────────────────────────────
//
// Shown when Chrome reports the native host as missing (never installed) or
// stale (installed, but its manifest predates this extension's id). It
// replaces a red one-line banner over a disabled input, which is where
// first-run users were being lost: installing the host is the one step that
// leaves the browser. Nothing here phones home; the screen simply goes away
// the first time the host answers.

// Map the platform to one of the two install commands we ship.
// `platformOs` is chrome.runtime.getPlatformInfo().os; `navPlatform` is the
// navigator fallback for when that API is unavailable.
function osKey(platformOs, navPlatform) {
  const o = String(platformOs || '').toLowerCase();
  if (o === 'win') return 'win';
  if (o === 'cros') return 'cros';
  if (o === 'mac' || o === 'linux' || o === 'openbsd') return 'unix';
  const p = String(navPlatform || '').toLowerCase();
  if (p.startsWith('win')) return 'win';
  if (p.includes('cros') || p.includes('chrome os')) return 'cros';
  return 'unix';
}

let onboardMode = null;    // null | 'missing' | 'stale'
let onboardOs = 'win';     // tab currently shown: 'win' | 'unix' | 'cros'
let detectedOs = null;     // what this machine actually is
let obPhase = 'waiting';   // 'waiting' | 'checking' | 'starting' | 'crashed'
let obPollTimer = null;
let obProbeTimer = null;
// Chrome answers a probe for a missing host in ~5 ms, so without a floor the
// "checking…" from the button was never actually visible and the button
// looked dead.
const OB_CHECKING_MIN_MS = 800;
let obCheckingUntil = 0;

const OB_WHERE = {
  win:  'open PowerShell, paste, press enter. about 80 MB, installs into your user folder, no admin rights needed.',
  unix: 'open a terminal, paste, press enter. about 80 MB, installs into your home folder, no sudo needed.',
};
const OB_STATUS = {
  waiting:  "waiting for the backend. this screen moves on by itself once it's installed.",
  waitingUpdate: "waiting for the update. this screen moves on by itself once it's done.",
  checking: 'checking…',
  starting: 'found it. starting the backend, the first start takes a few seconds…',
  crashed:  'found the backend, but it stopped while starting. retrying… if this keeps happening, run the command again to reinstall.',
};

async function detectOs() {
  if (detectedOs) return detectedOs;
  let platformOs = '';
  try { platformOs = (await chrome.runtime.getPlatformInfo())?.os || ''; } catch {}
  detectedOs = osKey(platformOs, navigator.userAgentData?.platform || navigator.platform);
  return detectedOs;
}

function renderOnboard() {
  const el = document.getElementById('onboard');
  if (!el) return;
  el.dataset.os = onboardOs;
  el.dataset.phase = obPhase;
  const title = document.getElementById('obTitle');
  const why = document.getElementById('obWhy');
  if (onboardOs === 'cros') {
    if (title) title.textContent = 'the backend needs windows, macos or linux';
    if (why) why.textContent = "browy's agent runs as a small program on your computer, and chromeos can't run it yet.";
  } else if (onboardMode === 'stale') {
    if (title) title.textContent = 'update the backend';
    if (why) why.textContent = 'the backend on this computer is too old to talk to this version of the extension. running the installer again updates it in place and keeps your chats.';
  } else {
    if (title) title.textContent = 'install the backend';
    if (why) why.textContent = 'the agent runs in a small program on this computer. this panel is its window.';
  }
  const cmdKey = onboardOs === 'win' ? 'win' : 'unix';
  const cmd = document.getElementById('obCmd');
  if (cmd) cmd.textContent = INSTALL_CMDS[cmdKey];
  const where = document.getElementById('obWhere');
  if (where) where.textContent = OB_WHERE[cmdKey];
  el.querySelectorAll('.ob-os button').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.os === cmdKey));
  });
  const status = document.getElementById('obStatus');
  if (status) {
    status.textContent = obPhase === 'waiting' && onboardMode === 'stale'
      ? OB_STATUS.waitingUpdate
      : (OB_STATUS[obPhase] || OB_STATUS.waiting);
  }
}

function setOnboardPhase(phase) {
  obPhase = phase;
  renderOnboard();
}

// Idempotent: while the screen is up, every probe that finds nothing lands
// here again.
function showOnboarding(mode) {
  const el = document.getElementById('onboard');
  if (!el) return;
  const firstShow = !onboardMode;
  onboardMode = mode;
  // The verdict is in; cancel the "must be starting" guess that awaited it.
  clearTimeout(obProbeTimer); obProbeTimer = null;
  const hold = obPhase === 'checking' ? obCheckingUntil - Date.now() : 0;
  if (hold > 0) {
    // Let a manual "checking…" register before settling back.
    obProbeTimer = setTimeout(() => {
      obProbeTimer = null;
      if (onboardMode && obPhase === 'checking') setOnboardPhase('waiting');
    }, hold);
  } else {
    obPhase = 'waiting';
  }
  if (firstShow) {
    onboardOs = detectedOs || onboardOs;
    detectOs().then((os) => {
      if (onboardMode && onboardOs !== os) { onboardOs = os; renderOnboard(); }
    });
    setBase('sleep');
  }
  hideConnBanner();
  hideHostUpdateBanner();
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
  renderOnboard();
  if (!obPollTimer && onboardOs !== 'cros') startOnboardPolling();
}

/** @returns {boolean} whether the screen was actually showing. */
function hideOnboarding() {
  if (!onboardMode) return false;
  onboardMode = null;
  stopOnboardPolling();
  clearTimeout(obProbeTimer); obProbeTimer = null;
  const el = document.getElementById('onboard');
  if (el) {
    el.classList.remove('open');
    el.setAttribute('aria-hidden', 'true');
  }
  setBase('idle');
  return true;
}

// Cheap: Chrome rejects a missing host in milliseconds without spawning
// anything. The traffic also keeps the service worker from idling out.
function startOnboardPolling() {
  stopOnboardPolling();
  obPollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') probeHost(false);
  }, 4000);
}
function stopOnboardPolling() {
  if (obPollTimer) { clearInterval(obPollTimer); obPollTimer = null; }
}

function probeHost(manual) {
  if (!bgPort || !onboardMode || onboardOs === 'cros') return;
  if (manual && obPhase !== 'starting') {
    obCheckingUntil = Date.now() + OB_CHECKING_MIN_MS;
    setOnboardPhase('checking');
  }
  try { bgPort.postMessage({ type: '__retry_host' }); } catch { return; }
  armStartingGuess();
}

// A missing or stale host is rejected within milliseconds. If no verdict has
// arrived by now, a real host process is running and just hasn't finished its
// cold start (about 10 s).
function armStartingGuess() {
  clearTimeout(obProbeTimer);
  obProbeTimer = setTimeout(() => {
    obProbeTimer = null;
    if (onboardMode && obPhase !== 'crashed') setOnboardPhase('starting');
  }, 2500);
}

// ── Host-update banner ─────────────────────────────────────────────────────
//
// The Web Store auto-updates this extension; nothing updates the host. So
// after every release, users run a new panel against an old host, and
// features quietly fail (deleting a chat just times out on a pre-0.1.6 host).
// When the host reports an older protocol than we need, say so once, with the
// command that fixes it.
function shouldOfferHostUpdate(protocol, minProtocol, snoozeUntil, now) {
  const p = Number(protocol);
  if (Number.isFinite(p) && p >= minProtocol) return false;
  return !(Number(snoozeUntil) > now);
}

async function offerHostUpdateIfNeeded(protocol) {
  let snoozeUntil = 0;
  try {
    const r = await chrome.storage.local.get([HOST_UPDATE_SNOOZE_KEY]);
    snoozeUntil = r[HOST_UPDATE_SNOOZE_KEY] || 0;
  } catch {}
  if (!shouldOfferHostUpdate(protocol, MIN_HOST_PROTOCOL, snoozeUntil, Date.now())) {
    hideHostUpdateBanner();
    return;
  }
  const os = await detectOs();
  if (hostState === 'offline') return; // went down while we were deciding
  const b = document.getElementById('updBanner');
  if (!b) return;
  b.dataset.cmd = INSTALL_CMDS[os === 'win' ? 'win' : 'unix'];
  b.dataset.where = os === 'win' ? 'PowerShell' : 'a terminal';
  const t = document.getElementById('updBannerText');
  if (t) t.textContent = 'browy backend is out of date';
  b.classList.add('show');
}
function hideHostUpdateBanner() {
  document.getElementById('updBanner')?.classList.remove('show');
}

// ── "Try one of these" ─────────────────────────────────────────────────────
//
// Shown on the empty chat until the first message is ever sent, then never
// again. Right after installing from the Web Store the active tab is usually
// the store itself, which Chrome never lets an extension read, so a suggestion
// sent from there could only fail.
let firstSendDone = true; // until storage says otherwise; never flash these at existing users
// Cached on purpose: #empty is detached from the DOM whenever a chat has
// messages, and getElementById can't find detached nodes. Looking these up
// on demand silently skipped every update made mid-chat, so the suggestions
// reappeared on the next new chat after the first send had retired them.
const trySuggestEl = document.getElementById('trySuggest');
const tryWarnEl = document.getElementById('tryWarn');

function isRestrictedUrl(url) {
  let u;
  try { u = new URL(url); } catch { return true; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
  const h = u.hostname;
  if (h === 'chromewebstore.google.com') return true;
  if (h === 'chrome.google.com' && u.pathname.startsWith('/webstore')) return true;
  if (h === 'microsoftedge.microsoft.com' && u.pathname.startsWith('/addons')) return true;
  return false;
}

async function loadFirstSendFlag() {
  try {
    const r = await chrome.storage.local.get([FIRST_SEND_KEY, INDEX_KEY]);
    if (r[FIRST_SEND_KEY]) return true;
    // Saved chats predate this flag and prove a message was sent.
    if (Array.isArray(r[INDEX_KEY]) && r[INDEX_KEY].length) {
      chrome.storage.local.set({ [FIRST_SEND_KEY]: true }).catch(() => {});
      return true;
    }
    return false;
  } catch { return true; }
}

function markFirstSendDone() {
  if (firstSendDone) return;
  firstSendDone = true;
  updateTrySuggestions();
  chrome.storage.local.set({ [FIRST_SEND_KEY]: true }).catch(() => {});
}

function updateTrySuggestions() {
  if (!trySuggestEl) return;
  const show = !firstSendDone && (hostState === 'online' || hostState === 'booting');
  trySuggestEl.hidden = !show;
  if (tryWarnEl) tryWarnEl.hidden = !(show && lastTab?.url && isRestrictedUrl(lastTab.url));
}

function useSuggestion(text) {
  if (hostState === 'offline' || busy || !text) return;
  inp.value = text;
  autoSize();
  goBtn.disabled = false;
  // Fill but don't fire on a page the agent can't touch; the warning says why.
  if (lastTab?.url && isRestrictedUrl(lastTab.url)) { inp.focus(); return; }
  send();
}

// Everything the panel does when the host goes away, whatever the reason.
function markHostDown() {
  sessionReady = false;
  sdkReady = false;
  setLive(false);
  if (busy) setBusy(false);
  brand.textContent = 'offline';
  tabTitleText = '—'; currentAction = null; setTtl();
  hideHostUpdateBanner();
  try {
    const hint = document.querySelector('#empty .hint');
    if (hint) hint.textContent = '// offline. check that the browy backend is installed and running';
    setControlsState('offline');
    updateTrySuggestions();
    if (typeof closeChatsOverlay === 'function') closeChatsOverlay();
  } catch {}
}

function connect() {
  // Hard-fail fast if our context is dead — full page reload picks up the
  // freshly-installed extension code + a working chrome.runtime.
  if (isExtensionContextInvalidated()) {
    try { location.reload(); } catch {}
    return;
  }
  try {
    bgPort = chrome.runtime.connect({ name: PORT_NAME });
  } catch (e) {
    // "Extension context invalidated." — same root cause as above.
    bgPort = null;
    if (++reconnectAttempts >= RELOAD_AFTER_FAILURES) {
      try { location.reload(); } catch {}
      return;
    }
    setTimeout(connect, 1000);
    return;
  }
  ws = wsShim;
  bgPort.onMessage.addListener((raw) => {
    if (raw.type === '__host_ready') {
      reconnectAttempts = 0;
      const cameFromOnboarding = hideOnboarding();
      hideConnBanner();
      setLive(true); setError(false); brand.textContent = '·';
      try {
        const hint = document.querySelector('#empty .hint');
        if (hint) hint.textContent = '// type below';
        setControlsState('online');
        updateTrySuggestions();
      } catch {}
      startSession();
      refreshActiveTab();
      offerHostUpdateIfNeeded(raw.protocol);
      if (cameFromOnboarding) {
        // The one moment of the install that deserves a reaction.
        pose('love', 1800); react('bounce'); sndRecv();
        try { inp.focus(); } catch {}
      }
      return;
    }
    if (raw.type === '__host_pending') {
      reconnectAttempts = 0; // SW is alive even if host isn't
      if (onboardMode) {
        // Our port to the service worker was re-established and it is asking
        // for the host again. Keep the first-run screen up: a missing host is
        // rejected in milliseconds, and a real one arrives as __host_ready.
        armStartingGuess();
        return;
      }
      brand.textContent = 'starting…';
      // A new backend is starting, so this chat isn't registered with it
      // yet; messages wait for session.ready.
      sessionReady = false;
      // Booting is NOT offline. Let the user type (and queue a send) while
      // the host cold-starts, and never tell them to install a backend they
      // already have.
      try {
        setControlsState('booting');
        updateTrySuggestions();
        // Keep the notice up if this panel asked for the restart.
        if (!restartingHost) hideConnBanner();
        const hint = document.querySelector('#empty .hint');
        if (hint) hint.textContent = '// starting the browy backend — first run takes a few seconds';
      } catch {}
      return;
    }
    if (raw.type === '__host_missing' || raw.type === '__host_stale') {
      markHostDown();
      showOnboarding(raw.type === '__host_stale' ? 'stale' : 'missing');
      return;
    }
    if (raw.type === '__host_error' || raw.type === '__host_disconnected') {
      markHostDown();
      if (onboardMode) {
        // Found a host but it died starting up. After a disconnect the service
        // worker retries on its own backoff, so stop adding probes on top.
        // __host_error gets no automatic retry, so keep probing for that one.
        if (raw.type === '__host_disconnected') stopOnboardPolling();
        clearTimeout(obProbeTimer); obProbeTimer = null;
        setOnboardPhase('crashed');
        return;
      }
      try {
        showConnBanner('Host disconnected. Retrying…', {
          warn: true,
          action: { label: 'Reinstall →', href: INSTALL_PS1_URL },
        });
      } catch {}
      return;
    }
    if (raw.type === '__session_conflict') {
      // Another window already owns this session id. Take a fresh one rather
      // than fighting over the routing, and keep whatever is on screen: the
      // conversation the user can see has not been sent anywhere yet.
      onRouteLost('conflict');
      onHistoryConflict();
      (async () => {
        BROWY_SESSION_ID = newSessionId();
        try { await chrome.storage.local.set({ [SID_KEY]: BROWY_SESSION_ID }); } catch {}
        startSession();
      })();
      return;
    }
    if (raw.type === 'session.ready') {
      sessionReady = true;
      restartingHost = false;
      onRouteReady(raw.sessionId);
      // Safety net: any real message from the host proves it's alive, so
      // make sure the online controls reflect that even if __host_ready
      // was somehow missed during a fast SW restart.
      try { hideOnboarding(); setControlsState('online'); updateTrySuggestions(); hideConnBanner(); } catch {}
      refreshActiveTab();
      flushPendingHostMsgs();
      if (resendOnReady) {
        const text = resendOnReady;
        resendOnReady = null;
        browyPost({ type: 'chat.send', sessionId: BROWY_SESSION_ID, text });
      }
      // A chat painted from the panel's cache at boot gets the session's version.
      onHistorySessionReady();
      // If the chats overlay was opened while the host was still booting,
      // it'll be stuck on the "connecting…" placeholder. Re-render now
      // so the SDK-backed history pops in without the user having to
      // close and reopen.
      try {
        if (chatsOverlay && chatsOverlay.classList.contains('open')) {
          renderChatsList(chatsSearch?.value || '');
        }
      } catch {}
      return;
    }
    if (raw.type === 'sdk.ready') {
      // The Copilot SDK subprocess has finished booting. Before this point
      // chat.list legitimately returns nothing, so any overlay currently
      // showing a "loading history" state must re-request now.
      sdkReady = !!raw.ok;
      sdkFailedDetail = raw.ok ? null : (raw.detail || 'backend failed to start');
      try {
        if (chatsOverlay && chatsOverlay.classList.contains('open')) {
          renderChatsList(chatsSearch?.value || '');
        }
      } catch {}
      return;
    }
    // Events for a chat this panel is no longer showing, e.g. the tail of a
    // turn after "new chat", must not land in the current conversation.
    if (raw.sessionId && raw.sessionId !== BROWY_SESSION_ID) return;
    // The backend had no record of this chat, so it dropped the message.
    // Until 0.1.13 it said nothing and the panel waited forever. Register
    // again and send the message once more.
    if (raw.type === 'chat.error' && raw.code === 'no_session' && lastChatText && !lastChatResent) {
      lastChatResent = true;
      resendOnReady = lastChatText;
      sessionReady = false;
      startSession();
      return;
    }
    const legacy = browyTranslate(raw);
    if (legacy) handle(legacy);
  });
  bgPort.onDisconnect.addListener(() => {
    sessionReady = false;
    sdkReady = false;
    bgPort = null;
    setLive(false); if (busy) setBusy(false); brand.textContent = 'offline';
    tabTitleText = '—'; currentAction = null; setTtl();
    hideHostUpdateBanner();
    try { setControlsState('offline'); updateTrySuggestions(); } catch {}
    // If the disconnect happened because the extension was just reloaded,
    // chrome.runtime.id will already be undefined → reload immediately.
    if (isExtensionContextInvalidated()) {
      try { location.reload(); } catch {}
      return;
    }
    reconnectAttempts++;
    if (reconnectAttempts >= RELOAD_AFTER_FAILURES) {
      // After RELOAD_AFTER_FAILURES failures, surface a reinstall CTA
      // instead of silently page-reloading. The user almost certainly
      // has a broken host install at this point.
      showConnBanner(`Host unreachable after ${RELOAD_AFTER_FAILURES} retries.`, {
        action: { label: 'Reinstall host →', href: INSTALL_PS1_URL },
      });
      return;
    }
    // With no host, the service worker idles out and drops this port now and
    // then. The first-run screen already explains the situation, so don't
    // flash a reconnect warning on top of it.
    if (!onboardMode) {
      showConnBanner(
        `Host disconnected — reconnecting (${reconnectAttempts}/${RELOAD_AFTER_FAILURES})…`,
        { warn: true }
      );
    }
    // Quick first retry; back off if it keeps failing.
    const delay = reconnectAttempts === 1 ? 500 : Math.min(2000 * reconnectAttempts, 8000);
    setTimeout(connect, delay);
  });
}

// ── Active-tab tracking via chrome.tabs (extension mode) ────────────────────
// In the playwright-driven Electron build the host emitted `focused_tab`
// events. The extension SW knows about tabs natively, so we synthesize the
// same shape from chrome.tabs and feed it to handle().
function brandFromUrl(/* url */) { return 'Browser'; }
async function refreshActiveTab() {
  try {
    // This panel's own window, not whichever window was focused last.
    const windowId = await panelWindowId;
    const [tab] = await chrome.tabs.query(windowId != null
      ? { active: true, windowId }
      : { active: true, lastFocusedWindow: true });
    const allTabs = await chrome.tabs.query({});
    if (!tab) return;
    handle({
      type: 'focused_tab',
      url: tab.url || '',
      title: tab.title || '',
      brand: brandFromUrl(tab.url),
      tabCount: allTabs.length,
    });
  } catch { /* tabs api unavailable from this context */ }
}
try {
  chrome.tabs.onActivated.addListener(refreshActiveTab);
  chrome.tabs.onUpdated.addListener((_id, info) => {
    if (info.url || info.title) refreshActiveTab();
  });
  chrome.tabs.onRemoved.addListener(refreshActiveTab);
  chrome.windows && chrome.windows.onFocusChanged && chrome.windows.onFocusChanged.addListener(refreshActiveTab);
} catch {}

function handle(m) {
  if (m.type === 'focused_tab' && m.url) {
    const wasBrand = lastTab?.brand;
    lastTab = m;
    updateTrySuggestions();
    brand.textContent = (m.brand || '').toLowerCase();
    let host = '';
    try { host = new URL(m.url).hostname.replace(/^www\./, ''); } catch { host = m.url; }
    tabTitleText = m.title || host;
    ttl.title = `${m.title || host}\n${m.url}\n${m.tabCount} tab${m.tabCount === 1 ? '' : 's'}`;
    hostEl.textContent = host;
    tabsEl.textContent = `${m.tabCount || 0} tab${m.tabCount === 1 ? '' : 's'}`;
    setTtl();
    if (!busy) {
      pose(brandPose(m.brand), 700);
      if (wasBrand && wasBrand !== m.brand) react('bounce');
    }
  }
  if (m.type === 'status') {
    if (m.status === 'thinking') { setBusy(true); ensureLiveBubble(); }
    if (m.status === 'idle')     { setBusy(false); currentAction = null; setTtl(); /* finalization deferred to response handler to avoid duplicate bubbles */ }
    if (m.status === 'error')    { setBusy(false); setError(true); finalizeLiveBubble(); endLiveTurn(); currentAction = null; setTtl(); }
  }
  if (m.type === 'delta') {
    appendDelta(m.text);
    clearAuthBannerOnSuccess();
  }
  if (m.type === 'reasoning' && m.text) {
    addReasoning(m.text);
  }
  if (m.type === 'tool_step') {
    if (m.status === 'start' && liveBub && liveText && !liveText.endsWith('\n\n')) {
      // A tool call interrupts the assistant stream. Insert a paragraph
      // break so the post-tool text renders as a new paragraph instead of
      // being glued onto the pre-tool text ("…tool:And check…").
      // BUT: if we're mid-table (last non-empty line contains a pipe), a
      // blank line splits the table in half and the markdown renderer eats
      // partial cells ("Summary" → "y:", "Returns" → "eturns"). In that
      // case skip the break — table rows already separate visually.
      const lastLine = liveText.replace(/\n+$/, '').split('\n').pop() || '';
      const inTable = /\|/.test(lastLine);
      if (!inTable) {
        liveText += '\n\n';
        if (liveBody) liveBody.innerHTML = renderMd(liveText) + '<span class="cursor"></span>';
      }
    }
    renderToolStep(m);
    if (m.status === 'start') {
      const argHint = m.args ? Object.values(m.args).map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(' ').slice(0, 40) : '';
      currentAction = `▸ ${m.name}${argHint ? ' ' + argHint : ''}`;
      setTtl();
      pose('work');                               // enter work state for tool execution
    } else if (m.status === 'end') {
      currentAction = null; setTtl();
      pose('think', 400);                          // brief return-to-think after tool completes
    } else if (m.status === 'error') {
      currentAction = null; setTtl();
      pose('err', 1200); react('shake');
    }
  }
  if (m.type === 'response') {
    // The turn's container, before finalizing lets go of it.
    const turnEl = liveTurn;
    if (m.stopped) {
      markStopped();
      reconcileFinal((m.text ? m.text + '\n\n' : '') + STOPPED_NOTE);
      pose('idle', 400);
      finishLiveTurn(turnEl, { stopped: true });
      return;
    }
    // Final canonical text — reconcile in case streaming missed any chunks
    reconcileFinal(m.text || '');
    react('bounce'); sndRecv();
    pose('happy', 1100);
    finishLiveTurn(turnEl, { stopped: false });
    clearAuthBannerOnSuccess();
  }
  if (m.type === 'queued') {
    // Another window's chat is running. This one starts when it ends.
    ensureLiveBubble();
    if (liveBody && !liveText) {
      liveBody.innerHTML = '<span class="note">Browy is working in another window. This starts as soon as that finishes.</span>';
    }
  }
  if (m.type === 'browsers_status') {
    renderBrowsers(m.browsers || []);
  }
  if (m.type === 'copilot_status') {
    // Auth state is shown ONLY as an inline red error bubble when a real
    // chat fails with an auth code. Probe-driven advisories are ignored.
    if (m._fromError && m.state === 'unauth') {
      addAuthErrorBubble(m.detail);
    }
  }
  // launch_result, active_browsers, models_list, current_model are handled
  // by the dedicated settings window (settings.html) — main UI ignores them.
}

// Auth banner has been removed — auth errors render inline as a red bubble.
function clearAuthBannerOnSuccess() { /* intentionally empty */ }

// ── Browser status chip (read-only — launching lives in settings window) ─
const browsersChip = document.getElementById('browsersChip');
const browsersCount = document.getElementById('browsersCount');
const browsersTotal = document.getElementById('browsersTotal');

function renderBrowsers(list) {
  const installed = list.filter(b => b.installed).length;
  const connected = list.filter(b => b.connected).length;
  browsersCount.textContent = String(connected);
  browsersTotal.textContent = String(installed);
}

// ── Settings window (separate Electron window) ───────────────────
const settingsBtn = document.getElementById('settingsBtn');
settingsBtn?.addEventListener('click', () => {
  if (window.winctl?.openSettings) window.winctl.openSettings();
  else window.open('settings.html', '_blank', 'width=460,height=600');
});

// ── Live assistant bubble (streaming target) ─────────────────────
let liveTurn = null;      // <div class="turn live">: the turn being run
let liveBub = null;       // current assistant <div>
let liveText = '';        // accumulated streamed text
let liveBody = null;      // <div> inside liveBub for markdown text
let liveSteps = null;     // <div class="tool-steps"> inside liveBub
const stepNodes = new Map(); // id -> <div class="tool-step">

/** The container for the turn being run. History renders each turn the
 *  same way, so the finished turn can be swapped for the session's copy. */
function ensureLiveTurn() {
  if (liveTurn && msgs.contains(liveTurn)) return liveTurn;
  empty?.remove();
  liveTurn = document.createElement('div');
  liveTurn.className = 'turn live';
  msgs.appendChild(liveTurn);
  return liveTurn;
}

function ensureLiveBubble() {
  // Idempotent per-part: if any of liveBub/liveBody/liveSteps got nulled
  // out of band (e.g. msgs.innerHTML='' on chat switch, or a stale ref
  // left over from a partial reset), rebuild instead of throwing later.
  if (liveBub && document.contains(liveBub) && liveBody && liveSteps) return;

  empty?.remove();
  // If the previous bubble's DOM is gone (e.g. switchToChat replaced msgs),
  // discard the dangling refs before creating a fresh one.
  if (liveBub && !document.contains(liveBub)) {
    liveBub = null; liveBody = null; liveSteps = null; liveText = '';
  }
  if (!liveBub) {
    const d = document.createElement('div');
    d.className = 'bub a';
    ensureLiveTurn().appendChild(d);
    liveBub = d;
    liveText = '';
  }
  if (!liveSteps) {
    liveSteps = document.createElement('div');
    liveSteps.className = 'tool-steps';
    liveBub.insertBefore(liveSteps, liveBub.firstChild);
  }
  if (!liveBody) {
    liveBody = document.createElement('div');
    liveBody.className = 'body';
    liveBub.appendChild(liveBody);
  }
}

function appendDelta(chunk) {
  ensureLiveBubble();
  liveText += chunk;
  if (liveBody) {
    liveBody.innerHTML = renderMd(liveText) + '<span class="cursor"></span>';
  }
  msgs.scrollTop = msgs.scrollHeight;
}

function reconcileFinal(text) {
  if (!liveBub || !document.contains(liveBub)) {
    if (text) { ensureLiveBubble(); liveText = text; if (liveBody) liveBody.innerHTML = renderMd(text); }
    finalizeLiveBubble();
    return;
  }
  // Canonical text from chat.done is authoritative. Overwrite unconditionally
  // so any mid-stream rendering glitches (broken tables from \n\n inserts,
  // partial code fences, etc.) get replaced by the clean final markdown.
  if (text) {
    liveText = text;
    if (liveBody) liveBody.innerHTML = renderMd(liveText);
  }
  finalizeLiveBubble();
}

function finalizeLiveBubble() {
  if (!liveBub) return;
  // Strip cursor
  if (liveBody) liveBody.innerHTML = renderMd(liveText);

  // If we have a final answer AND at least one tool step, collapse the
  // tool-list into a single summary line that the user can click to expand.
  if (liveSteps && liveSteps.children.length > 0 && liveText.trim().length > 0) {
    collapseToolSteps(liveSteps);
  } else if (liveSteps && liveSteps.children.length === 0) {
    liveSteps.remove();
  }

  liveBub = null; liveBody = null; liveSteps = null; liveText = '';
  stepNodes.clear();
}

/** The turn ended on an error: it stays as it was rendered live. */
function endLiveTurn() {
  if (liveTurn) liveTurn.classList.remove('live');
  liveTurn = null;
}

function resetLive() {
  liveBub = null; liveBody = null; liveSteps = null; liveText = ''; stepNodes.clear();
  liveTurn = null;
}

/** Tool arguments on one short line: the values, in order. Same rules as
 *  shortArgs in src/agent/chat-items.ts, so a live step reads like the copy
 *  the session keeps. */
function summarizeArgs(args) {
  if (args == null) return '';
  const vals = (typeof args === 'object' && !Array.isArray(args) ? Object.values(args) : [args]).map(v => {
    if (typeof v === 'string') return v;
    if (v == null) return '';
    try { return JSON.stringify(v); } catch { return String(v); }
  }).filter(Boolean);
  const s = vals.join(', ').replace(/\s+/g, ' ').trim();
  return s.length > 120 ? s.slice(0, 119) + '…' : s;
}

function summarizeResult(result, status) {
  if (status === 'running') return 'running…';
  if (!result) return status === 'error' ? 'failed' : 'done';
  const oneline = String(result).replace(/\s+/g, ' ').trim();
  if (oneline.length > 120) return oneline.slice(0, 119) + '…';
  return oneline;
}

function fmtDur(ms) {
  const n = Math.max(0, Math.round(Number(ms) || 0));
  if (n < 1000) return n + 'ms';
  if (n < 60_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 's';
  const m = Math.floor(n / 60_000);
  const s = Math.floor((n % 60_000) / 1000);
  return m + 'm' + (s ? ' ' + s + 's' : '');
}

// One tool call, live or from history: { name, args, status, result, durationMs }
// with status 'running' | 'ok' | 'error' | 'stopped'. Click to see the result
// the host kept (up to 600 characters) instead of the one-line preview.
const STEP_CLASS = { running: 'running', ok: 'done', error: 'error', stopped: 'stopped' };
function toolStepNode(t) {
  const node = document.createElement('div');
  node.className = 'tool-step';
  node.innerHTML =
    `<span class="glyph"></span>` +
    `<span class="head"><span class="name"></span><span class="paren">(</span><span class="args"></span><span class="paren">)</span></span>` +
    `<span class="ms"></span>` +
    `<div class="out"><span class="arc"></span><span class="preview"></span></div>`;
  node.querySelector('.name').textContent = t.name || 'tool';
  node.querySelector('.args').textContent = t.args || '';
  node.addEventListener('click', () => {
    node.classList.toggle('expanded');
    showStepPreview(node);
  });
  setToolStepState(node, t);
  return node;
}

function setToolStepState(node, t) {
  for (const c of Object.values(STEP_CLASS)) node.classList.remove(c);
  node.classList.add(STEP_CLASS[t.status] || 'done');
  if (t.durationMs != null) {
    node.dataset.ms = String(t.durationMs);
    node.querySelector('.ms').textContent = fmtDur(t.durationMs);
  }
  node._status = t.status;
  node._result = t.result ? String(t.result) : '';
  showStepPreview(node);
}

function showStepPreview(node) {
  const preview = node.querySelector('.preview');
  if (node._status === 'running') preview.textContent = 'running…';
  else if (node._status === 'stopped') preview.textContent = 'stopped';
  else if (node.classList.contains('expanded') && node._result) preview.textContent = node._result;
  else preview.textContent = summarizeResult(node._result, node._status === 'error' ? 'error' : 'done');
}

/** Fold a turn's tool calls into one "used N tools" line, as at the end of a turn. */
function collapseToolSteps(wrap, extra = 0) {
  const nodes = wrap.querySelectorAll('.tool-step');
  const n = nodes.length + extra;
  let totalMs = 0;
  nodes.forEach((el) => { totalMs += Number(el.dataset.ms) || 0; });
  const summary = document.createElement('div');
  summary.className = 'tools-summary';
  summary.innerHTML = `<span class="glyph"></span><span class="arrow"></span><span class="lbl"></span>`;
  summary.querySelector('.lbl').textContent = `used ${n} tool${n === 1 ? '' : 's'}` + (totalMs ? ` · ${fmtDur(totalMs)}` : '');
  summary.addEventListener('click', () => wrap.classList.toggle('expanded-back'));
  wrap.appendChild(summary);
  wrap.classList.add('collapsed');
}

// After Stop, calls still marked running will never report back.
function markStopped() {
  if (!liveSteps) return;
  liveSteps.querySelectorAll('.tool-step.running').forEach((node) => {
    setToolStepState(node, { status: 'stopped' });
  });
}

function renderToolStep(m) {
  ensureLiveBubble();
  let node = stepNodes.get(m.id);
  if (!node) {
    node = toolStepNode({ name: m.name, args: summarizeArgs(m.args), status: 'running' });
    liveSteps.appendChild(node);
    stepNodes.set(m.id, node);
  }
  if (m.status === 'end' || m.status === 'error') {
    setToolStepState(node, { status: m.status === 'end' ? 'ok' : 'error', result: m.result, durationMs: m.durationMs });
  }
  msgs.scrollTop = msgs.scrollHeight;
}

function addReasoning(text) {
  ensureLiveBubble();
  if (!liveBub) return;
  let r = liveBub.querySelector('.reasoning');
  if (!r) {
    r = document.createElement('div');
    r.className = 'reasoning';
    // Insert before body, after steps
    if (liveBody) liveBub.insertBefore(r, liveBody);
    else liveBub.appendChild(r);
  }
  r.textContent = text;
}

// ── Chat history: rendered from the Copilot session ──────────────────────
// The host reads the chat's session and sends items (src/agent/chat-items.ts):
//   { kind: 'turn', turn, ts?, end?: 'stopped' | 'error', error?, clipped? }
//   { kind: 'user', turn, text }        what the user typed, no page context
//   { kind: 'assistant', turn, text }   one message from the model
//   { kind: 'tool', turn, id, name, args, status, result?, durationMs? }
// Live turns render the same way, and when one finishes it is swapped for the
// session's copy of that turn. Long chats come a page of turns at a time.
const STOPPED_NOTE = '_Stopped. Send a message to pick up where it left off._';
const SAVED_NOTE = "// saved copy. browy no longer has this chat's session, so it's read-only. sending a message starts a new chat.";
const CONFLICT_NOTE = '// this chat is open in another window, so messages sent here start a new chat.';
let HISTORY_PAGE_TURNS = 10;
const VIEW_CACHE_MAX = 40;
const VIEW_CACHE_BYTES = 48_000;

// What the chat area shows.
//   mode: 'empty'   new chat
//         'loading' skeleton until the session answers
//         'cached'  this panel's last view (or a 0.1.13 HTML copy), until the session answers
//         'session' rendered from the session
//         'saved'   read-only: the session has no event log, the copy is all there is
//         'failed'  the session didn't answer
let view = newView(null, 'empty');
let loadToken = 0;

function newView(id, mode, paged = null) {
  return { id, mode, start: 0, total: null, items: [], older: [], paged, needsLoad: false, loading: false, legacyHtml: null };
}

function userBubble(text) {
  const d = document.createElement('div');
  d.className = 'bub u';
  d.textContent = text;
  return d;
}

/** Items in order → turns: { turn, head, user, texts, tools }. */
function groupTurns(items) {
  const turns = [];
  let cur = null;
  for (const it of items || []) {
    if (!it || typeof it !== 'object') continue;
    if (!cur || it.turn !== cur.turn) {
      cur = { turn: it.turn, head: null, user: null, texts: [], tools: [] };
      turns.push(cur);
    }
    if (it.kind === 'turn') cur.head = it;
    else if (it.kind === 'user') cur.user = it;
    else if (it.kind === 'assistant') cur.texts.push(it.text || '');
    else if (it.kind === 'tool') cur.tools.push(it);
  }
  return turns;
}

/** One turn, as a live turn ends up: the user's bubble, then Browy's with
 *  the tool calls folded above the reply. */
function renderTurn(t) {
  const wrap = document.createElement('div');
  wrap.className = 'turn';
  wrap.dataset.turn = String(t.turn);
  if (t.user) wrap.appendChild(userBubble(t.user.text));
  let text = t.texts.filter((s) => s.trim()).join('\n\n');
  if (t.head?.end === 'stopped') text = (text ? text + '\n\n' : '') + STOPPED_NOTE;
  const clipped = Number(t.head?.clipped) || 0;
  const failed = t.head?.end === 'error' ? (t.head.error || 'this turn ended on an error') : '';
  if (!text && !t.tools.length && !clipped && !failed) return wrap;
  const bub = document.createElement('div');
  bub.className = 'bub a';
  if (t.tools.length || clipped) {
    const steps = document.createElement('div');
    steps.className = 'tool-steps';
    if (clipped) {
      const note = document.createElement('div');
      note.className = 'steps-clipped';
      note.textContent = `${clipped} earlier step${clipped === 1 ? '' : 's'} not shown`;
      steps.appendChild(note);
    }
    for (const tool of t.tools) steps.appendChild(toolStepNode(tool));
    if (text) collapseToolSteps(steps, clipped);
    bub.appendChild(steps);
  }
  const body = document.createElement('div');
  body.className = 'body';
  body.innerHTML = renderMd(text);
  if (failed) {
    const note = document.createElement('div');
    note.className = 'note err';
    note.textContent = '⚠ ' + failed;
    body.appendChild(note);
  }
  bub.appendChild(body);
  wrap.appendChild(bub);
  return wrap;
}

function renderTurns(items) {
  const frag = document.createDocumentFragment();
  for (const t of groupTurns(items)) frag.appendChild(renderTurn(t));
  return frag;
}

function firstUserText(items) {
  return (items || []).find((it) => it.kind === 'user')?.text || '';
}

function setChatTitle(text) {
  if (!modeTag) return;
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  modeTag.textContent = '// ' + (t ? t.slice(0, 60) : 'browser agent');
}

/** The chat's title: its summary from the chats list, else its first message shown. */
function chatTitle(id, items) {
  const c = (chatsCache || []).find((x) => x.id === id);
  return (c?.summary && c.summary !== '(no summary)' ? c.summary : '') || firstUserText(items);
}

// The bar at the top of the chat: loading, errors, the saved-copy label and
// "load earlier". opts: { kind: 'loading' | 'error' | 'saved' | 'note', note, retry, earlier }
function histBar() {
  let bar = document.getElementById('histTop');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'histTop';
    bar.className = 'hist-top';
  }
  if (msgs.firstChild !== bar) msgs.insertBefore(bar, msgs.firstChild);
  return bar;
}

function setHistBar(opts) {
  const bar = histBar();
  bar.className = 'hist-top' + (opts?.kind ? ' ' + opts.kind : '');
  bar.innerHTML = '';
  if (!opts) return;
  if (opts.earlier > 0) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'load-earlier';
    b.textContent = `↑ load earlier · ${opts.earlier} more turn${opts.earlier === 1 ? '' : 's'}`;
    b.addEventListener('click', () => loadEarlier());
    bar.appendChild(b);
  }
  if (opts.note) {
    const n = document.createElement('span');
    n.className = 'hist-note';
    if (opts.kind === 'loading') {
      const s = document.createElement('span');
      s.className = 'spin';
      s.setAttribute('aria-hidden', 'true');
      n.appendChild(s);
    }
    n.appendChild(document.createTextNode(opts.note));
    bar.appendChild(n);
  }
  if (opts.retry) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'retry';
    b.addEventListener('click', () => opts.retry());
    bar.appendChild(b);
  }
}

/** The bar's resting state: "load earlier" when there is more, else nothing. */
function settleHistBar() {
  if (view.mode === 'saved') setHistBar({ kind: 'saved', note: SAVED_NOTE });
  else if (view.conflict) setHistBar({ kind: 'note', note: CONFLICT_NOTE, earlier: view.start });
  else setHistBar(view.start > 0 ? { earlier: view.start } : null);
}

/** Replace the chat area with these turns. Turns run in this panel that the
 *  page doesn't have yet (the live one, or one newer than `total`) stay at
 *  the end. */
function paintTurns(items, total) {
  const keep = [...msgs.querySelectorAll('.turn')].filter((el) =>
    el === liveTurn || (el.dataset.ran === '1' && Number(el.dataset.turn) >= (total ?? Infinity)));
  msgs.innerHTML = '';
  histBar();
  if (items && items.length) msgs.appendChild(renderTurns(items));
  else if (!keep.length) msgs.appendChild(empty);
  for (const el of keep) msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
}

function paintEmpty() {
  msgs.innerHTML = '';
  msgs.appendChild(empty);
}

/** A 0.1.13 HTML copy. Its click handlers didn't survive storage. */
function paintLegacy(html) {
  msgs.innerHTML = html;
  msgs.querySelectorAll('.cursor').forEach((n) => n.remove());
  msgs.querySelectorAll('.tool-step').forEach((n) => n.addEventListener('click', () => n.classList.toggle('expanded')));
  msgs.querySelectorAll('.tools-summary').forEach((s) => s.addEventListener('click', () => s.parentElement?.classList.toggle('expanded-back')));
  histBar();
  msgs.scrollTop = msgs.scrollHeight;
}

function paintSkeleton() {
  msgs.innerHTML = '';
  histBar();
  for (let i = 0; i < 2; i++) {
    const u = document.createElement('div');
    u.className = 'skel-bub u';
    u.innerHTML = '<i></i>';
    const a = document.createElement('div');
    a.className = 'skel-bub a';
    a.innerHTML = '<i></i><i></i><i></i>';
    msgs.appendChild(u);
    msgs.appendChild(a);
  }
}

function paintFailed(id) {
  msgs.innerHTML = '';
  histBar();
  const box = document.createElement('div');
  box.className = 'hist-fail';
  const t = document.createElement('div');
  t.textContent = "// couldn't load this chat. it's safe on disk.";
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chats-retry';
  b.textContent = 'retry';
  b.addEventListener('click', () => { if (view.id === id) { view.mode = 'loading'; paintSkeleton(); loadChat(id); } });
  box.appendChild(t);
  box.appendChild(b);
  msgs.appendChild(box);
}

// ── the small per-chat view cache ──
async function loadView(id) {
  try {
    const r = await chrome.storage.local.get([VIEW_PREFIX + id]);
    const v = r?.[VIEW_PREFIX + id];
    if (v && Array.isArray(v.items) && v.items.length) return v;
  } catch {}
  return null;
}

/** The newest turns on screen, trimmed to a few dozen KB. */
function compactView(items) {
  const turns = [];
  for (const it of items || []) {
    const last = turns[turns.length - 1];
    if (last && last[0].turn === it.turn) last.push(it); else turns.push([it]);
  }
  const out = [];
  let size = 0;
  for (let i = turns.length - 1; i >= 0 && out.length < 4; i--) {
    let t = turns[i].map((it) => {
      if (it.kind === 'tool' && it.result && it.result.length > 160) return { ...it, result: it.result.slice(0, 159) + '…' };
      if (it.kind === 'assistant' && it.text.length > 8000) return { ...it, text: it.text.slice(0, 7999) + '…' };
      return it;
    });
    const tools = t.filter((it) => it.kind === 'tool');
    if (tools.length > 60) {
      const drop = new Set(tools.slice(0, tools.length - 60));
      t = t.filter((it) => !drop.has(it)).map((it) => (it.kind === 'turn' ? { ...it, clipped: (Number(it.clipped) || 0) + drop.size } : it));
    }
    const n = JSON.stringify(t).length;
    if (out.length && size + n > VIEW_CACHE_BYTES) break;
    out.unshift(t);
    size += n;
  }
  return out.flat();
}

let viewSaveTimer = null;
function saveViewSoon() {
  clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(saveView, 300);
}

async function saveView() {
  const id = view.id;
  if (!id || id !== BROWY_SESSION_ID || view.mode !== 'session' || !view.items.length) return;
  const items = compactView(view.items);
  const first = items.find((it) => it.kind === 'turn');
  const title = chatTitle(id, view.items);
  const at = Date.now();
  const entry = { v: 1, items, start: first ? first.turn : 0, total: view.total, title, at };
  try {
    // A chat whose session is gone keeps its view however old: it is the
    // only copy left.
    const idx = [{ id, title, at }, ...(await loadViewIndex()).filter((x) => x.id !== id)];
    const keep = idx.filter((x, i) => i < VIEW_CACHE_MAX || x.gone);
    const evict = idx.filter((x) => !keep.includes(x)).map((x) => x.id);
    await chrome.storage.local.set({ [VIEW_PREFIX + id]: entry, [VIEW_INDEX_KEY]: keep });
    if (evict.length) await chrome.storage.local.remove(evict.map((x) => VIEW_PREFIX + x));
  } catch {}
}

/** Remember that these chats' sessions are gone, so their views are kept. */
async function markViewsGone(ids) {
  try {
    const idx = await loadViewIndex();
    let changed = false;
    for (const x of idx) if (ids.has(x.id) && !x.gone) { x.gone = true; changed = true; }
    if (changed) await chrome.storage.local.set({ [VIEW_INDEX_KEY]: idx });
  } catch {}
}

/** First paint of chat `id`, before the session answers: this panel's last
 *  view of it, else its 0.1.13 HTML copy, else a skeleton if it has history. */
async function paintFromCache(id) {
  view = newView(id, 'empty', view.paged);
  const cached = await loadView(id);
  if (view.id !== id) return;
  if (cached) {
    view.mode = 'cached';
    view.items = cached.items;
    view.start = Number(cached.start) || 0;
    view.total = Number.isFinite(cached.total) ? cached.total : null;
    paintTurns(cached.items);
    setChatTitle(cached.title || firstUserText(cached.items));
    return;
  }
  const html = await loadLegacyChatHtml(id);
  if (view.id !== id) return;
  if (html) {
    view.mode = 'cached';
    view.legacyHtml = html;
    paintLegacy(html);
    setChatTitle(deriveChatTitle(html));
    return;
  }
  if (await chatHasHistory(id)) {
    if (view.id !== id) return;
    view.mode = 'loading';
    paintSkeleton();
    setChatTitle(chatTitle(id, []));
    return;
  }
  paintEmpty();
  setChatTitle('');
}

async function chatHasHistory(id) {
  if (chatsCache) return chatsCache.some((c) => c.id === id);
  const c = await loadListCache();
  return !!c && c.chats.some((x) => x.id === id);
}

/** Older hosts send the whole transcript as { role, ... } messages. */
function legacyToItems(messages) {
  const items = [];
  let turn = -1;
  const open = () => { turn++; items.push({ kind: 'turn', turn }); };
  for (const m of messages || []) {
    if (!m) continue;
    if (m.role === 'user') { open(); items.push({ kind: 'user', turn, text: String(m.text || '') }); continue; }
    if (turn < 0) open();
    if (m.role === 'assistant') items.push({ kind: 'assistant', turn, text: String(m.text || '') });
    else if (m.role === 'tool') items.push({ kind: 'tool', turn, id: '', name: m.name || 'tool', args: '', status: m.ok === false ? 'error' : 'ok', result: m.summary || '' });
  }
  return items;
}

/** Render chat `id` from its session: the newest page of turns. */
async function loadChat(id) {
  const token = ++loadToken;
  view.loading = true;
  view.needsLoad = false;
  if (view.mode === 'cached') setHistBar({ kind: 'loading', note: 'syncing with the backend…' });
  else if (view.mode === 'loading') setHistBar({ kind: 'loading', note: 'loading this chat…' });
  const deadline = Date.now() + rpcTimeout(HISTORY_TIMEOUT_MS);
  // Wait until the host has this panel's session, so the reply is routed here.
  await waitRoute(BROWY_SESSION_ID, Math.max(0, deadline - Date.now()));
  if (token !== loadToken) return;
  const r = await hostRpc('history', { type: 'chat.history', id, items: true, limit: HISTORY_PAGE_TURNS },
    { timeoutMs: Math.max(5000, deadline - Date.now()) });
  if (token !== loadToken || r.stale) return;
  view.loading = false;
  const msg = r.msg;
  if (!msg || msg.error) return historyFailed(id);
  let items, start, total;
  if (Array.isArray(msg.items)) {
    view.paged = true;
    if (msg.missing) return historyMissing(id);
    items = msg.items;
    start = Number(msg.start) || 0;
    total = Number(msg.total) || 0;
  } else {
    view.paged = false;
    const all = legacyToItems(msg.messages);
    // An older host says nothing about a missing session. Keep showing the
    // 0.1.13 copy as before, and let the chat carry on.
    if (!all.length) {
      if (view.mode === 'cached' || view.mode === 'saved') { settleHistBar(); return; }
      return historyMissing(id);
    }
    const turns = groupTurns(all);
    total = turns.length;
    start = Math.max(0, total - HISTORY_PAGE_TURNS);
    view.older = all.filter((it) => it.turn < start);
    items = all.filter((it) => it.turn >= start);
  }
  if (!items.length) return historyMissing(id);
  view.mode = 'session';
  view.items = items;
  view.start = start;
  view.total = total;
  view.legacyHtml = null;
  paintTurns(items, total);
  settleHistBar();
  setChatTitle(chatTitle(id, items));
  saveViewSoon();
}

/** The session has no event log: a new chat, or one older than events.jsonl. */
async function historyMissing(id) {
  // A turn has run here since the request went out, so the session exists now.
  if (msgs.querySelector('.turn.live, .turn[data-ran="1"]')) {
    if (view.mode !== 'saved') view.mode = 'session';
    view.total = null;
    settleHistBar();
    return;
  }
  const html = view.legacyHtml || await loadLegacyChatHtml(id);
  if (view.id !== id) return;
  view.total = 0;
  if (html) {
    if (view.legacyHtml !== html || view.mode !== 'cached') paintLegacy(html);
    view.legacyHtml = html;
    view.mode = 'saved';
    setChatTitle(deriveChatTitle(html));
  } else if (view.mode === 'cached' && view.items.length) {
    // Deleted or pruned since this panel last showed it: its view is the copy.
    view.mode = 'saved';
    markViewsGone(new Set([id]));
  } else {
    view.mode = 'empty';
    view.items = [];
    if (!(liveTurn && msgs.contains(liveTurn))) paintEmpty();
    setChatTitle('');
    return;
  }
  settleHistBar();
  if (inp && !inp.disabled) inp.placeholder = 'read-only copy. sending starts a new chat';
}

function historyFailed(id) {
  if (view.id !== id) return;
  view.loading = false;
  // The next session.ready tries again by itself.
  view.needsLoad = true;
  const retry = () => { if (view.id === id) loadChat(id); };
  if (view.mode === 'empty' && !msgs.querySelector('.turn')) {
    // A new chat has nothing to load; the next session.ready checks again.
  } else if (view.mode === 'loading' && !msgs.querySelector('.turn')) {
    view.mode = 'failed';
    paintFailed(id);
  } else if (view.mode === 'cached' || view.mode === 'saved') {
    setHistBar({ kind: 'error', note: "couldn't reach the backend, so this is the copy this panel saved.", retry });
  } else {
    setHistBar({ kind: 'error', note: "couldn't load this chat's history.", retry });
  }
}

async function loadEarlier() {
  if (view.loadingEarlier || view.start <= 0) return;
  const id = view.id;
  const token = loadToken;
  const keep = msgs.scrollHeight - msgs.scrollTop;
  const prepend = (items) => {
    const bar = histBar();
    bar.after(renderTurns(items));
    msgs.scrollTop = msgs.scrollHeight - keep;
  };
  if (view.paged === false) {
    // An older host sent everything already.
    const from = Math.max(0, view.start - HISTORY_PAGE_TURNS);
    const items = view.older.filter((it) => it.turn >= from);
    view.older = view.older.filter((it) => it.turn < from);
    prepend(items);
    view.start = from;
    view.items = items.concat(view.items);
    settleHistBar();
    return;
  }
  view.loadingEarlier = true;
  setHistBar({ kind: 'loading', note: 'loading earlier turns…' });
  const r = await hostRpc('history', { type: 'chat.history', id, items: true, limit: HISTORY_PAGE_TURNS, before: view.start },
    { timeoutMs: rpcTimeout(HISTORY_TIMEOUT_MS) });
  view.loadingEarlier = false;
  if (token !== loadToken || view.id !== id || r.stale) return;
  const msg = r.msg;
  if (!msg || msg.error || !Array.isArray(msg.items) || msg.missing) {
    setHistBar({ kind: 'error', note: "couldn't load earlier turns.", retry: loadEarlier, earlier: view.start });
    return;
  }
  prepend(msg.items);
  view.start = Number(msg.start) || 0;
  view.items = msg.items.concat(view.items);
  settleHistBar();
}

/** A live turn ended: swap it for the session's copy of the same turn, so
 *  what the panel shows is always what the session holds. */
function finishLiveTurn(turnEl, { stopped }) {
  liveTurn = null;
  if (!turnEl) return;
  turnEl.classList.remove('live');
  const text = turnEl.dataset.text || '';
  const id = BROWY_SESSION_ID;
  // Stop answers at once; the runtime records the abort a moment later.
  setTimeout(() => rerenderTurn(turnEl, { id, text, stopped }), stopped ? 1500 : 0);
}

const normText = (s) => String(s || '').replace(/\s+/g, ' ').trim();

async function rerenderTurn(turnEl, { id, text, stopped }) {
  // An older host has no pages; the live render stays.
  if (view.paged === false || !text) return;
  if (id !== BROWY_SESSION_ID || view.id !== id || !msgs.contains(turnEl)) return;
  const token = loadToken;
  const r = await hostRpc('history', { type: 'chat.history', id, items: true, limit: 1 }, { timeoutMs: rpcTimeout(HISTORY_TIMEOUT_MS) });
  if (token !== loadToken || r.stale || !msgs.contains(turnEl)) return;
  const msg = r.msg;
  if (!msg || msg.error || msg.missing) return;
  if (!Array.isArray(msg.items)) { view.paged = false; return; }
  view.paged = true;
  const t = groupTurns(msg.items).pop();
  // Only this very turn: the session's newest, with the text that was sent.
  if (!t || !t.user || normText(t.user.text) !== normText(text)) return;
  const expected = view.total == null ? null : view.total + 1;
  view.total = Number(msg.total) || view.total;
  if (expected != null && msg.total !== expected) return;
  if (stopped && t.head && !t.head.end) t.head.end = 'stopped';
  const fresh = renderTurn(t);
  fresh.dataset.ran = '1';
  turnEl.replaceWith(fresh);
  view.items = view.items.filter((it) => it.turn !== t.turn).concat(msg.items);
  if (view.mode === 'empty' || view.mode === 'cached') { view.mode = 'session'; settleHistBar(); }
  saveViewSoon();
}

/** session.ready: a chat painted from cache, or that failed to load, loads now. */
function onHistorySessionReady() {
  if (view.needsLoad && !view.loading && view.id && view.id === BROWY_SESSION_ID) loadChat(view.id);
}

/** Another window has this chat open, so this panel moves to a new session. */
function onHistoryConflict() {
  view.total = null;
  view.conflict = true;
  if (!view.loading) settleHistBar();
}

// ── Bubbles ─────────────────────────────────────────────────────
function addBub(role, text) {
  empty?.remove();
  const d = document.createElement('div');
  d.className = 'bub ' + role;
  msgs.appendChild(d);
  if (role === 'u') {
    d.textContent = text;
  } else {
    d.innerHTML = renderMd(text);
  }
  msgs.scrollTop = msgs.scrollHeight;
  return d;
}

// Auth-error bubble with an inline "Sign in" CTA. Clicking the button
// triggers auth.signin → native host opens a terminal running the
// `copilot` CLI device flow. After the user completes sign-in, the next
// chat send works and clearAuthBannerOnSuccess fires.
function addAuthErrorBubble(detail) {
  const d = addBub('a err', `⚠ ${detail || 'GitHub Copilot needs sign-in to chat.'}`);
  if (!d) return;
  const row = document.createElement('div');
  row.style.cssText = 'margin-top:8px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Sign in to GitHub Copilot';
  btn.style.cssText = 'background:var(--accent,#4ade80); color:#0a1f12; border:none; border-radius:4px; padding:6px 12px; font-family:inherit; font-size:12px; font-weight:600; cursor:pointer; text-transform:uppercase; letter-spacing:0.04em;';
  btn.addEventListener('click', () => {
    browyPost({ type: 'auth.signin' });
    btn.disabled = true;
    btn.textContent = 'Opening sign-in terminal…';
    btn.style.opacity = '0.6';
    btn.style.cursor = 'default';
    const hint = document.createElement('span');
    hint.textContent = 'Complete sign-in there, then send your message again.';
    hint.style.cssText = 'font-size:11px; opacity:0.75;';
    row.appendChild(hint);
  });
  row.appendChild(btn);
  d.appendChild(row);
  msgs.scrollTop = msgs.scrollHeight;
}

// ── Input ───────────────────────────────────────────────────────
function send() {
  const t = inp.value.trim();
  if (!t || busy || !ws || ws.readyState !== 1) return;
  // A read-only saved copy can't carry on: the message starts a new chat.
  if (view.mode === 'saved') {
    inp.value = ''; autoSize();
    startNewChat().then(() => { inp.value = t; send(); });
    return;
  }
  ws.send(JSON.stringify({ type: 'chat', text: t }));
  // Placeholders for a chat still loading make way for the message.
  msgs.querySelectorAll('.skel-bub, .hist-fail').forEach((n) => n.remove());
  endLiveTurn();
  const turn = ensureLiveTurn();
  turn.dataset.text = t;
  turn.appendChild(userBubble(t));
  msgs.scrollTop = msgs.scrollHeight;
  markFirstSendDone();
  inp.value = ''; autoSize();
  goBtn.disabled = true;
  setBusy(true);
  react('nod'); sndSend();
  // Queued while the host cold-starts — make the wait explicit rather than
  // leaving an indefinite "thinking" state with nothing happening.
  if (!sessionReady) {
    try {
      showConnBanner('Backend still starting — your message will send automatically.', { warn: true });
    } catch {}
  }
}
function stop() {
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'stop' }));
  // The backend confirms a Stop within a second or two, and frees a stuck
  // turn itself after three. Silence for ten means the backend itself is
  // wedged: restart it rather than leave the panel stuck until the extension
  // is reloaded, which was the only way out before 0.1.13.
  clearTimeout(stopWatch);
  stopWatch = setTimeout(() => {
    stopWatch = null;
    if (!busy) return;
    restartingHost = true;
    browyPost({ type: '__restart_host' });
    markStopped();
    setBusy(false);
    finalizeLiveBubble();
    try { showConnBanner("Browy's backend stopped answering, so it's restarting. Send your message again in a few seconds.", { warn: true }); } catch {}
  }, 10_000);
}

// Start a brand new chat. The current chat stays in its Copilot session and
// shows up under "chats" in the history overlay. The new id gets its own
// session on disk with the first message.
async function startNewChat() {
  // Tell the host to forget the active SDK handle WITHOUT deleting it on disk
  // (so the previous chat is preserved in the chats overlay). The new SID's
  // SDK session is created lazily on the next chat.send via
  // setBrowyProtocolSessionId → ensureSession on the host.
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'stop' }));
  // End the outgoing session properly. Without this the runner keeps its
  // SessionState and ExtensionContext alive for every chat ever opened in this
  // panel, and the background's sessionToClient map grows one dead entry per
  // new chat, all cleaned up only when the panel finally closes.
  const previousId = BROWY_SESSION_ID;
  // Mint a new SID and rebind.
  BROWY_SESSION_ID = newSessionId();
  loadToken++;
  dropPendingRpcs();
  if (previousId && previousId !== BROWY_SESSION_ID) {
    browyPost({ type: 'session.end', sessionId: previousId });
  }
  try { await chrome.storage.local.set({ [SID_KEY]: BROWY_SESSION_ID }); } catch {}
  resetLive();
  view = newView(BROWY_SESSION_ID, 'empty', view.paged);
  view.total = 0;
  paintEmpty();
  // The old chat's last events are filtered out once the id changes, so its
  // idle never arrives here. The new chat starts free.
  if (busy) setBusy(false);
  setChatTitle('');
  try { setControlsState(hostState); } catch {}
  // Tell the host to start the new session.
  startSession();
}

// Open a chat from the history overlay. Its Copilot session is the record:
// the panel paints its last view of the chat at once (or a skeleton), then
// renders the session's newest turns.
async function switchToChat(id) {
  if (!id || id === BROWY_SESSION_ID) { closeChatsOverlay(); return; }
  // Stop whatever the outgoing chat was doing; the new one resumes on demand.
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'stop' }));
  const previousId = BROWY_SESSION_ID;
  BROWY_SESSION_ID = id;
  loadToken++;
  dropPendingRpcs();
  if (previousId && previousId !== id) {
    browyPost({ type: 'session.end', sessionId: previousId });
  }
  try { await chrome.storage.local.set({ [SID_KEY]: id }); } catch {}
  resetLive();
  if (busy) setBusy(false);
  try { setControlsState(hostState); } catch {}
  closeChatsOverlay();
  await paintFromCache(id);
  if (BROWY_SESSION_ID !== id) return;
  // Register the chat with the host first, so the history reply is routed
  // to this panel and the chat is ready to resume.
  startSession();
  loadChat(id);
}

// ── Chats overlay ───────────────────────────────────────────────────────
// Opens at once with the last list this panel saw (kept in storage), then
// refreshes from the host with a spinner in the header. The host's first
// reply lists Browy's own chats by id within a few hundred ms; a second adds
// old chats only a full scan of every session finds.
//
// A chat whose session is gone (it predates events.jsonl, or the host
// pruned or lost it) stays listed as a read-only saved copy for as long as
// the panel has a copy of it: 0.1.13's HTML copy, or the panel's own view
// of it. It is never dropped from the list automatically; only deleting it
// removes it.
let chatsCache = null;        // [{ id, summary, startTime, modifiedTime }]
let chatsComplete = false;    // chatsCache includes the full scan
let chatsState = 'idle';      // 'idle' | 'loading' | 'connecting' | 'failed'
let chatsLoad = null;
let savedCopies = null;       // [{ id, title, updated }]: chats with a local copy
/** Saved copies a complete list has shown to be gone. Kept while a later
 *  refresh is still partial, so they don't blink out of the list. */
const goneIds = new Set();
const chatsSync = document.getElementById('chatsSync');

async function loadListCache() {
  try {
    const r = await chrome.storage.local.get([LIST_CACHE_KEY]);
    const c = r?.[LIST_CACHE_KEY];
    if (c && Array.isArray(c.chats)) return c;
  } catch {}
  return null;
}

function saveListCache(chats) {
  const slim = chats.map((c) => ({ id: c.id, summary: c.summary, startTime: c.startTime, modifiedTime: c.modifiedTime }));
  chrome.storage.local.set({ [LIST_CACHE_KEY]: { at: Date.now(), chats: slim } }).catch(() => {});
}

/** Every chat the panel has a copy of: 0.1.13's HTML copies (its index and
 *  metadata) and the panel's own cached views. */
async function loadSavedCopies() {
  try {
    const idx = await loadChatIndex();
    const r = idx.length ? await chrome.storage.local.get(idx.map((id) => META_PREFIX + id)) : {};
    const out = new Map();
    for (const id of idx) {
      const m = r?.[META_PREFIX + id] || {};
      out.set(id, { id, title: m.title || '', updated: Number(m.updated) || 0 });
    }
    for (const v of await loadViewIndex()) {
      if (!out.has(v.id)) out.set(v.id, { id: v.id, title: v.title || '', updated: Number(v.at) || 0 });
    }
    return [...out.values()];
  } catch { return []; }
}

/** After a complete list: which saved copies have no session any more. */
function noteGoneChats() {
  if (!chatsComplete || !chatsCache || !savedCopies) return;
  const listed = new Set(chatsCache.map((c) => c.id));
  goneIds.clear();
  for (const s of savedCopies) if (!listed.has(s.id)) goneIds.add(s.id);
  if (goneIds.size) markViewsGone(goneIds);
}

async function openChatsOverlay() {
  chatsOverlay.classList.add('open');
  chatsOverlay.setAttribute('aria-hidden', 'false');
  setTimeout(() => chatsSearch?.focus(), 50);
  // Ask the host at once; the rows fill in from whatever arrives first.
  refreshChatList();
  renderChatRows();
  if (!chatsCache) {
    const c = await loadListCache();
    if (c && !chatsCache) { chatsCache = c.chats; chatsComplete = true; }
  }
  // Read again each time: another window may have deleted one.
  savedCopies = await loadSavedCopies();
  noteGoneChats();
  renderChatRows();
}

function closeChatsOverlay() {
  chatsOverlay.classList.remove('open');
  chatsOverlay.setAttribute('aria-hidden', 'true');
  if (chatsSearch) chatsSearch.value = '';
}

/** Ask the host for the list; the rows update as replies come in. */
function refreshChatList() {
  if (chatsLoad) return chatsLoad;
  if (!sessionReady) {
    // session.ready calls renderChatsList, which asks again.
    chatsState = 'connecting';
    renderChatRows();
    return null;
  }
  if (sdkFailedDetail) {
    // Copilot didn't start, so the host has nothing to list: keep what we have.
    chatsState = 'failed';
    renderChatRows();
    return null;
  }
  chatsState = 'loading';
  renderChatRows();
  chatsLoad = (async () => {
    const r = await hostRpc('list', { type: 'chat.list', progressive: true }, {
      timeoutMs: rpcTimeout(LIST_TIMEOUT_MS),
      onPartial: (msg) => {
        chatsCache = Array.isArray(msg.chats) ? msg.chats : chatsCache;
        chatsComplete = false;
        renderChatRows();
      },
    });
    chatsLoad = null;
    if (r.stale) { chatsState = 'idle'; return; }
    const msg = r.msg;
    if (!msg || msg.error || !Array.isArray(msg.chats)) {
      chatsState = 'failed';
      renderChatRows();
      return;
    }
    chatsCache = msg.chats;
    chatsComplete = msg.complete !== false;
    chatsState = 'idle';
    saveListCache(msg.chats);
    noteGoneChats();
    renderChatRows();
  })();
  return chatsLoad;
}

// Called when the backend comes up (session.ready, sdk.ready) while the
// overlay may be open: show what we have and ask again.
function renderChatsList() {
  renderChatRows();
  if (chatsOverlay.classList.contains('open')) refreshChatList();
}

/** Label for a chat the SDK never recorded a summary for. A date beats
 *  eight identical rows all reading "Untitled chat". */
function describeUndatedChat(ts) {
  if (!ts) return 'Untitled chat';
  try {
    const d = new Date(ts);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    return sameDay
      ? 'Chat at ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : 'Chat from ' + d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  } catch { return 'Untitled chat'; }
}
function fmtRelTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h ago';
  if (diff < 7 * 86_400_000) return Math.floor(diff / 86_400_000) + 'd ago';
  return new Date(ts).toLocaleDateString();
}

/** The header's status: a spinner while loading, a retry when it failed. */
function renderChatsSync() {
  if (!chatsSync) return;
  chatsSync.className = 'chats-sync';
  chatsSync.innerHTML = '';
  let text = '';
  if (chatsState === 'connecting') text = 'connecting';
  else if (chatsState === 'loading') text = !sdkReady ? 'backend starting' : chatsCache ? 'refreshing' : 'loading';
  else if (chatsState === 'failed') text = chatsCache ? "couldn't refresh" : '';
  if (!text) return;
  chatsSync.classList.add('show');
  if (chatsState === 'failed') {
    chatsSync.classList.add('err');
    chatsSync.appendChild(document.createTextNode(text + ' · '));
    const a = document.createElement('a');
    a.textContent = 'retry';
    a.addEventListener('click', () => refreshChatList());
    chatsSync.appendChild(a);
    return;
  }
  const s = document.createElement('span');
  s.className = 'spin';
  s.setAttribute('aria-hidden', 'true');
  chatsSync.appendChild(s);
  chatsSync.appendChild(document.createTextNode(text));
}

function chatsNotice(text, withRetry) {
  chatsList.innerHTML = '';
  const emp = document.createElement('div');
  emp.className = 'chats-empty';
  emp.textContent = text;
  chatsList.appendChild(emp);
  if (withRetry) {
    const btn = document.createElement('button');
    btn.className = 'chats-retry';
    btn.textContent = 'retry';
    btn.addEventListener('click', () => refreshChatList());
    chatsList.appendChild(btn);
  }
}

function renderChatRows() {
  renderChatsSync();
  if (!chatsCache) {
    // Nothing to show yet. Never render that as "no chats": an empty list
    // used to look exactly like the history had been wiped.
    if (sdkFailedDetail) { chatsHint.textContent = 'error'; chatsNotice('// backend failed to start: ' + sdkFailedDetail, true); return; }
    if (chatsState === 'failed') { chatsHint.textContent = 'not loaded'; chatsNotice("// couldn't load your chats. they're safe on disk.", true); return; }
    chatsHint.textContent = chatsState === 'connecting' ? 'connecting…' : 'loading…';
    chatsList.innerHTML = '';
    for (let i = 0; i < 6; i++) {
      const row = document.createElement('div');
      row.className = 'chat-row skel';
      row.setAttribute('aria-hidden', 'true');
      row.innerHTML = '<div class="chat-body"><i class="skel-line"></i><i class="skel-line short"></i></div>';
      chatsList.appendChild(row);
    }
    return;
  }
  const rows = chatsCache.map((c) => ({
    id: c.id,
    // "Untitled chat" ×N is useless for picking a chat out of a list. When the
    // SDK has no usable summary, fall back to when the chat happened.
    title: (c.summary || '').trim() || describeUndatedChat(c.startTime || c.modifiedTime),
    updated: c.modifiedTime || c.startTime || 0,
  }));
  // Saved copies once a complete list has shown their session is gone: until
  // then a chat missing from a quick reply may simply not be listed yet.
  // One known to be gone stays while a refresh is still partial.
  if (savedCopies) {
    const listed = new Set(rows.map((r) => r.id));
    let added = false;
    for (const s of savedCopies) {
      if (listed.has(s.id) || !(chatsComplete || goneIds.has(s.id))) continue;
      rows.push({ id: s.id, title: s.title || describeUndatedChat(s.updated), updated: s.updated, saved: true });
      added = true;
    }
    if (added) rows.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  }
  // Make sure the current SID is visible even if the SDK hasn't recorded
  // a summary for it yet (brand-new chat with no turns).
  if (BROWY_SESSION_ID && !rows.some((r) => r.id === BROWY_SESSION_ID)) {
    rows.unshift({ id: BROWY_SESSION_ID, title: 'New chat', updated: Date.now() });
  }
  const q = (chatsSearch?.value || '').trim().toLowerCase();
  const filtered = q ? rows.filter((r) => (r.title || '').toLowerCase().includes(q)) : rows;
  chatsHint.textContent = filtered.length === 1 ? '1 chat' : filtered.length + ' chats';
  chatsList.innerHTML = '';
  if (!filtered.length) {
    const emp = document.createElement('div');
    emp.className = 'chats-empty';
    emp.textContent = q ? 'no chats match // ' + q : 'no past chats yet';
    chatsList.appendChild(emp);
    return;
  }
  for (const meta of filtered) chatsList.appendChild(chatRow(meta));
}

function chatRow(meta) {
  const id = meta.id;
  const row = document.createElement('div');
  row.className = 'chat-row' + (id === BROWY_SESSION_ID ? ' current' : '') + (meta.saved ? ' saved' : '');
  row.dataset.id = id;
  const body = document.createElement('div');
  body.className = 'chat-body';
  const title = document.createElement('div');
  title.className = 'chat-title';
  title.textContent = meta.title || 'Untitled chat';
  const m = document.createElement('div');
  m.className = 'chat-meta';
  const dot = id === BROWY_SESSION_ID ? '<span class="dot">● current</span> · ' : '';
  const saved = meta.saved ? '<span class="saved">saved copy · read-only</span> · ' : '';
  m.innerHTML = dot + saved + escapeHtml(fmtRelTime(meta.updated));
  body.appendChild(title); body.appendChild(m);
  row.appendChild(body);
  const del = document.createElement('button');
  del.className = 'chat-del'; del.title = 'Delete this chat';
  del.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 4h10M6 4V2h4v2M5 4l1 10h4l1-10"/></svg>';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Delete this chat? This cannot be undone.')) return;
    // Delete on disk FIRST and only drop the row once the host confirms.
    // The old path posted history.clear, which the host applied to whatever
    // session happened to be loaded, so deleting a past chat deleted
    // nothing at all and the row reappeared on the next refresh.
    del.disabled = true;
    row.classList.add('busy');
    m.textContent = 'deleting…';
    const ok = await requestChatDelete(id);
    // A saved copy may have no session left to delete; its copy goes anyway.
    if (!ok && !meta.saved) {
      del.disabled = false;
      row.classList.remove('busy');
      m.innerHTML = dot + saved + escapeHtml(fmtRelTime(meta.updated));
      flash('could not delete that chat');
      return;
    }
    await deleteChatStorage(id);
    if (chatsCache) chatsCache = chatsCache.filter((c) => c.id !== id);
    if (savedCopies) savedCopies = savedCopies.filter((c) => c.id !== id);
    goneIds.delete(id);
    if (id === BROWY_SESSION_ID) await startNewChat();
    renderChatRows();
  });
  row.appendChild(del);
  row.addEventListener('click', () => switchToChat(id));
  return row;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

inp.addEventListener('input', () => {
  goBtn.disabled = busy || !inp.value.trim();
  autoSize();
  if (!busy) pose('up', 800);
});
inp.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  if (e.key === 'Escape') { e.preventDefault(); stop(); }
});
goBtn.addEventListener('click', send);
stopBtn.addEventListener('click', stop);
newChatBtn?.addEventListener('click', () => {
  react('shake'); blip(220, 0.06, 'square', 0.04);
  startNewChat();
});
chatsBtn?.addEventListener('click', () => { openChatsOverlay(); });
exportBtn?.addEventListener('click', () => { exportChat(); });
chatsCloseBtn?.addEventListener('click', () => { closeChatsOverlay(); });
chatsNewBtn?.addEventListener('click', () => { closeChatsOverlay(); startNewChat(); });
chatsSearch?.addEventListener('input', () => { renderChatRows(); });

// First-run screen controls.
document.getElementById('obCopy')?.addEventListener('click', async () => {
  const btn = document.getElementById('obCopy');
  const ok = await copyText(INSTALL_CMDS[onboardOs === 'win' ? 'win' : 'unix']);
  if (!btn) return;
  if (!ok) {
    // Clipboard refused; select the command so Ctrl/Cmd+C still works.
    try { window.getSelection().selectAllChildren(document.getElementById('obCmd')); } catch {}
  }
  btn.textContent = ok ? 'copied' : 'select';
  btn.classList.toggle('copied', ok);
  setTimeout(() => { btn.textContent = 'copy'; btn.classList.remove('copied'); }, 1800);
});
document.querySelectorAll('#onboard .ob-os button').forEach((b) => {
  b.addEventListener('click', () => { onboardOs = b.dataset.os; renderOnboard(); });
});
document.getElementById('obCheck')?.addEventListener('click', () => probeHost(true));
// Coming back from the terminal is the moment the backend is most likely to
// have just appeared; check right away instead of waiting for the next tick.
document.addEventListener('visibilitychange', () => {
  if (onboardMode && document.visibilityState === 'visible') probeHost(false);
});
window.addEventListener('focus', () => { if (onboardMode) probeHost(false); });

trySuggestEl?.addEventListener('click', (e) => {
  const q = e.target.closest?.('.try-q');
  if (q) useSuggestion(q.textContent.trim());
});

// Host-update banner controls.
document.getElementById('updCopy')?.addEventListener('click', async () => {
  const b = document.getElementById('updBanner');
  const t = document.getElementById('updBannerText');
  const ok = await copyText(b?.dataset.cmd || '');
  if (t) {
    t.textContent = ok
      ? `copied. paste it into ${b.dataset.where}; browy reconnects by itself`
      : `couldn't copy. run: ${b?.dataset.cmd || 'the installer from browyhq.github.io/install'}`;
  }
});
document.getElementById('updLater')?.addEventListener('click', async () => {
  hideHostUpdateBanner();
  try { await chrome.storage.local.set({ [HOST_UPDATE_SNOOZE_KEY]: Date.now() + 24 * 60 * 60 * 1000 }); } catch {}
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && chatsOverlay.classList.contains('open')) {
    e.preventDefault(); closeChatsOverlay();
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'E' || e.key === 'e')) {
    e.preventDefault(); exportChat();
  }
});
// Mascot drag + click — uses main-process polling drag for reliability.
const DRAG_THRESH = 6;
let dragState = null;
mascotBox.addEventListener('mousedown', async (e) => {
  if (e.button !== 0) return;
  // Capture cursor offset from window top-left so the mascot stays under the cursor.
  let offsetX = e.clientX;  // fallback: client coords if bounds unavailable
  let offsetY = e.clientY;
  dragState = {
    startScreenX: e.screenX,
    startScreenY: e.screenY,
    offsetX, offsetY,
    moved: false,
  };
  try {
    const b = await window.winctl.getBounds();
    if (dragState) {
      dragState.offsetX = e.screenX - b.x;
      dragState.offsetY = e.screenY - b.y;
    }
  } catch {}
});
window.addEventListener('mousemove', (e) => {
  if (!dragState) return;
  const dx = e.screenX - dragState.startScreenX;
  const dy = e.screenY - dragState.startScreenY;
  if (!dragState.moved && (Math.abs(dx) > DRAG_THRESH || Math.abs(dy) > DRAG_THRESH)) {
    dragState.moved = true;
    mascotBox.classList.add('dragging');
    window.winctl?.dragStart(dragState.offsetX, dragState.offsetY);
  }
});
window.addEventListener('mouseup', () => {
  if (!dragState) return;
  if (dragState.moved) {
    window.winctl?.dragEnd();
    // Suppress the synthetic click that follows.
    const swallowOnce = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
    mascotBox.addEventListener('click', swallowOnce, { capture: true, once: true });
  }
  dragState = null;
  mascotBox.classList.remove('dragging');
});

mascotBox.addEventListener('click', (e) => {
  // Only restore if minimized; in normal mode clicking the avatar does nothing.
  if (minimized) {
    react('bounce'); pose('happy', 600); blip(660, 0.04, 'triangle', 0.05);
    setMinimized(false);
  }
});

function autoSize() {
  inp.style.height = 'auto';
  inp.style.height = Math.min(inp.scrollHeight, 80) + 'px';
}

// ── Focus & minimize model ───────────────────────────────────────
// Default: translucent visible. Focused: opaque solid. Minimized: mascot only.
// Focus-based body class toggle was used to switch the panel between a
// translucent "idle" surface and a solid "focused" surface. That dual-state
// design caused the panel to look washed-out / whitish when Chrome's side
// panel host showed through the alpha channel. The panel is now always solid
// — keep `applyFocus` as a no-op so any leftover callers don't break.
function applyFocus(/* focused */) { /* intentionally empty */ }

let minimized = false;
const FULL_W = 400, FULL_H = 620;
const MINI_W = 70,  MINI_H = 70;
let savedW = FULL_W, savedH = FULL_H;  // remembered "expanded" size across minimize cycles
async function setMinimized(v) {
  if (v && !minimized) {
    // Capture current window size before collapsing so restore returns to it.
    try {
      const b = await window.winctl?.getBounds();
      if (b && b.width > MINI_W + 10 && b.height > MINI_H + 10) {
        savedW = b.width; savedH = b.height;
      }
    } catch {}
  }
  minimized = v;
  document.body.classList.toggle('minimized', v);
  // Resize the OS window so it doesn't capture clicks outside the mascot.
  if (v) window.winctl?.setSize(MINI_W, MINI_H);
  else   window.winctl?.setSize(savedW, savedH);
  if (!v) inp.focus();
}
function toggleMinimize() { setMinimized(!minimized); }



connect = (function (orig) { return orig; })(connect);
(async function bootstrap() {
  // Resolve the OS early so a first-run screen opens on the right tab.
  detectOs();
  BROWY_SESSION_ID = await loadStoredSessionId();
  firstSendDone = await loadFirstSendFlag();
  // Paint this panel's last view of the chat at once; the session's own
  // version replaces it as soon as the backend answers.
  await paintFromCache(BROWY_SESSION_ID);
  // Populate the active-tab title immediately so the titlebar doesn't sit
  // on "connecting…" while the native host warms up.
  refreshActiveTab();
  // Start in the BOOTING state, not offline — connect() runs immediately and
  // the host is almost always either up or coming up. Starting in 'offline'
  // flashed "install the browy backend" at users who already have it.
  try { setControlsState('booting'); updateTrySuggestions(); } catch {}
  connect();
  // Waits for the backend, then renders the chat from its session.
  loadChat(BROWY_SESSION_ID);
})();
startIdleLoop();
inp.focus();
