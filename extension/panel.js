// Browy DevTools panel — a Chrome DevTools Console-styled REPL that talks
// to the Browy agent like Copilot CLI / Claude Code: streaming text,
// inline tool-call cards, slash commands, history, multi-line input.
//
// Wire format (background.js → native host): see src/protocol.ts
//   chat.delta         – streamed assistant text chunk
//   chat.tool_call     – { tool, args }
//   chat.tool_result   – { ok, summary, durationMs }
//   chat.done          – final text (may be empty if streaming completed)
//   chat.error         – error
//   session.ready      – { model }

// Session id is PERSISTED per inspected tab. It used to be minted fresh at
// module scope on every panel load — and a DevTools panel reloads every time
// the user closes and reopens DevTools — so each open started an unresumable
// conversation and left an orphan session on disk. Keying by inspected tab
// means reopening DevTools on the same page picks up where you left off.
let SESSION_ID = 'dt-' + Math.random().toString(36).slice(2, 10);
const inspectedTabId = chrome.devtools.inspectedWindow.tabId;
const DT_SID_KEY = 'browy.dt.sessionId.' + inspectedTabId;

const sessionIdReady = (async () => {
  try {
    const r = await chrome.storage.local.get([DT_SID_KEY]);
    const v = r && r[DT_SID_KEY];
    if (typeof v === 'string' && v) { SESSION_ID = v; return SESSION_ID; }
  } catch {}
  try { await chrome.storage.local.set({ [DT_SID_KEY]: SESSION_ID }); } catch {}
  return SESSION_ID;
})();

/** Start a brand-new DevTools conversation: delete the current one on disk,
 *  then mint and persist a fresh id so we don't silently reuse the old one. */
async function resetDevtoolsSession() {
  const old = SESSION_ID;
  SESSION_ID = 'dt-' + Math.random().toString(36).slice(2, 10);
  try { await chrome.storage.local.set({ [DT_SID_KEY]: SESSION_ID }); } catch {}
  sendToHost({ type: 'chat.delete', id: old });
  sendToHost({
    type: 'session.start',
    sessionId: SESSION_ID,
    inspectedTabId: inspectedTabId,
    capabilities: ['cdp.activeTab'],
  });
}

// ── DOM refs ─────────────────────────────────────────────────────────────

const $log    = document.getElementById('log');
const $cmd    = document.getElementById('cmd');
const $prompt = document.getElementById('prompt-row');
const $promptGlyph = document.getElementById('prompt-glyph');
const $ac     = document.getElementById('ac');
const $model  = document.getElementById('model');
const $page   = document.getElementById('page');
const $btnClear = document.getElementById('btnClear');
const $btnReset = document.getElementById('btnReset');

// ── State ────────────────────────────────────────────────────────────────

let busy = false;
let hostReady = false;
let sessionStarted = false;
let sessionModel = '';
let liveBodyEl = null;     // streaming target <span>
let liveText = '';
let liveRowEl = null;
let replMode = false;      // /js toggles a JS-REPL mode (no LLM, eval in page)
const DEFAULT_PROMPT_GLYPH = '›';
const REPL_PROMPT_GLYPH = 'js>';
const DEFAULT_PLACEHOLDER = 'ask anything · / for commands · Shift+Enter newline · Esc cancels';
const REPL_PLACEHOLDER = 'JS REPL · evaluates in the inspected page · /js to exit';
let lastAssistantText = '';
let modelsCache = [];      // ModelOption[]
let chatsCache = [];       // chat.list.result.chats
const pendingResponses = new Map(); // ad-hoc request → resolver
const toolCardsByCallId = new Map(); // callId -> .tool-card element
const cmdHistory = [];
let cmdIdx = -1;
let cmdDraft = '';

// Autocomplete dropdown state
let acOpen = false;
let acItems = [];
let acIdx = 0;
let acEl = null;

// ── Output helpers ───────────────────────────────────────────────────────

function nearBottom() {
  return $log.scrollHeight - $log.scrollTop - $log.clientHeight < 40;
}

