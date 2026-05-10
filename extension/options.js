// Browy settings page.
//
// Connects to the background service worker via chrome.runtime.connect with
// port name "options". The SW already multiplexes any client port onto the
// native-host port, so we get the same protocol stream the side panel uses.
//
// Lifecycle:
//   1. On load, connect, send session.start (no capabilities — we don't drive
//      tabs from here).
//   2. Receive auth.status, models.current, models.list and render.
//   3. Click a model → models.set; receive models.current echo → confirm.

const SESSION_ID = 'opts-' + Math.random().toString(36).slice(2, 10);

// ── DOM refs ──────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const hostDot   = $('hostDot');
const hostVal   = $('hostVal');
const authDot   = $('authDot');
const authVal   = $('authVal');
const authDetail= $('authDetail');
const currentVal= $('currentVal');
const modelList = $('modelList');
const modelEmpty= $('modelEmpty');
const modelCount= $('modelCount');
const search    = $('search');
const signinBtn = $('signinBtn');
const verLabel  = $('verLabel');
const extId     = $('extId');
const toast     = $('toast');
const toolGroupsEl = $('toolGroups');
const toolSearchEl = $('toolSearch');
const toolCountEl  = $('toolCount');
const toolEnableAllEl = $('toolEnableAll');

let port = null;
let allModels = [];
let currentModelId = null;
let filterText = '';
/** name -> bool. Persisted to chrome.storage.local.settings.tools.
 *  Anything missing from this map is treated as enabled. The host receives
 *  the list of *disabled* names on every session.start (via background.js). */
let toolPrefs = {};
let toolFilterText = '';

// ── Built-in browser tool registry (UI-only metadata) ───────────────────────
// Names MUST match those in src/agent/tools/browser.ts. When a tool is
// disabled here, the agent never sees its function definition so the model
// won't even attempt to call it. Grouped by category for at-a-glance scanning.
const TOOL_REGISTRY = [
  { cat: 'inspect', name: 'inspect_page',         desc: 'snapshot page DOM with indices for clickable/typable/selectable elements' },
  { cat: 'inspect', name: 'get_page_info',        desc: 'url, title, meta, visible-text preview' },
  { cat: 'inspect', name: 'get_page_html',        desc: 'raw HTML of page or selector (≤8KB)' },
  { cat: 'inspect', name: 'extract_text',         desc: 'visible text of page or selector (≤4KB)' },
  { cat: 'inspect', name: 'extract_form',         desc: 'enumerate inputs of a form for fill_form' },
  { cat: 'inspect', name: 'query_dom',            desc: 'CSS selector → tag/text/attrs of matches (≤20)' },
  { cat: 'inspect', name: 'find_visible_text',    desc: 'locate elements by their visible text' },
  { cat: 'inspect', name: 'accessibility_snapshot', desc: 'AXTree-style accessibility info' },
  { cat: 'inspect', name: 'get_event_listeners', desc: 'list event listeners attached to an element' },

  { cat: 'navigate', name: 'navigate',     desc: 'go to a URL' },
  { cat: 'navigate', name: 'list_tabs',    desc: 'enumerate open tabs (index, url, title)' },
  { cat: 'navigate', name: 'switch_tab',   desc: 'change which tab the agent operates on' },
  { cat: 'navigate', name: 'new_tab',      desc: 'open a new tab' },
  { cat: 'navigate', name: 'close_tab',    desc: 'close a tab by index' },
  { cat: 'navigate', name: 'wait_for',     desc: 'wait for selector / navigation / timeout' },

  { cat: 'interact', name: 'click_index',     desc: 'click element by inspect_page index' },
  { cat: 'interact', name: 'type_index',      desc: 'type into input by index' },
  { cat: 'interact', name: 'select_index',    desc: 'pick a <select> option by index' },
  { cat: 'interact', name: 'clear_index',     desc: 'clear an input by index' },
  { cat: 'interact', name: 'check_index',     desc: 'toggle a checkbox by index' },
  { cat: 'interact', name: 'set_radio_index', desc: 'set a radio group by index' },
  { cat: 'interact', name: 'upload_index',    desc: 'attach a file to an input by index' },
  { cat: 'interact', name: 'press_keys',      desc: 'send keystrokes (Tab, Enter, Ctrl+A…)' },
  { cat: 'interact', name: 'fill_form',       desc: 'bulk fill all inputs in a form' },
  { cat: 'interact', name: 'submit_form',     desc: 'submit a form' },
  { cat: 'interact', name: 'click_element',   desc: 'click by CSS selector' },
  { cat: 'interact', name: 'fill_input',      desc: 'fill an input by CSS selector' },
  { cat: 'interact', name: 'press_key',       desc: 'press a single key' },
  { cat: 'interact', name: 'hover',           desc: 'mouse-hover an element' },
  { cat: 'interact', name: 'select_option',   desc: 'pick a <select> option by CSS' },
  { cat: 'interact', name: 'scroll',          desc: 'scroll the page or an element' },

  { cat: 'devtools', name: 'screenshot',          desc: 'PNG of the viewport (saved to disk)' },
  { cat: 'devtools', name: 'evaluate_js',         desc: 'run arbitrary JS in the page (powerful — scripts run with full DOM access)' },
  { cat: 'devtools', name: 'run_script',          desc: 'fetch + execute a script in the page' },
  { cat: 'devtools', name: 'get_console_logs',    desc: 'read recent console.* output' },
  { cat: 'devtools', name: 'get_network_requests', desc: 'recent network activity (Network panel-style)' },
  { cat: 'devtools', name: 'get_cookies',         desc: 'cookies for the current origin' },
  { cat: 'devtools', name: 'download_file',       desc: 'trigger a file download' },
  { cat: 'devtools', name: 'upload_file',         desc: 'upload a file via picker' },

  // ── Host tools (opt-in, OFF by default) ───────────────────────────────
  // These come from the Copilot SDK and reach the user's machine, not the
  // browser tab. We hide them behind explicit opt-in because a prompt
  // injection on a visited page could otherwise read ~/.ssh, run arbitrary
  // shell, or fetch from internal URLs. Names are validated against
  // HOST_TOOL_ALLOWLIST in src/agent/loop.ts.
  { cat: 'host', optIn: true, name: 'read_file',  desc: 'read any file on your machine (the agent runs as your user)' },
  { cat: 'host', optIn: true, name: 'write_file', desc: 'create or overwrite files on your machine' },
  { cat: 'host', optIn: true, name: 'bash',       desc: 'run arbitrary shell commands (full user privileges)' },
  { cat: 'host', optIn: true, name: 'grep',       desc: 'search file contents on your machine' },
  { cat: 'host', optIn: true, name: 'glob',       desc: 'list files by path pattern on your machine' },
  { cat: 'host', optIn: true, name: 'web_fetch',  desc: 'fetch arbitrary URLs from your machine (bypasses browser CORS/cookies)' },
];

