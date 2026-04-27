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

let port = null;
let allModels = [];
let currentModelId = null;
let filterText = '';

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

extId.textContent = chrome.runtime.id;
connect();