function appendRow(cls, glyph, text, opts = {}) {
  const stick = nearBottom();
  const row = document.createElement('div');
  row.className = 'row ' + (cls || 'info');
  const g = document.createElement('span');
  g.className = 'glyph';
  g.textContent = glyph || '';
  const b = document.createElement('span');
  b.className = 'body';
  if (opts.html) b.innerHTML = text;
  else b.textContent = text == null ? '' : String(text);
  row.appendChild(g); row.appendChild(b);
  if (typeof opts.onClick === 'function') {
    row.classList.add('clickable');
    row.addEventListener('click', (ev) => {
      ev.stopPropagation();
      opts.onClick(ev);
    });
  }
  $log.appendChild(row);
  if (stick) $log.scrollTop = $log.scrollHeight;
  return { row, body: b };
}

function clearLog() {
  $log.replaceChildren();
}

// Streaming assistant row — append-as-deltas-arrive
function startLiveAssistant() {
  const { row, body } = appendRow('assistant streaming', '◂', '');
  liveRowEl = row;
  liveBodyEl = body;
  liveText = '';
}
function appendDelta(text) {
  if (!liveBodyEl) startLiveAssistant();
  liveText += text;
  liveBodyEl.textContent = liveText;
  if (nearBottom()) $log.scrollTop = $log.scrollHeight;
}
function finalizeLiveAssistant(finalText) {
  // Canonical text from chat.done is authoritative — overwrite unconditionally.
  // (Older guard `finalText.length > liveText.length` failed when our \n\n
  // tool-step injections made liveText longer than the canonical, leaving the
  // user with mid-stream rendering glitches that never got reconciled.)
  if (finalText) {
    if (liveBodyEl) liveBodyEl.textContent = finalText;
    else appendRow('assistant', '◂', finalText);
    liveText = finalText;
  }
  if (liveText) lastAssistantText = liveText;
  else if (finalText) lastAssistantText = finalText;
  if (liveRowEl) liveRowEl.classList.remove('streaming');
  liveRowEl = null;
  liveBodyEl = null;
  liveText = '';
}

// Tool-call card — appears on chat.tool_call, mutates on chat.tool_result
function appendToolCard(callId, toolName, args) {
  const stick = nearBottom();
  const row = document.createElement('div');
  row.className = 'row tool';
  const g = document.createElement('span');
  g.className = 'glyph';
  g.textContent = '⏺';
  const b = document.createElement('span');
  b.className = 'body';
  const card = document.createElement('span');
  card.className = 'tool-card';
  card.dataset.callId = callId;

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = toolName;
  card.appendChild(name);

  // brief args preview
  if (args && Object.keys(args).length) {
    const argsText = formatArgs(args);
    if (argsText) {
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = '(' + argsText + ')';
      card.appendChild(meta);
    }
  }

  const status = document.createElement('span');
  status.className = 'meta';
  status.textContent = ' …';
  status.dataset.role = 'status';
  card.appendChild(status);

  b.appendChild(card);
  row.appendChild(g); row.appendChild(b);
  $log.appendChild(row);
  toolCardsByCallId.set(callId, card);
  if (stick) $log.scrollTop = $log.scrollHeight;
}

function completeToolCard(callId, ok, summary, durationMs) {
  const card = toolCardsByCallId.get(callId);
  if (!card) return;
  toolCardsByCallId.delete(callId);
  card.classList.add(ok ? 'ok' : 'bad');
  const status = card.querySelector('[data-role="status"]');
  if (status) {
    const parts = [];
    if (durationMs != null) parts.push(durationMs + 'ms');
    if (summary) parts.push(summary);
    status.textContent = parts.length ? '  ' + parts.join(' · ') : (ok ? ' ✓' : ' ✗');
  }
}

function formatArgs(args) {
  try {
    const entries = Object.entries(args).slice(0, 3);
    if (entries.length === 0) return '';
    const out = entries.map(([k, v]) => {
      let s = '';
      if (typeof v === 'string') s = JSON.stringify(v.length > 40 ? v.slice(0, 40) + '…' : v);
      else if (typeof v === 'object') s = '{…}';
      else s = String(v);
      return k + ':' + s;
    }).join(', ');
    return out.length > 80 ? out.slice(0, 80) + '…' : out;
  } catch { return ''; }
}

// ── Busy / prompt state ──────────────────────────────────────────────────