const TOOL_CATEGORY_HINTS = {
  inspect:  'read-only — see the page',
  navigate: 'navigate between pages and tabs',
  interact: 'click, type, fill, scroll',
  devtools: 'console, network, screenshots, custom JS',
  host:     '⚠ advanced — agent reaches your filesystem & shell, not just the browser. opt-in only.',
};

// ── Connect ───────────────────────────────────────────────────────────────
function connect() {
  port = chrome.runtime.connect({ name: 'options' });
  port.onMessage.addListener(onMsg);
  port.onDisconnect.addListener(() => {
    setHost('disconnected', 'err');
    setTimeout(connect, 1500);
  });
}

function send(msg) {
  if (!port) return;
  try { port.postMessage(msg); } catch {}
}

// ── Install-backend section wiring (visible only when host is offline) ───
document.addEventListener('DOMContentLoaded', () => {
  for (const btn of document.querySelectorAll('.copy-btn')) {
    btn.addEventListener('click', async () => {
      const code = btn.parentElement?.querySelector('.install-code');
      const text = code?.textContent || '';
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        const prev = btn.textContent;
        btn.textContent = 'copied!';
        setTimeout(() => { btn.textContent = prev; }, 1200);
      } catch {
        try { window.prompt('Copy this command:', text); } catch {}
      }
    });
  }
  const recheck = document.getElementById('recheckLink');
  if (recheck) recheck.addEventListener('click', (e) => {
    e.preventDefault();
    setHost('rechecking…', 'warn');
    try { port?.disconnect(); } catch {}
    port = null;
    setTimeout(connect, 100);
  });
});

