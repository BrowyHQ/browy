
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
// We also persist the rendered chat HTML so the visible bubbles come back.
//
// Multi-chat model:
//   browy.sessionId       — current chat id
//   browy.chat.<id>       — rendered HTML for that chat
//   browy.chatMeta.<id>   — { id, title, updated, preview }
//   browy.chatIndex       — ordered list of ids (newest first)
let BROWY_SESSION_ID = null;
const SID_KEY    = 'browy.sessionId';
const CHAT_KEY   = 'browy.chatHtml';            // legacy single-chat store (migrated on boot)
const CHAT_PREFIX = 'browy.chat.';
const META_PREFIX = 'browy.chatMeta.';
const INDEX_KEY  = 'browy.chatIndex';

function newSessionId() {
  return 'sp-' + Math.random().toString(36).slice(2, 10);
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

async function loadStoredChatHtml() {
  if (!BROWY_SESSION_ID) return null;
  try {
    const r = await chrome.storage.local.get([CHAT_PREFIX + BROWY_SESSION_ID]);
    const v = r && r[CHAT_PREFIX + BROWY_SESSION_ID];
    if (typeof v === 'string') return v;
  } catch {}
  // Fall back to legacy single-chat key the first time around.
  try {
    const r = await chrome.storage.local.get([CHAT_KEY]);
    if (r && typeof r[CHAT_KEY] === 'string') return r[CHAT_KEY];
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

async function loadChatMeta(id) {
  try {
    const r = await chrome.storage.local.get([META_PREFIX + id]);
    return r?.[META_PREFIX + id] || null;
  } catch { return null; }
}

async function saveChatMeta(id, meta) {
  try { await chrome.storage.local.set({ [META_PREFIX + id]: meta }); } catch {}
}

async function deleteChatStorage(id) {
  try { await chrome.storage.local.remove([CHAT_PREFIX + id, META_PREFIX + id]); } catch {}
  const idx = await loadChatIndex();
  const next = idx.filter(x => x !== id);
  try { await chrome.storage.local.set({ [INDEX_KEY]: next }); } catch {}
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

function chatPreview(html) {
  try {
    const tmp = document.createElement('div');
    tmp.innerHTML = html || '';
    return (tmp.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  } catch { return ''; }
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

let _persistTimer = null;
function persistChatSoon() {
  if (_persistTimer) return;
  _persistTimer = setTimeout(async () => {
    _persistTimer = null;
    if (!BROWY_SESSION_ID) return;
    const html = msgs.innerHTML;
    if (!html || html.indexOf('class="empty"') !== -1) return;
    const title = deriveChatTitle(html);
    const meta = { id: BROWY_SESSION_ID, title, updated: Date.now(), preview: chatPreview(html) };
    try {
      await chrome.storage.local.set({
        [CHAT_PREFIX + BROWY_SESSION_ID]: html,
        [META_PREFIX + BROWY_SESSION_ID]: meta,
      });
      // Maintain index — current chat to the front, dedupe.
      const idx = await loadChatIndex();
      const reordered = [BROWY_SESSION_ID, ...idx.filter(x => x !== BROWY_SESSION_ID)];
      await chrome.storage.local.set({ [INDEX_KEY]: reordered });
      // Reflect title in the titlebar tag.
      if (modeTag) modeTag.textContent = '// ' + title;
    } catch {}
  }, 250);
}

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
function browySend(legacy) {
  if (!bgPort) return;
  if (legacy.type === 'chat') {
    pendingChat = '';
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
      return { type: 'response', text: msg.text || pendingChat, toolCalls: msg.toolCalls || [] };
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
      pendingChatListResolvers.splice(0).forEach(fn => fn(msg.chats || []));
      return null;
    case 'chat.history.result': {
      const list = pendingChatHistoryResolvers.get(msg.id);
      if (list) {
        pendingChatHistoryResolvers.delete(msg.id);
        list.forEach(fn => fn(msg.messages || []));
      }
      return null;
    }
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

// One-shot RPCs for chat list/history. The host answers each request with a
// single result message; we resolve all in-flight callers when it arrives.
//
// Timeout matters: on a cold host the Copilot SDK needs several seconds
// AFTER session.ready before chat.list can answer — measured anywhere from
// 7.7s to 40s depending on machine load. The old 4s timeout resolved with an
// empty array, which rendered identically to "you have no chats" — this is
// what made users think their history had been wiped. The host answers as
// soon as it can (listChats awaits whenCopilotReady internally), so we use a
// generous ceiling and let the honest "loading…" UI carry the wait.
const pendingChatListResolvers = [];
const pendingChatHistoryResolvers = new Map();
/** Dedupe concurrent chat.list requests — sdk.ready and an already-open
 *  overlay both trigger a render, and listSessions() is expensive. */
let chatListInFlight = null;
function requestChats(timeoutMs = 120000) {
  if (chatListInFlight) return chatListInFlight;
  const p = new Promise((resolve) => {
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      chatListInFlight = null;
      resolve(v);
    };
    pendingChatListResolvers.push((chats) => fin({ chats, timedOut: false }));
    browyPost({ type: 'chat.list' });
    setTimeout(() => fin({ chats: [], timedOut: true }), timeoutMs);
  });
  chatListInFlight = p;
  return p;
}
function requestChatMessages(id, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    if (!pendingChatHistoryResolvers.has(id)) pendingChatHistoryResolvers.set(id, []);
    pendingChatHistoryResolvers.get(id).push(fin);
    browyPost({ type: 'chat.history', id });
    setTimeout(() => fin([]), timeoutMs);
  });
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

function connect() {
  // Hard-fail fast if our context is dead — full page reload picks up the
  // freshly-installed extension code + a working chrome.runtime.
  if (isExtensionContextInvalidated()) {
    try { location.reload(); } catch {}
    return;
  }
  try {
    bgPort = chrome.runtime.connect({ name: 'sidepanel' });
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
      hideConnBanner();
      setLive(true); setError(false); brand.textContent = '·';
      try {
        const hint = document.querySelector('#empty .hint');
        if (hint) hint.textContent = '// type below';
        setControlsState('online');
      } catch {}
      browyPost({
        type: 'session.start',
        sessionId: BROWY_SESSION_ID,
        capabilities: ['cdp.activeTab'],
      });
      refreshActiveTab();
      return;
    }
    if (raw.type === '__host_pending') {
      reconnectAttempts = 0; // SW is alive even if host isn't
      brand.textContent = 'starting…';
      // Booting is NOT offline. Let the user type (and queue a send) while
      // the host cold-starts, and never tell them to install a backend they
      // already have.
      try {
        setControlsState('booting');
        hideConnBanner();
        const hint = document.querySelector('#empty .hint');
        if (hint) hint.textContent = '// starting the browy backend — first run takes a few seconds';
      } catch {}
      return;
    }
    if (raw.type === '__host_error' || raw.type === '__host_disconnected' || raw.type === '__host_missing' || raw.type === '__host_stale') {
      sessionReady = false;
      sdkReady = false;
      setLive(false); setBusy(false); brand.textContent = 'offline';
      tabTitleText = '—'; currentAction = null; setTtl();
      try {
        const hint = document.querySelector('#empty .hint');
        if (hint) hint.textContent = '// offline. check that the browy backend is installed and running';
        setControlsState('offline');
        if (typeof closeChatsOverlay === 'function') closeChatsOverlay();
        if (raw.type === '__host_missing') {
          showConnBanner('Browy backend not installed.', {
            action: { label: 'Install →', href: INSTALL_PS1_URL },
          });
        } else if (raw.type === '__host_stale') {
          showConnBanner('Backend installed but does not trust this extension. Upgrade the backend.', {
            action: { label: 'Upgrade →', href: INSTALL_PS1_URL },
          });
        } else {
          showConnBanner('Host disconnected. Retrying…', {
            warn: true,
            action: { label: 'Reinstall →', href: INSTALL_PS1_URL },
          });
        }
      } catch {}
      return;
    }
    if (raw.type === 'session.ready') {
      sessionReady = true;
      // Safety net: any real message from the host proves it's alive, so
      // make sure the online controls reflect that even if __host_ready
      // was somehow missed during a fast SW restart.
      try { setControlsState('online'); hideConnBanner(); } catch {}
      refreshActiveTab();
      flushPendingHostMsgs();
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
    const legacy = browyTranslate(raw);
    if (legacy) handle(legacy);
  });
  bgPort.onDisconnect.addListener(() => {
    sessionReady = false;
    sdkReady = false;
    bgPort = null;
    setLive(false); setBusy(false); brand.textContent = 'offline';
    tabTitleText = '—'; currentAction = null; setTtl();
    try { setControlsState('offline'); } catch {}
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
    showConnBanner(
      `Host disconnected — reconnecting (${reconnectAttempts}/${RELOAD_AFTER_FAILURES})…`,
      { warn: true }
    );
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
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
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
    if (m.status === 'error')    { setBusy(false); setError(true); finalizeLiveBubble(); currentAction = null; setTtl(); }
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
    // Final canonical text — reconcile in case streaming missed any chunks
    reconcileFinal(m.text || '');
    react('bounce'); sndRecv();
    pose('happy', 1100);
    persistChatSoon();
    clearAuthBannerOnSuccess();
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
let liveBub = null;       // current assistant <div>
let liveText = '';        // accumulated streamed text
let liveBody = null;      // <div> inside liveBub for markdown text
let liveSteps = null;     // <div class="tool-steps"> inside liveBub
const stepNodes = new Map(); // id -> <div class="tool-step">

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
    msgs.appendChild(d);
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
    const stepsEl = liveSteps;
    const stepCount = stepsEl.querySelectorAll('.tool-step').length;
    let totalMs = 0;
    stepsEl.querySelectorAll('.tool-step .ms').forEach(el => {
      const m = /(\d+)ms/.exec(el.textContent || '');
      if (m) totalMs += parseInt(m[1], 10);
    });
    const summary = document.createElement('div');
    summary.className = 'tools-summary';
    summary.innerHTML =
      `<span class="glyph"></span>` +
      `<span class="arrow"></span>` +
      `<span class="lbl">used ${stepCount} tool${stepCount === 1 ? '' : 's'}` +
      (totalMs ? ` · ${totalMs}ms` : '') + `</span>`;
    stepsEl.appendChild(summary);
    stepsEl.classList.add('collapsed');
    summary.addEventListener('click', () => {
      stepsEl.classList.toggle('expanded-back');
    });
  } else if (liveSteps && liveSteps.children.length === 0) {
    liveSteps.remove();
  }

  liveBub = null; liveBody = null; liveSteps = null; liveText = '';
  stepNodes.clear();
}

function summarizeArgs(args) {
  if (!args) return '';
  const vals = Object.values(args).map(v => {
    if (typeof v === 'string') return v;
    if (v == null) return '';
    try { return JSON.stringify(v); } catch { return String(v); }
  }).filter(Boolean);
  let s = vals.join(', ');
  if (s.length > 80) s = s.slice(0, 79) + '…';
  return s;
}

function summarizeResult(result, status) {
  if (status === 'running') return 'running…';
  if (!result) return status === 'error' ? 'failed' : 'done';
  const oneline = String(result).replace(/\s+/g, ' ').trim();
  if (oneline.length > 120) return oneline.slice(0, 119) + '…';
  return oneline;
}

function renderToolStep(m) {
  ensureLiveBubble();
  let node = stepNodes.get(m.id);
  if (!node) {
    node = document.createElement('div');
    node.className = 'tool-step running';
    node.innerHTML =
      `<span class="glyph"></span>` +
      `<span class="head"><span class="name"></span><span class="paren">(</span><span class="args"></span><span class="paren">)</span></span>` +
      `<span class="ms"></span>` +
      `<div class="out"><span class="arc"></span><span class="preview">running…</span></div>`;
    node.querySelector('.name').textContent = m.name;
    node.querySelector('.args').textContent = summarizeArgs(m.args);
    node.addEventListener('click', () => node.classList.toggle('expanded'));
    liveSteps.appendChild(node);
    stepNodes.set(m.id, node);
  }
  if (m.status === 'end') {
    node.classList.remove('running');
    node.classList.add('done');
    if (m.durationMs != null) node.querySelector('.ms').textContent = m.durationMs + 'ms';
    node.querySelector('.preview').textContent = summarizeResult(m.result, 'done');
    if (m.result) node.querySelector('.preview').dataset.full = m.result;
  }
  if (m.status === 'error') {
    node.classList.remove('running');
    node.classList.add('error');
    if (m.durationMs != null) node.querySelector('.ms').textContent = m.durationMs + 'ms';
    node.querySelector('.preview').textContent = summarizeResult(m.result, 'error');
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

// ── Bubbles ─────────────────────────────────────────────────────
/** Rebuild the collapsed tool-call block for a chat restored from the SDK
 *  transcript. Mirrors the markup finalizeLive() produces so restored chats
 *  look like the live ones. Transcript rows carry no args/duration, so those
 *  slots stay empty rather than being faked. */
function renderRestoredToolSteps(bub, steps) {
  if (!bub || !steps || !steps.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'tool-steps collapsed';
  for (const s of steps) {
    const node = document.createElement('div');
    node.className = 'tool-step ' + (s.ok ? 'done' : 'error');
    node.innerHTML =
      `<span class="glyph"></span>` +
      `<span class="head"><span class="name"></span><span class="paren">(</span><span class="args"></span><span class="paren">)</span></span>` +
      `<span class="ms"></span>` +
      `<div class="out"><span class="arc"></span><span class="preview"></span></div>`;
    node.querySelector('.name').textContent = s.name || 'tool';
    node.querySelector('.preview').textContent = summarizeResult(s.summary, s.ok ? 'done' : 'error');
    node.addEventListener('click', () => node.classList.toggle('expanded'));
    wrap.appendChild(node);
  }
  const summary = document.createElement('div');
  summary.className = 'tools-summary';
  const n = steps.length;
  summary.innerHTML =
    `<span class="glyph"></span><span class="arrow"></span>` +
    `<span class="lbl">used ${n} tool${n === 1 ? '' : 's'}</span>`;
  summary.addEventListener('click', () => wrap.classList.toggle('expanded-back'));
  wrap.appendChild(summary);
  bub.insertBefore(wrap, bub.firstChild);
}

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
  ws.send(JSON.stringify({ type: 'chat', text: t }));
  addBub('u', t);
  inp.value = ''; autoSize();
  goBtn.disabled = true;
  setBusy(true);
  react('nod'); sndSend();
  persistChatSoon();
  // Queued while the host cold-starts — make the wait explicit rather than
  // leaving an indefinite "thinking" state with nothing happening.
  if (!sessionReady) {
    try {
      showConnBanner('Backend still starting — your message will send automatically.', { warn: true });
    } catch {}
  }
}
function stop() { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'stop' })); }

// Start a brand new chat. The current chat is left intact in storage (it'll
// reappear under "chats" in the history overlay). Backend session keeps the
// same id-on-disk model so the new SID gets a fresh on-disk SDK session.
async function startNewChat() {
  // Persist any in-flight current chat synchronously before we swap.
  if (msgs.innerHTML && msgs.innerHTML.indexOf('class="empty"') === -1) {
    const html = msgs.innerHTML;
    const title = deriveChatTitle(html);
    try {
      await chrome.storage.local.set({
        [CHAT_PREFIX + BROWY_SESSION_ID]: html,
        [META_PREFIX + BROWY_SESSION_ID]: { id: BROWY_SESSION_ID, title, updated: Date.now(), preview: chatPreview(html) },
      });
      const idx = await loadChatIndex();
      const reordered = [BROWY_SESSION_ID, ...idx.filter(x => x !== BROWY_SESSION_ID)];
      await chrome.storage.local.set({ [INDEX_KEY]: reordered });
    } catch {}
  }
  // Tell the host to forget the active SDK handle WITHOUT deleting it on disk
  // (so the previous chat is preserved in the chats overlay). The new SID's
  // SDK session is created lazily on the next chat.send via
  // setBrowyProtocolSessionId → ensureSession on the host.
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'stop' }));
  // Mint a new SID and rebind.
  BROWY_SESSION_ID = newSessionId();
  try { await chrome.storage.local.set({ [SID_KEY]: BROWY_SESSION_ID }); } catch {}
  msgs.innerHTML = '';
  msgs.appendChild(empty);
  liveBub = null; liveBody = null; liveSteps = null; liveText = ''; stepNodes.clear();
  if (modeTag) modeTag.textContent = '// browser agent';
  // Tell the host to start the new session.
  browyPost({ type: 'session.start', sessionId: BROWY_SESSION_ID, capabilities: ['cdp.activeTab'] });
}

// Switch to a previously-saved chat. Source of truth is the SDK transcript
// (chat.history). We still keep a local HTML cache for instant re-render of
// the CURRENT chat on side-panel reload, but for past chats we always fetch
// fresh so the list stays in sync with disk.
async function switchToChat(id) {
  if (!id || id === BROWY_SESSION_ID) { closeChatsOverlay(); return; }
  // Persist current first (so side-panel reload re-renders fast).
  if (msgs.innerHTML && msgs.innerHTML.indexOf('class="empty"') === -1) {
    const html = msgs.innerHTML;
    try {
      await chrome.storage.local.set({
        [CHAT_PREFIX + BROWY_SESSION_ID]: html,
      });
    } catch {}
  }
  // End host-side session for the current id (host can resume the new one on demand).
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'stop' }));
  BROWY_SESSION_ID = id;
  try { await chrome.storage.local.set({ [SID_KEY]: id }); } catch {}
  msgs.innerHTML = '';
  liveBub = null; liveBody = null; liveSteps = null; liveText = ''; stepNodes.clear();
  // Render from the SDK transcript.
  const transcript = await requestChatMessages(id);
  if (transcript && transcript.length) {
    // Replay tool activity too. mapEventsToMessages already returns role:'tool'
    // rows; dropping them made a restored chat look materially different from
    // the live one (no evidence the agent had done anything).
    let pendingTools = [];
    const flushTools = () => {
      if (!pendingTools.length) return;
      const steps = pendingTools.slice();
      pendingTools = [];
      return steps;
    };
    for (const m of transcript) {
      if (m.role === 'user') {
        pendingTools = [];
        addBub('u', m.text);
      } else if (m.role === 'tool') {
        pendingTools.push(m);
      } else if (m.role === 'assistant') {
        const bub = addBub('a', m.text);
        const steps = flushTools();
        if (steps && steps.length && bub) renderRestoredToolSteps(bub, steps);
      }
    }
    if (modeTag) {
      const firstUser = transcript.find(x => x.role === 'user');
      modeTag.textContent = '// ' + (firstUser?.text?.slice(0, 60) || 'browser agent');
    }
  } else {
    msgs.appendChild(empty);
    if (modeTag) modeTag.textContent = '// browser agent';
  }
  msgs.scrollTop = msgs.scrollHeight;
  // Resume / start the SDK session for the new id on the host side.
  browyPost({ type: 'session.start', sessionId: BROWY_SESSION_ID, capabilities: ['cdp.activeTab'] });
  closeChatsOverlay();
}