function setBusy(b) {
  busy = b;
  $cmd.disabled = b;
  $prompt.classList.toggle('busy', b);
  if (!b) $cmd.focus();
}

// ── Slash commands ───────────────────────────────────────────────────────
//
// Inspired by Copilot CLI's interactive command set. We port the ones
// that map cleanly to a browser-context CLI.

const COMMANDS = [
  { name: '/help',     help: 'Show available commands',                run: cmdHelp },
  { name: '/clear',    help: 'Clear the scrollback (Ctrl+L)',          run: () => clearLog() },
  { name: '/new',      help: 'Start a new conversation',               run: cmdReset },
  { name: '/reset',    help: 'Abandon this session and start fresh',   run: cmdReset },
  { name: '/model',    help: 'Show current model + pick from list: /model [id]', run: cmdModel },
  { name: '/login',    help: 'Sign in to GitHub Copilot',              run: cmdLogin },
  { name: '/sessions', help: 'List recent chat sessions',              run: cmdSessions },
  { name: '/copy',     help: 'Copy the last response to clipboard',    run: cmdCopy },
  { name: '/version',  help: 'Show version info',                      run: cmdVersion },
  { name: '/theme',    help: 'Set theme: /theme [auto|dark|light]',    run: cmdTheme },
  { name: '/feedback', help: 'Open the feedback page on GitHub',       run: cmdFeedback },
  { name: '/url',      help: 'Print the inspected page URL',           run: () => evalAndPrint('location.href') },
  { name: '/title',    help: 'Print the inspected page <title>',       run: () => evalAndPrint('document.title') },
  { name: '/tabs',     help: 'List open browser tabs (click to switch)', run: cmdTabs },
  { name: '/eval',     help: 'Eval JS in the inspected page: /eval <expr>', run: cmdEval },
  { name: '/js',       help: 'Toggle JS REPL mode (every line evaluated in the page)', run: cmdReplToggle },
  { name: '/dom',      help: 'querySelectorAll summary: /dom <selector>',   run: cmdDom },
  { name: '/snapshot', help: 'Quick page summary (title/url/headings)', run: cmdSnapshot },
  { name: '/export',   help: 'Download the scrollback as a .txt file', run: cmdExport },
  { name: '/cancel',   help: 'Cancel the in-flight agent turn (Esc)',  run: () => sendToHost({ type: 'chat.cancel', sessionId: SESSION_ID }) },
  { name: '/history',  help: 'Show recent input history',              run: cmdInputHistory },
  { name: '/exit',     help: 'Close this panel hint',                  run: () => appendRow('dim', '·', 'close DevTools to exit') },
];

function cmdHelp() {
  appendRow('info', 'i', 'Slash commands:');
  const w = Math.max(...COMMANDS.map(c => c.name.length));
  for (const c of COMMANDS) {
    appendRow('dim', ' ', c.name.padEnd(w + 2) + c.help);
  }
  appendRow('dim', ' ', '');
  appendRow('dim', ' ', 'Anything else is sent to the agent. Shift+Enter for newline.');
}

function cmdReset() {
  resetDevtoolsSession();
  appendRow('ok', '✓', 'conversation reset');
}

async function cmdModel(arg) {
  if (!arg) {
    // No-arg /model shows current AND fetches the list so the user can pick.
    appendRow('info', '→', 'current model: ' + (sessionModel || '(unknown)'));
    sendToHost({ type: 'models.list' });
    appendRow('dim', '·', 'fetching available models…');
    return;
  }
  sendToHost({ type: 'models.set', id: arg });
  appendRow('dim', '·', 'requesting model switch → ' + arg);
}

async function cmdModels() {
  sendToHost({ type: 'models.list' });
  appendRow('dim', '·', 'fetching models…');
}

function cmdLogin() {
  sendToHost({ type: 'auth.signin' });
  appendRow('info', '→', 'sign-in flow started — check your browser / terminal');
}

async function cmdSessions() {
  sendToHost({ type: 'chat.list' });
  appendRow('dim', '·', 'fetching sessions…');
}