function onMsg(m) {
  if (!m || typeof m !== 'object') return;

  if (m.type === '__host_pending') {
    setHost('starting…', 'warn');
    return;
  }
  if (m.type === '__host_ready') {
    setHost('connected', 'live');
    if (m.serverVersion) verLabel.textContent = 'v' + m.serverVersion;
    // Open a session so pushInitialState fires.
    send({ type: 'session.start', sessionId: SESSION_ID, capabilities: [] });
    // And ask explicitly in case we missed the initial push.
    send({ type: 'models.list' });
    return;
  }
  if (m.type === '__host_disconnected' || m.type === '__host_error' || m.type === '__host_missing') {
    setHost('offline — make sure the browy backend is installed and running', 'err');
    return;
  }

  if (m.type === 'session.ready') {
    if (m.model) {
      currentModelId = m.model;
      renderCurrent();
      renderModels();
    }
    return;
  }
  if (m.type === 'auth.status') {
    setAuth(m.state, m.detail);
    return;
  }
  if (m.type === 'models.current') {
    currentModelId = m.id;
    renderCurrent();
    renderModels();
    return;
  }
  if (m.type === 'models.list') {
    allModels = Array.isArray(m.models) ? m.models : [];
    renderModels();
    return;
  }
  if (m.type === 'chat.error' && m.code === 'auth') {
    setAuth('unauth', m.message);
    return;
  }
}

// ── Render ────────────────────────────────────────────────────────────────
function setHost(label, dotClass) {
  hostVal.textContent = label;
  hostDot.className = 'dot ' + (dotClass || '');
  const installEl = document.getElementById('installSection');
  if (installEl) installEl.style.display = (dotClass === 'err') ? '' : 'none';
}

function setAuth(state, detail) {
  if (state === 'ready') {
    authDot.className = 'dot live';
    authVal.textContent = 'signed in';
    authDetail.textContent = detail || 'github copilot credential found';
    signinBtn.textContent = 're-open sign-in terminal';
  } else if (state === 'unauth') {
    authDot.className = 'dot err';
    authVal.textContent = 'signed out';
    authDetail.textContent = detail || 'sign-in required to chat';
    signinBtn.textContent = 'open sign-in terminal';
  } else {
    authDot.className = 'dot warn';
    authVal.textContent = state || 'unknown';
    authDetail.textContent = detail || '—';
  }
}

function renderCurrent() {
  if (!currentModelId) { currentVal.textContent = '—'; return; }
  const meta = allModels.find(m => m.id === currentModelId);
  currentVal.textContent = meta ? `${meta.name} (${meta.id})` : currentModelId;
}

function renderModels() {
  const q = filterText.trim().toLowerCase();
  const filtered = q
    ? allModels.filter(m =>
        m.id.toLowerCase().includes(q) ||
        (m.name || '').toLowerCase().includes(q) ||
        (m.vendor || '').toLowerCase().includes(q))
    : allModels;

  modelCount.textContent = filtered.length === allModels.length
    ? `${allModels.length} model${allModels.length === 1 ? '' : 's'}`
    : `${filtered.length} of ${allModels.length}`;

  if (filtered.length === 0) {
    modelList.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = allModels.length === 0
      ? 'no models loaded — sign in to github copilot first'
      : 'no models match filter';
    modelList.appendChild(empty);
    return;
  }

  modelList.innerHTML = '';
  for (const m of filtered) {
    const row = document.createElement('div');
    row.className = 'model' + (m.id === currentModelId ? ' selected' : '');
    row.tabIndex = 0;
    row.title = `Click to use ${m.id}`;

    const radio = document.createElement('span'); radio.className = 'radio';
    const meta = document.createElement('div');   meta.className = 'meta';
    const name = document.createElement('div');   name.className = 'name'; name.textContent = m.name || m.id;
    const sub  = document.createElement('div');   sub.className  = 'sub';
    sub.textContent = m.vendor ? `${m.id}  •  ${m.vendor}` : m.id;
    meta.appendChild(name); meta.appendChild(sub);

    const badges = document.createElement('div'); badges.className = 'badges';
    if (m.id === currentModelId) {
      const b = document.createElement('span'); b.className = 'badge cur'; b.textContent = 'current';
      badges.appendChild(b);
    }

    row.appendChild(radio); row.appendChild(meta); row.appendChild(badges);
    row.addEventListener('click', () => selectModel(m));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectModel(m); }
    });
    modelList.appendChild(row);
  }
}

function selectModel(m) {
  if (!m || m.id === currentModelId) return;
  currentModelId = m.id;
  renderCurrent();
  renderModels();
  send({ type: 'models.set', id: m.id });
  showToast(`model → ${m.name || m.id}`);
}

// ── Toast ─────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(text, kind) {
  toast.textContent = text;
  toast.className = 'toast show' + (kind === 'err' ? ' err' : '');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 1800);
}

// ── Wire up ───────────────────────────────────────────────────────────────
search.addEventListener('input', () => {
  filterText = search.value;
  renderModels();
});

signinBtn.addEventListener('click', () => {
  send({ type: 'auth.signin' });
  showToast('opened sign-in terminal — complete sign-in there');
});

