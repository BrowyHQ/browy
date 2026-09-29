// Regression tests for the first-run screen and the host-version check.
//
// What these guard against:
//   - A user without the backend saw a red one-line banner over a disabled
//     input. The first-run screen replaces it and polls for the backend, and
//     that polling must never flicker: a probe against a missing host must
//     leave the screen on "waiting", never on "starting".
//   - The Web Store auto-updates the extension but nothing updates the host,
//     and PROTOCOL_VERSION sat at 1 through three protocol additions. The
//     extension now compares the host's protocol against a minimum, so the
//     constants on both sides must stay in step.
//
// Everything is pulled out of the real source files rather than copied, so
// these fail if the implementation drifts.
//
// Run: node tests/onboarding.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
// Normalise line endings: the working tree is CRLF on Windows checkouts.
const read = (p) => readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const sidepanel = read('extension/sidepanel.js');
const background = read('extension/background.js');
const panel = read('extension/panel.js');
const options = read('extension/options.js');
const protocolTs = read('src/protocol.ts');
const nativeHost = read('src/native-host.ts');
const build = read('build.mjs');

const failures = [];
let count = 0;
const check = (name, cond) => { count++; if (!cond) failures.push(name); };

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found`);
  const end = src.indexOf('\n}', start) + 2;
  return src.slice(start, end);
}
const fnFrom = (src, name) => new Function(`${extractFn(src, name)}; return ${name};`)();

// ── osKey ──────────────────────────────────────────────────────────────────
{
  const osKey = fnFrom(sidepanel, 'osKey');
  check('osKey: win', osKey('win', '') === 'win');
  check('osKey: mac uses the shell installer', osKey('mac', '') === 'unix');
  check('osKey: linux uses the shell installer', osKey('linux', '') === 'unix');
  check('osKey: chromeos is its own case (no backend possible)', osKey('cros', '') === 'cros');
  check('osKey: falls back to navigator.platform when the API is missing', osKey('', 'Win32') === 'win');
  check('osKey: navigator fallback for mac', osKey(undefined, 'MacIntel') === 'unix');
}

// ── isRestrictedUrl ────────────────────────────────────────────────────────
{
  const isRestrictedUrl = fnFrom(sidepanel, 'isRestrictedUrl');
  check('restricted: the Chrome Web Store (where a fresh install lands)',
    isRestrictedUrl('https://chromewebstore.google.com/detail/iondecjdokngnlkfpipgolgkfegpmjca') === true);
  check('restricted: legacy web store path', isRestrictedUrl('https://chrome.google.com/webstore/detail/x') === true);
  check('restricted: Edge add-ons', isRestrictedUrl('https://microsoftedge.microsoft.com/addons/detail/x') === true);
  check('restricted: new tab page', isRestrictedUrl('chrome://newtab/') === true);
  check('restricted: edge:// pages', isRestrictedUrl('edge://settings') === true);
  check('restricted: garbage', isRestrictedUrl('') === true);
  check('allowed: an ordinary https page', isRestrictedUrl('https://en.wikipedia.org/wiki/Web_browser') === false);
  check('allowed: other google.com pages', isRestrictedUrl('https://chrome.google.com/') === false);
  check('allowed: http', isRestrictedUrl('http://localhost:3000/') === false);
}

// ── suggestions survive the empty state being detached ─────────────────────
// #empty leaves the DOM as soon as a chat has messages. A getElementById
// lookup then returns null and the update is silently skipped, which brought
// the suggestions back on the next new chat after the first send.
check('try: updateTrySuggestions uses cached element refs, not DOM lookups',
  !/getElementById|querySelector/.test(extractFn(sidepanel, 'updateTrySuggestions')));

// ── shouldOfferHostUpdate ──────────────────────────────────────────────────
{
  const offer = fnFrom(sidepanel, 'shouldOfferHostUpdate');
  const now = 1_000_000;
  check('update: protocol-1 host is offered an update', offer(1, 2, 0, now) === true);
  check('update: current host is left alone', offer(2, 2, 0, now) === false);
  check('update: newer host is left alone', offer(3, 2, 0, now) === false);
  check('update: a host that reports no protocol is treated as old', offer(undefined, 2, 0, now) === true);
  check('update: "later" hides it while the snooze runs', offer(1, 2, now + 1, now) === false);
  check('update: and it comes back once the snooze expires', offer(1, 2, now - 1, now) === true);
}

// ── constants stay in step across host and extension ───────────────────────
{
  const num = (src, re) => { const m = src.match(re); return m ? Number(m[1]) : NaN; };
  const hostProto = num(protocolTs, /export const PROTOCOL_VERSION = (\d+);/);
  const bgProto = num(background, /const PROTOCOL = (\d+);/);
  const spMin = num(sidepanel, /const MIN_HOST_PROTOCOL = (\d+);/);
  const dtMin = num(panel, /const MIN_HOST_PROTOCOL = (\d+);/);
  const optMin = num(options, /m\.protocol >= (\d+)/);
  check('protocol: host PROTOCOL_VERSION was bumped past 1', hostProto >= 2);
  check('protocol: background hello speaks the host protocol', bgProto === hostProto);
  check('protocol: side panel minimum is satisfiable by the current host', spMin <= hostProto);
  check('protocol: DevTools panel minimum matches the side panel', dtMin === spMin);
  check('protocol: options page minimum matches the side panel', optMin === spMin);
  check('version: host no longer hard-codes 0.3.0', !/SERVER_VERSION = '0\.3\.0'/.test(nativeHost));
  check('version: build injects the package version', /__BROWY_VERSION__:\s*JSON\.stringify\(pkg\.version\)/.test(build));
  check('version: background forwards the protocol with __host_ready',
    /type: '__host_ready', serverVersion: msg\.serverVersion, protocol: nativeProtocol/.test(background));
}

// ── background: a probe must never emit __host_pending ─────────────────────
{
  const i = background.indexOf("if (msg.type === '__retry_host')");
  const block = i === -1 ? '' : background.slice(i, background.indexOf('\n    }\n', i));
  check('retry: background handles __retry_host', i !== -1);
  check('retry: probing does not broadcast __host_pending (would flash the booting UI)',
    block && !block.includes('__host_pending'));
  check('retry: probing reuses ensureNativeHost', block.includes('ensureNativeHost()'));
}

// ── the first-run screen's state machine, driven for real ──────────────────
{
  const start = sidepanel.indexOf('let onboardMode = null;');
  const end = sidepanel.indexOf('// ── Host-update banner');
  if (start === -1 || end === -1) throw new Error('first-run block not found in sidepanel.js');
  const block = sidepanel.slice(start, end);

  // Fake timers.
  let now = 0, nextId = 1;
  const timers = new Map();
  const setT = (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; };
  const setI = (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn, every: ms }); return id; };
  const clr = (id) => { timers.delete(id); };
  const advance = (ms) => {
    const until = now + ms;
    for (;;) {
      let due = null;
      for (const [id, t] of timers) if (t.at <= until && (!due || t.at < due[1].at)) due = [id, t];
      if (!due) break;
      const [id, t] = due;
      now = t.at;
      if (t.every) t.at += t.every; else timers.delete(id);
      t.fn();
    }
    now = until;
  };

  // Fake DOM: just enough for the screen.
  const mkEl = () => ({
    textContent: '', dataset: {}, attrs: {},
    classes: new Set(),
    classList: {
      add(c) { this._o.classes.add(c); }, remove(c) { this._o.classes.delete(c); },
      contains(c) { return this._o.classes.has(c); },
    },
    setAttribute(k, v) { this.attrs[k] = v; },
  });
  const els = {};
  for (const id of ['onboard', 'obTitle', 'obWhy', 'obCmd', 'obWhere', 'obStatus']) {
    const e = mkEl(); e.classList._o = e; els[id] = e;
  }
  const osButtons = ['win', 'unix'].map((os) => { const b = mkEl(); b.classList._o = b; b.dataset.os = os; return b; });
  els.onboard.querySelectorAll = () => osButtons;
  const doc = { getElementById: (id) => els[id] || null, visibilityState: 'visible' };

  // Fake service worker + Chrome: while no host is installed, every probe is
  // answered with a "missing" verdict a few milliseconds later. Once the user
  // has installed it ('booting'), the host process runs and says nothing
  // until it finishes starting.
  const posted = [];
  let world = 'missing';
  let apiRef = null;
  const bgPort = {
    postMessage: (m) => {
      posted.push(m);
      if (m.type === '__retry_host' && world === 'missing') setT(() => apiRef.showOnboarding('missing'), 5);
    },
  };
  let base = 'idle';

  const INSTALL_CMDS = { win: 'WIN-CMD', unix: 'UNIX-CMD' };
  const osKey = fnFrom(sidepanel, 'osKey');
  const chromeStub = { runtime: { getPlatformInfo: async () => ({ os: 'win' }) } };

  const api = new Function(
    'document', 'chrome', 'navigator', 'bgPort', 'INSTALL_CMDS', 'osKey',
    'setBase', 'hideConnBanner', 'hideHostUpdateBanner',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date',
    `${block}
     return {
       showOnboarding, hideOnboarding, probeHost, setOnboardPhase,
       setOs: (os) => { detectedOs = os; },
       state: () => ({ onboardMode, obPhase, onboardOs, polling: !!obPollTimer, guessArmed: !!obProbeTimer }),
     };`,
  )(doc, chromeStub, { platform: 'Win32' }, bgPort, INSTALL_CMDS, osKey,
    (p) => { base = p; }, () => {}, () => {},
    setT, clr, setI, clr, { now: () => now });
  apiRef = api;
  api.setOs('win');
  const probes = () => posted.filter((m) => m.type === '__retry_host').length;

  // A missing host: the screen opens on the right OS and starts polling.
  api.showOnboarding('missing');
  let s = api.state();
  check('onboard: opens', els.onboard.classes.has('open'));
  check('onboard: mascot sleeps while there is no backend', base === 'sleep');
  check('onboard: shows the Windows command on Windows', els.obCmd.textContent === 'WIN-CMD');
  check('onboard: title asks to install', /install/.test(els.obTitle.textContent));
  check('onboard: starts on "waiting"', s.obPhase === 'waiting');
  check('onboard: polls for the backend', s.polling === true);

  advance(4000);
  check('onboard: a poll sends __retry_host', probes() === 1);
  check('onboard: an auto-poll does not flash "checking"', api.state().obPhase === 'waiting');
  advance(3000);
  check('onboard: the "missing" verdict cancels the "starting" guess, so no flicker', api.state().obPhase === 'waiting');

  advance(40000);
  check('onboard: keeps polling', probes() >= 10);
  check('onboard: stays on "waiting" across repeated probes', api.state().obPhase === 'waiting');

  // The manual button gives visible feedback even though the verdict comes
  // back in milliseconds, then settles.
  api.probeHost(true);
  check('onboard: "check again" shows checking…', api.state().obPhase === 'checking');
  advance(10);
  check('onboard: "checking…" survives the instant verdict long enough to be seen', api.state().obPhase === 'checking');
  advance(1000);
  check('onboard: and then settles back to waiting', api.state().obPhase === 'waiting');

  // User runs the installer: the next probe spawns a real host, silent while it boots.
  world = 'booting';
  advance(4000 + 2600);
  check('onboard: no verdict within 2.5 s means a host is starting', api.state().obPhase === 'starting');
  check('onboard: status says so', /starting/.test(els.obStatus.textContent));
  advance(8000);
  check('onboard: later polls keep it on "starting"', api.state().obPhase === 'starting');

  // The host answers.
  const wasShowing = api.hideOnboarding();
  s = api.state();
  check('onboard: hideOnboarding reports it was showing', wasShowing === true);
  check('onboard: closes', !els.onboard.classes.has('open'));
  check('onboard: stops polling', s.polling === false && s.guessArmed === false);
  check('onboard: mascot wakes up', base === 'idle');
  const before = posted.length;
  advance(20000);
  check('onboard: no probes after the backend connects', posted.length === before);
  check('onboard: hiding twice is a no-op', api.hideOnboarding() === false);

  // A stale host gets update wording, not install wording.
  api.showOnboarding('stale');
  check('onboard: stale host is asked to update', /update/.test(els.obTitle.textContent));
  api.hideOnboarding();

  // ChromeOS: explain, don't poll for something that can't exist.
  api.setOs('cros');
  api.showOnboarding('missing');
  const cr = posted.length;
  advance(12000);
  check('onboard: chromeos says why instead of offering a command', /windows, macos or linux/.test(els.obTitle.textContent));
  check('onboard: chromeos never probes', posted.length === cr);
  api.hideOnboarding();
}

if (failures.length) {
  console.error('FAIL:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
console.log(`PASS — first-run screen and host-version contract (${count} assertions)`);