async function cmdCopy() {
  if (!lastAssistantText) return appendRow('warn', '!', 'no assistant response yet');
  try {
    await navigator.clipboard.writeText(lastAssistantText);
    appendRow('ok', '✓', 'copied ' + lastAssistantText.length + ' chars');
  } catch (e) {
    appendRow('err', '✗', 'clipboard: ' + (e?.message || e));
  }
}

function cmdVersion() {
  const m = chrome.runtime.getManifest();
  appendRow('info', '→', 'browy ' + m.version);
  appendRow('dim', '·', 'model: ' + (sessionModel || '—'));
}

function cmdTheme(arg) {
  const v = (arg || '').toLowerCase();
  if (!['', 'auto', 'dark', 'light'].includes(v)) {
    return appendRow('err', '✗', 'usage: /theme [auto|dark|light]');
  }
  document.documentElement.dataset.theme = v === '' ? 'auto' : v;
  appendRow('ok', '✓', 'theme: ' + (v || 'auto'));
}

function cmdFeedback() {
  const url = 'https://github.com/BrowyHQ/browy/issues/new';
  try { chrome.tabs.create({ url }); } catch {}
  appendRow('info', '→', url);
}

async function cmdTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    if (!tabs.length) return appendRow('dim', '·', '(no tabs)');
    for (const t of tabs.slice(0, 30)) {
      const mark = t.active ? '*' : ' ';
      const line = '[' + t.id + '] ' + (t.title || '').slice(0, 60) + '   ' + (t.url || '').slice(0, 80);
      appendRow('dim', mark, line, {
        onClick: async () => {
          try {
            await chrome.tabs.update(t.id, { active: true });
            if (t.windowId != null) await chrome.windows.update(t.windowId, { focused: true });
            appendRow('ok', '✓', 'switched to tab ' + t.id);
          } catch (e) {
            appendRow('err', '✗', String(e?.message || e));
          }
        },
      });
    }
    if (tabs.length > 30) appendRow('dim', '·', '… (' + (tabs.length - 30) + ' more)');
    appendRow('dim', ' ', '(click a row to switch)');
  } catch (e) {
    appendRow('err', '✗', String(e?.message || e));
  }
}

async function cmdSnapshot() {
  const r = await evalInPage(`(() => {
    const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
      .slice(0, 8).map(h => h.tagName.toLowerCase() + '  ' + (h.textContent||'').trim().replace(/\\s+/g,' ').slice(0,80));
    return {
      title: document.title,
      url: location.href,
      readyState: document.readyState,
      links: document.querySelectorAll('a[href]').length,
      forms: document.forms.length,
      inputs: document.querySelectorAll('input,textarea,select').length,
      headings,
    };
  })()`);
  if (r.error) return appendRow('err', '✗', r.error);
  const v = r.value || {};
  appendRow('info', '→', 'title:    ' + (v.title || '—'));
  appendRow('dim',  '·', 'url:      ' + (v.url || '—'));
  appendRow('dim',  '·', 'state:    ' + v.readyState + '   links:' + v.links + ' forms:' + v.forms + ' inputs:' + v.inputs);
  if (v.headings?.length) {
    appendRow('dim', ' ', 'headings:');
    for (const h of v.headings) appendRow('dim', ' ', '  ' + h);
  }
}

function cmdExport() {
  try {
    const lines = [];
    for (const row of $log.children) {
      const g = row.querySelector('.glyph')?.textContent || '';
      const b = row.querySelector('.body')?.textContent || '';
      lines.push((g ? g + ' ' : '') + b);
    }
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const a = document.createElement('a');
    a.href = url; a.download = 'browy-cli-' + ts + '.txt';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    appendRow('ok', '✓', 'exported ' + lines.length + ' line' + (lines.length === 1 ? '' : 's'));
  } catch (e) {
    appendRow('err', '✗', String(e?.message || e));
  }
}

async function cmdEval(arg) {
  if (!arg) return appendRow('err', '✗', 'usage: /eval <expression>');
  const r = await evalInPage(arg);
  if (r.error) appendRow('err', '✗', r.error);
  else appendRow('info', '→', formatEvalResult(r.value));
}

function setReplMode(on) {
  replMode = !!on;
  if ($promptGlyph) $promptGlyph.textContent = replMode ? REPL_PROMPT_GLYPH : DEFAULT_PROMPT_GLYPH;
  if ($cmd) $cmd.placeholder = replMode ? REPL_PLACEHOLDER : DEFAULT_PLACEHOLDER;
}