// ── Tool toggles ─────────────────────────────────────────────────────────
function loadToolPrefs() {
  return chrome.storage.local.get(['settings']).then(({ settings }) => {
    const t = settings && settings.tools;
    toolPrefs = (t && typeof t === 'object') ? { ...t } : {};
  }).catch(() => { toolPrefs = {}; });
}

function saveToolPrefs() {
  return chrome.storage.local.get(['settings']).then(({ settings }) => {
    const next = { ...(settings || {}), tools: toolPrefs };
    return chrome.storage.local.set({ settings: next });
  }).catch(() => {});
}

function isToolEnabled(name) {
  // Default behavior depends on the tool's optIn flag.
  // - browser tools (optIn !== true): default ON; only `false` disables.
  // - host tools (optIn === true):    default OFF; only `true` enables.
  const t = TOOL_REGISTRY.find((x) => x.name === name);
  if (t && t.optIn) return toolPrefs[name] === true;
  return toolPrefs[name] !== false;
}

function setToolEnabled(name, enabled) {
  const t = TOOL_REGISTRY.find((x) => x.name === name);
  if (t && t.optIn) {
    if (enabled) toolPrefs[name] = true;
    else delete toolPrefs[name]; // omit = disabled (default)
  } else {
    if (enabled) delete toolPrefs[name]; // omit = enabled (default)
    else toolPrefs[name] = false;
  }
}

function renderTools() {
  if (!toolGroupsEl) return;
  const q = (toolFilterText || '').trim().toLowerCase();
  const matches = (t) =>
    !q ||
    t.name.toLowerCase().includes(q) ||
    t.cat.toLowerCase().includes(q) ||
    (t.desc || '').toLowerCase().includes(q);

  const groups = {};
  for (const t of TOOL_REGISTRY) {
    if (!matches(t)) continue;
    (groups[t.cat] ||= []).push(t);
  }

  const totalEnabled = TOOL_REGISTRY.filter((t) => isToolEnabled(t.name)).length;
  toolCountEl.textContent = `${totalEnabled} of ${TOOL_REGISTRY.length} on`;

  toolGroupsEl.innerHTML = '';
  const orderedCats = ['inspect', 'navigate', 'interact', 'devtools', 'host'];
  let renderedAny = false;
  for (const cat of orderedCats) {
    const items = groups[cat];
    if (!items || !items.length) continue;
    renderedAny = true;
    const group = document.createElement('div');
    group.className = 'tool-group';
    const gh = document.createElement('div');
    gh.className = 'gh' + (cat === 'host' ? ' host-warn' : '');
    const gt = document.createElement('span'); gt.className = 'gtitle'; gt.textContent = cat;
    const gh2 = document.createElement('span'); gh2.className = 'ghint';
    gh2.textContent = TOOL_CATEGORY_HINTS[cat] || '';
    gh.appendChild(gt); gh.appendChild(gh2);
    group.appendChild(gh);

    const list = document.createElement('div'); list.className = 'glist';
    for (const t of items) {
      const row = document.createElement('div');
      const on = isToolEnabled(t.name);
      row.className = 'tool-row ' + (on ? 'on' : 'off') + (t.optIn ? ' opt-in' : '');
      row.tabIndex = 0;
      row.title = on ? 'click to disable' : (t.optIn ? 'click to enable (advanced — reaches your machine)' : 'click to enable');

      const chk = document.createElement('span'); chk.className = 'chk';
      const meta = document.createElement('div');
      const n = document.createElement('div'); n.className = 'tname'; n.textContent = t.name;
      const d = document.createElement('div'); d.className = 'tdesc'; d.textContent = t.desc;
      meta.appendChild(n); meta.appendChild(d);
      const cat2 = document.createElement('span'); cat2.className = 'tcat'; cat2.textContent = t.cat;

      row.appendChild(chk); row.appendChild(meta); row.appendChild(cat2);

      const toggle = () => {
        const next = !isToolEnabled(t.name);
        setToolEnabled(t.name, next);
        saveToolPrefs();
        renderTools();
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
      list.appendChild(row);
    }
    group.appendChild(list);
    toolGroupsEl.appendChild(group);
  }

  if (!renderedAny) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'no tools match filter';
    toolGroupsEl.appendChild(empty);
  }
}

if (toolSearchEl) {
  toolSearchEl.addEventListener('input', () => {
    toolFilterText = toolSearchEl.value;
    renderTools();
  });
}
if (toolEnableAllEl) {
  toolEnableAllEl.addEventListener('click', () => {
    toolPrefs = {};
    saveToolPrefs();
    renderTools();
    showToast('reset to defaults — browser tools on, host tools off');
  });
}

extId.textContent = chrome.runtime.id;
loadToolPrefs().then(renderTools);
connect();