/** Last successful chat.list payload, so typing in the search box filters
 *  locally instead of re-scanning every session on disk per keystroke. */
let chatsCache = null;
// ── Chats overlay rendering ───────────────────────────────────────────────
async function openChatsOverlay() {
  chatsCache = null; // always fetch fresh when the overlay is opened
  await renderChatsList();
  chatsOverlay.classList.add('open');
  chatsOverlay.setAttribute('aria-hidden', 'false');
  setTimeout(() => chatsSearch?.focus(), 50);
}
function closeChatsOverlay() {
  chatsOverlay.classList.remove('open');
  chatsOverlay.setAttribute('aria-hidden', 'true');
  if (chatsSearch) chatsSearch.value = '';
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
async function renderChatsList(filter = '', opts = {}) {
  // Source of truth: Copilot SDK sessions tagged with our workdir.
  //
  // There are THREE non-success states here and they used to all render as
  // "no past chats yet", which is indistinguishable from real data loss:
  //   1. host not connected yet          → connecting
  //   2. host up but SDK still booting   → loading history (the common one)
  //   3. request timed out / SDK failed  → error + retry
  const renderNotice = (hint, text, withRetry) => {
    chatsHint.textContent = hint;
    chatsList.innerHTML = '';
    const emp = document.createElement('div');
    emp.className = 'chats-empty';
    emp.textContent = text;
    chatsList.appendChild(emp);
    if (withRetry) {
      const btn = document.createElement('button');
      btn.className = 'chats-retry';
      btn.textContent = 'retry';
      btn.addEventListener('click', () => renderChatsList(chatsSearch?.value || ''));
      chatsList.appendChild(btn);
    }
  };

  if (!sessionReady) {
    renderNotice('connecting…', '// waiting for the browy backend to come online', false);
    return;
  }
  if (sdkFailedDetail) {
    renderNotice('error', '// backend failed to start: ' + sdkFailedDetail, true);
    return;
  }
  if (!sdkReady) {
    // Don't lie about emptiness while the SDK subprocess is still warming.
    renderNotice('loading…', '// loading your chat history — the backend is still starting', false);
    // Fall through to the request anyway: it resolves as soon as the SDK is
    // up, and sdk.ready will re-render us too.
  }

  const { chats: sdkChats, timedOut } = chatsCache && opts.useCache
    ? { chats: chatsCache, timedOut: false }
    : await requestChats();
  if (timedOut) {
    renderNotice('timed out', '// could not load chat history — your chats are safe on disk', true);
    return;
  }
  chatsCache = sdkChats;
  const rows = sdkChats.map(c => ({
    id: c.id,
    // "Untitled chat" ×N is useless for picking a chat out of a list. When the
    // SDK has no usable summary, fall back to when the chat happened.
    title: (c.summary || '').trim() || describeUndatedChat(c.startTime || c.modifiedTime),
    updated: c.modifiedTime || c.startTime || 0,
    preview: '', // SDK doesn't surface a snippet; the title (summary) is enough
  }));
  // Make sure the current SID is visible even if the SDK hasn't recorded
  // a summary for it yet (brand-new chat with no turns).
  if (BROWY_SESSION_ID && !rows.some(r => r.id === BROWY_SESSION_ID)) {
    rows.unshift({ id: BROWY_SESSION_ID, title: 'New chat', updated: Date.now(), preview: '' });
  }
  const q = filter.trim().toLowerCase();
  const filtered = q
    ? rows.filter(r => (r.title || '').toLowerCase().includes(q))
    : rows;
  chatsHint.textContent = filtered.length === 1 ? '1 chat' : filtered.length + ' chats';
  chatsList.innerHTML = '';
  if (!filtered.length) {
    const emp = document.createElement('div');
    emp.className = 'chats-empty';
    emp.textContent = q ? 'no chats match // ' + q : 'no past chats yet';
    chatsList.appendChild(emp);
    return;
  }
  for (const meta of filtered) {
    const id = meta.id;
    const row = document.createElement('div');
    row.className = 'chat-row' + (id === BROWY_SESSION_ID ? ' current' : '');
    row.dataset.id = id;
    const body = document.createElement('div');
    body.className = 'chat-body';
    const title = document.createElement('div');
    title.className = 'chat-title';
    title.textContent = meta.title || 'Untitled chat';
    const m = document.createElement('div');
    m.className = 'chat-meta';
    const dot = id === BROWY_SESSION_ID ? '<span class="dot">● current</span> · ' : '';
    m.innerHTML = dot + escapeHtml(fmtRelTime(meta.updated));
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
      // session happened to be loaded — so deleting a past chat deleted
      // nothing at all and the row reappeared on the next refresh.
      del.disabled = true;
      const ok = await requestChatDelete(id);
      if (!ok) {
        del.disabled = false;
        flash('could not delete that chat');
        return;
      }
      await deleteChatStorage(id);
      chatsCache = null;
      if (id === BROWY_SESSION_ID) {
        await startNewChat();
      }
      await renderChatsList(chatsSearch?.value || '');
    });
    row.appendChild(del);
    row.addEventListener('click', () => switchToChat(id));
    chatsList.appendChild(row);
  }
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
chatsSearch?.addEventListener('input', () => { renderChatsList(chatsSearch.value, { useCache: true }); });
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
  BROWY_SESSION_ID = await loadStoredSessionId();
  const savedHtml = await loadStoredChatHtml();
  if (savedHtml && savedHtml.trim() && savedHtml.indexOf('class="empty"') === -1) {
    msgs.innerHTML = savedHtml;
    // Strip any leftover streaming cursor from a prior session.
    msgs.querySelectorAll('.cursor').forEach(n => n.remove());
    msgs.scrollTop = msgs.scrollHeight;
    // Reflect the chat title in the titlebar tag.
    if (modeTag) modeTag.textContent = '// ' + deriveChatTitle(savedHtml);
  }
  // Populate the active-tab title immediately so the titlebar doesn't sit
  // on "connecting…" while the native host warms up.
  refreshActiveTab();
  // Start in the BOOTING state, not offline — connect() runs immediately and
  // the host is almost always either up or coming up. Starting in 'offline'
  // flashed "install the browy backend" at users who already have it.
  try { setControlsState('booting'); } catch {}
  connect();
})();
startIdleLoop();
inp.focus();