function cmdReplToggle() {
  if (replMode) {
    setReplMode(false);
    appendRow('info', 'i', 'JS REPL off — back to chat mode.');
  } else {
    setReplMode(true);
    appendRow('info', 'i', 'JS REPL on. Each line is evaluated in the inspected page. /js again to exit.');
  }
}

async function cmdDom(arg) {
  if (!arg) return appendRow('err', '✗', 'usage: /dom <css-selector>');
  const safe = JSON.stringify(arg);
  const expr = `(() => {
    try {
      const list = document.querySelectorAll(${safe});
      const rows = [];
      for (let i = 0; i < Math.min(list.length, 5); i++) {
        const e = list[i];
        const tag = e.tagName.toLowerCase();
        const id  = e.id ? '#' + e.id : '';
        const cls = (typeof e.className === 'string' && e.className)
          ? '.' + e.className.split(/\\s+/).filter(Boolean).slice(0,2).join('.') : '';
        const text = (e.textContent || '').trim().replace(/\\s+/g,' ').slice(0, 60);
        rows.push('<' + tag + id + cls + '>' + (text ? '  ' + text : ''));
      }
      return { count: list.length, rows };
    } catch (err) { return { error: String(err) }; }
  })()`;
  const r = await evalInPage(expr);
  if (r.error)        return appendRow('err', '✗', r.error);
  if (r.value?.error) return appendRow('err', '✗', r.value.error);
  appendRow('ok', '→', r.value.count + ' match' + (r.value.count === 1 ? '' : 'es') + ' for ' + arg);
  for (const row of r.value.rows) appendRow('dim', '·', row);
  if (r.value.count > r.value.rows.length) appendRow('dim', '·', '… (' + (r.value.count - r.value.rows.length) + ' more)');
}

function cmdInputHistory() {
  if (!cmdHistory.length) return appendRow('dim', '·', '(empty)');
  for (const h of cmdHistory.slice(-20)) appendRow('dim', '›', h);
}

async function evalAndPrint(expr) {
  const r = await evalInPage(expr);
  r.error ? appendRow('err', '✗', r.error) : appendRow('info', '→', String(r.value));
}

async function handleSlash(line) {
  const sp = line.indexOf(' ');
  const name = (sp === -1 ? line : line.slice(0, sp)).toLowerCase();
  const arg  = sp === -1 ? '' : line.slice(sp + 1).trim();
  // Aliases: /? → /help, /models → /model
  const aliasMap = { '/?': '/help', '/models': '/model' };
  const resolved = aliasMap[name] || name;
  const cmd = COMMANDS.find(c => c.name === resolved);
  if (!cmd) return appendRow('err', '✗', 'unknown command: ' + name + ' — try /help');
  try { await cmd.run(arg); } catch (e) { appendRow('err', '✗', String(e?.message || e)); }
}

// ── Inspected window helpers ─────────────────────────────────────────────

function evalInPage(expr) {
  return new Promise((resolve) => {
    chrome.devtools.inspectedWindow.eval(expr, (value, exception) => {
      if (exception) {
        const msg = exception.value || exception.description || String(exception);
        resolve({ value: null, error: String(msg) });
      } else {
        resolve({ value, error: null });
      }
    });
  });
}

function formatEvalResult(v) {
  if (v === undefined) return 'undefined';
  if (v === null)      return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    const s = JSON.stringify(v, null, 2);
    return s && s.length > 2000 ? s.slice(0, 2000) + '\n… (truncated)' : (s ?? String(v));
  } catch { return String(v); }
}

async function refreshPageMeta() {
  const r = await evalInPage('location.href');
  if (!r.error && r.value) {
    let host = r.value;
    try { host = new URL(r.value).host || r.value; } catch {}
    $page.textContent = host;
    $page.title = r.value;
  }
}

// ── Port wiring (background.js) ──────────────────────────────────────────

// Unique per panel instance. A constant name meant two DevTools panels open on
// two different tabs collided on the same key in the background's client map,
// so replies reached only the most recently opened one.
const PORT_NAME = 'devtools-panel-' + Math.random().toString(36).slice(2, 10);
const port = chrome.runtime.connect({ name: PORT_NAME });

function sendToHost(msg) {
  try { port.postMessage(msg); } catch (e) { appendRow('err', '✗', 'send failed: ' + (e?.message || e)); }
}

port.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case '__host_pending':
      appendRow('dim', '·', 'starting host…');
      break;
    case '__host_ready':
      hostReady = true;
      if (!sessionStarted) {
        sessionStarted = true;
        appendRow('dim', '·', 'host ready' + (msg.serverVersion ? ' v' + msg.serverVersion : ''));
        // Wait for the persisted id so we resume the previous DevTools chat
        // instead of starting a throwaway one.
        sessionIdReady.then(() => {
          sendToHost({
            type: 'session.start',
            sessionId: SESSION_ID,
            inspectedTabId: inspectedTabId,
            capabilities: ['cdp.activeTab'],
          });
        });
      }
      break;
    case '__host_disconnected':
    case '__host_error':
      appendRow('err', '✗', 'host disconnected: ' + (msg.message || '?'));
      hostReady = false;
      sessionStarted = false;
      setBusy(false);
      break;
    case '__host_missing':
      appendRow('err', '✗', 'browy backend not installed. install: https://browyhq.github.io/install/');
      hostReady = false;
      sessionStarted = false;
      setBusy(false);
      break;
    case '__host_stale':
      appendRow('err', '✗', 'browy backend installed but does not trust this extension. upgrade: https://browyhq.github.io/install/');
      hostReady = false;
      sessionStarted = false;
      setBusy(false);
      break;

    case 'session.ready':
      sessionModel = msg.model || '';
      $model.textContent = sessionModel || '—';
      $model.title = sessionModel || '';
      appendRow('dim', '·', 'session ready · ' + sessionModel);
      break;

    case 'chat.delta':
      appendDelta(msg.text || '');
      break;

    case 'chat.tool_call':
      // Insert a paragraph break in the live stream so post-tool text
      // doesn't get glued onto pre-tool text ("…tool:And check…").
      if (liveBodyEl && liveText && !liveText.endsWith('\n\n')) {
        liveText += '\n\n';
        liveBodyEl.textContent = liveText;
      }
      appendToolCard(msg.callId, msg.tool, msg.args || {});
      break;

    case 'chat.tool_result':
      completeToolCard(msg.callId, !!msg.ok, msg.summary, msg.durationMs);
      break;

    case 'chat.done':
      finalizeLiveAssistant(msg.text || '');
      setBusy(false);
      break;

    case 'chat.error':
      // If we created a streaming row but never got any text (immediate
      // error like "busy"), drop the empty row instead of leaving a
      // dangling assistant bubble.
      if (liveRowEl && !liveText) {
        liveRowEl.remove();
        liveRowEl = null;
        liveBodyEl = null;
        liveText = '';
      } else {
        finalizeLiveAssistant('');
      }
      appendRow('err', '✗', msg.message || 'error');
      setBusy(false);
      break;

    case 'auth.status':
      if (msg.state && msg.state !== 'ok' && msg.state !== 'ready') {
        appendRow('warn', '!', 'auth: ' + msg.state + (msg.detail ? ' · ' + msg.detail : ''));
      }
      break;

    case 'models.list':
      modelsCache = msg.models || [];
      if (!modelsCache.length) {
        appendRow('dim', '·', '(no models reported)');
      } else {
        appendRow('info', '→', modelsCache.length + ' model' + (modelsCache.length === 1 ? '' : 's') + ' (click to switch):');
        const w = Math.max(...modelsCache.map(m => m.id.length));
        for (const m of modelsCache) {
          const isCur = m.id === sessionModel;
          const mark = isCur ? '●' : ' ';
          const line = m.id.padEnd(w + 2) + (m.name || '') + (m.vendor ? '  (' + m.vendor + ')' : '');
          appendRow(isCur ? 'ok' : 'dim', mark, line, {
            onClick: () => {
              if (m.id === sessionModel) return;
              sendToHost({ type: 'models.set', id: m.id });
              appendRow('dim', '·', 'requesting model switch → ' + m.id);
            },
          });
        }
        appendRow('dim', ' ', 'or type: /model <id>');
      }
      break;

    case 'models.current':
      sessionModel = msg.id || sessionModel;
      $model.textContent = sessionModel || '—';
      $model.title = sessionModel || '';
      appendRow('ok', '✓', 'model → ' + sessionModel);
      break;

    case 'chat.list.result':
      chatsCache = msg.chats || [];
      if (!chatsCache.length) {
        appendRow('dim', '·', '(no recent sessions)');
      } else {
        appendRow('info', '→', chatsCache.length + ' session' + (chatsCache.length === 1 ? '' : 's') + ' (click to view transcript):');
        for (const c of chatsCache.slice(0, 20)) {
          const when = new Date(c.modifiedTime || c.startTime || Date.now());
          const ago = relTime(when);
          const summary = (c.summary || '(no summary)').slice(0, 60);
          appendRow('dim', '·', ago.padEnd(10) + c.id.slice(0, 8) + '  ' + summary, {
            onClick: () => {
              sendToHost({ type: 'chat.history', id: c.id });
              appendRow('dim', '·', 'fetching transcript ' + c.id.slice(0, 8) + '…');
            },
          });
        }
      }
      break;

    case 'chat.history.result': {
      const messages = msg.messages || [];
      if (!messages.length) {
        appendRow('dim', '·', '(empty transcript)');
      } else {
        appendRow('info', '→', 'transcript ' + (msg.id || '').slice(0, 8) + ' — ' + messages.length + ' msg' + (messages.length === 1 ? '' : 's') + ':');
        for (const m of messages.slice(-30)) {
          if (m.role === 'tool') {
            appendRow('dim', m.ok ? '✓' : '✗', m.name + (m.summary ? '  ' + String(m.summary).slice(0, 100) : ''));
          } else {
            const text = String(m.text || '').replace(/\s+/g, ' ').slice(0, 200);
            appendRow('dim', m.role === 'user' ? '›' : '◂', text);
          }
        }
        if (messages.length > 30) appendRow('dim', '·', '… (' + (messages.length - 30) + ' earlier)');
      }
      break;
    }
  }
});

function relTime(d) {
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60)    return Math.floor(s) + 's ago';
  if (s < 3600)  return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

// ── Submit ───────────────────────────────────────────────────────────────

async function submit() {
  const text = $cmd.value.trim();
  if (!text || busy) return;
  $cmd.value = '';
  autoresize();
  cmdHistory.push(text);
  if (cmdHistory.length > 200) cmdHistory.shift();
  cmdIdx = cmdHistory.length;
  cmdDraft = '';

  appendRow('user', replMode ? 'js>' : '›', text);

  if (text.startsWith('/')) {
    try { await handleSlash(text); } catch (e) { appendRow('err', '✗', String(e)); }
    return;
  }

  if (replMode) {
    const r = await evalInPage(text);
    if (r.error) appendRow('err', '✗', r.error);
    else appendRow('info', '→', formatEvalResult(r.value));
    return;
  }

  if (!hostReady) {
    appendRow('warn', '!', 'host not ready yet — message queued');
  }

  setBusy(true);
  startLiveAssistant();
  sendToHost({ type: 'chat.send', sessionId: SESSION_ID, text });
}

// ── Input handling ───────────────────────────────────────────────────────

function autoresize() {
  $cmd.style.height = 'auto';
  $cmd.style.height = Math.min($cmd.scrollHeight, 120) + 'px';
}

// ── Autocomplete (slash commands) ────────────────────────────────────────

function updateAutocomplete() {
  const v = $cmd.value;
  // Only autocomplete when the buffer starts with '/' AND we're on the first line.
  if (!v.startsWith('/') || v.includes('\n') || v.includes(' ')) {
    return closeAutocomplete();
  }
  const q = v.toLowerCase();
  acItems = COMMANDS.filter(c => c.name.startsWith(q));
  if (!acItems.length) return closeAutocomplete();
  acIdx = 0;
  acOpen = true;
  renderAutocomplete();
  $ac.classList.remove('hidden');
}

function renderAutocomplete() {
  $ac.replaceChildren();
  acItems.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'ac-item' + (i === acIdx ? ' sel' : '');
    el.innerHTML = '';
    const n = document.createElement('span'); n.className = 'name'; n.textContent = c.name;
    const d = document.createElement('span'); d.className = 'desc'; d.textContent = c.help;
    el.appendChild(n); el.appendChild(d);
    el.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      acIdx = i;
      acceptAutocomplete();
    });
    $ac.appendChild(el);
  });
}

function acceptAutocomplete() {
  if (!acOpen || !acItems[acIdx]) return;
  const picked = acItems[acIdx];
  // If exact match (i.e., user typed full name + we just confirmed) — submit.
  // Otherwise complete and add a trailing space so they can type args.
  if ($cmd.value.toLowerCase() === picked.name) {
    closeAutocomplete();
    submit();
  } else {
    $cmd.value = picked.name + ' ';
    closeAutocomplete();
    autoresize();
  }
}

function closeAutocomplete() {
  if (!acOpen) return;
  acOpen = false;
  acItems = [];
  $ac.classList.add('hidden');
  $ac.replaceChildren();
}

$cmd.addEventListener('input', () => {
  autoresize();
  if (cmdIdx === cmdHistory.length) cmdDraft = $cmd.value;
  updateAutocomplete();
});

$cmd.addEventListener('blur', () => closeAutocomplete());

$cmd.addEventListener('keydown', (e) => {
  // Autocomplete navigation first
  if (acOpen) {
    if (e.key === 'ArrowDown') { e.preventDefault(); acIdx = (acIdx + 1) % acItems.length; renderAutocomplete(); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); acIdx = (acIdx - 1 + acItems.length) % acItems.length; renderAutocomplete(); return; }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault();
      acceptAutocomplete();
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); closeAutocomplete(); return; }
  }

  // Enter (no shift) → submit. Shift+Enter → newline.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
    return;
  }

  // History — only if cursor is on the first/last logical line
  if (e.key === 'ArrowUp' && !e.shiftKey && cmdHistory.length) {
    const beforeCursor = $cmd.value.slice(0, $cmd.selectionStart);
    if (!beforeCursor.includes('\n')) {
      e.preventDefault();
      if (cmdIdx === cmdHistory.length) cmdDraft = $cmd.value;
      cmdIdx = Math.max(0, cmdIdx - 1);
      $cmd.value = cmdHistory[cmdIdx] ?? '';
      autoresize();
      requestAnimationFrame(() => $cmd.setSelectionRange($cmd.value.length, $cmd.value.length));
    }
    return;
  }
  if (e.key === 'ArrowDown' && !e.shiftKey && cmdHistory.length) {
    const afterCursor = $cmd.value.slice($cmd.selectionEnd);
    if (!afterCursor.includes('\n')) {
      e.preventDefault();
      cmdIdx = Math.min(cmdHistory.length, cmdIdx + 1);
      $cmd.value = cmdIdx === cmdHistory.length ? cmdDraft : (cmdHistory[cmdIdx] ?? '');
      autoresize();
    }
    return;
  }

  if (e.key === 'l' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    clearLog();
    return;
  }

  if (e.key === 'k' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    clearLog();
    return;
  }

  if (e.key === 'Escape' && busy) {
    e.preventDefault();
    sendToHost({ type: 'chat.cancel', sessionId: SESSION_ID });
    appendRow('warn', '!', 'cancel requested');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.activeElement !== $cmd) {
    $cmd.focus();
  }
});

$log.addEventListener('click', (e) => {
  if (window.getSelection()?.toString()) return;
  if (e.target.tagName === 'BUTTON') return;
  $cmd.focus();
});

$btnClear.addEventListener('click', () => { clearLog(); $cmd.focus(); });
$btnReset.addEventListener('click', () => {
  resetDevtoolsSession();
  appendRow('ok', '✓', 'conversation reset');
  $cmd.focus();
});

// ── DevTools event hooks ─────────────────────────────────────────────────

chrome.devtools.network.onNavigated.addListener(() => {
  refreshPageMeta();
});

// ── Boot ─────────────────────────────────────────────────────────────────

(function boot() {
  appendRow('banner', '~', 'Browy CLI — type /help for commands');
  refreshPageMeta();
  $cmd.focus();
})();
