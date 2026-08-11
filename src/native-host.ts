#!/usr/bin/env node
// Browy Native Messaging Host entry point.
//
// Chrome spawns this process when an extension calls
// chrome.runtime.connectNative('com.browy.host'). We expose the same Browy
// agent core over Chrome's stdio framing — no UI, no CLI prompts, no extra
// transports. When the extension disconnects, Chrome closes our stdin and
// we exit cleanly.
//
// Logging gotcha: Chrome reads stdout looking for framed messages. ANY
// stray write to stdout (console.log, process.stdout.write) corrupts the
// stream and Chrome will silently disconnect the port. ALL diagnostic
// output MUST go to stderr or a log file.
//
// To survive third-party `console.log` calls (playwright, the agent's own
// progress logs, etc.) we redirect every console.* method to stderr BEFORE
// importing anything else. The NativeMessagingTransport writes framed bytes
// directly via `process.stdout.write(buffer)`, which still works.
{
  // Hook console.* into a per-day debug log so the agent's progress
  // messages (createSession, listChats, copilot SDK init, …) survive.
  // We can't reference logStream here because this runs before fs imports
  // resolve, so we open a second stream lazily on first use.
  let consoleStream: any = null;
  const ensureStream = () => {
    if (consoleStream) return consoleStream;
    try {
      const fs2 = require('fs');
      const os2 = require('os');
      const path2 = require('path');
      const dir = path2.join(os2.homedir(), '.browseragent');
      try { fs2.mkdirSync(dir, { recursive: true }); } catch {}
      const logPath = path2.join(dir, 'native-host.log');
      // Cap log file at 5MB; keep one rotated copy. Anything else gets nuked.
      // Cheap to do once at startup; native-host process is short-lived
      // (one per Chrome connection) so we don't need fancy mid-run rotation.
      try {
        const st = fs2.statSync(logPath);
        if (st.size > 5 * 1024 * 1024) {
          try { fs2.renameSync(logPath, logPath + '.1'); } catch {}
        }
      } catch { /* file may not exist yet */ }
      consoleStream = fs2.createWriteStream(logPath, { flags: 'a' });
    } catch { consoleStream = { write: () => {} }; }
    return consoleStream;
  };
  const w = (chunk: unknown) => {
    const s = typeof chunk === 'string' ? chunk : String(chunk);
    try { process.stderr.write(s); } catch {}
    try { ensureStream().write(s); } catch {}
  };
  // eslint-disable-next-line no-console
  console.log = (...args) => w(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n');
  // eslint-disable-next-line no-console
  console.info = console.log;
  // eslint-disable-next-line no-console
  console.warn = console.log;
  // eslint-disable-next-line no-console
  console.debug = console.log;
  // eslint-disable-next-line no-console
  console.error = console.log;
}

import { Agent } from './agent/loop.js';
import { Runner } from './agent/runner.js';
import { loadConfig } from './config.js';
import { NativeMessagingTransport } from './transports/native-messaging.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execSync, exec } from 'child_process';

const SERVER_VERSION = '0.3.0';

// ── Logger to file (stdout is sacred for native messaging) ─────────────────
const LOG_DIR = path.join(os.homedir(), '.browseragent');
let logStream: fs.WriteStream | null = null;
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  logStream = fs.createWriteStream(path.join(LOG_DIR, 'native-host.log'), { flags: 'a' });
} catch { /* if we can't log, just run silently */ }

function log(...args: unknown[]) {
  const line = `[${new Date().toISOString()}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`;
  try { logStream?.write(line); } catch {}
  // stderr is fine — Chrome ignores it.
  try { process.stderr.write(line); } catch {}
}

// ── Auth helpers (mirror cli.ts) ───────────────────────────────────────────
// Cached: the probe shells out (cmdkey / security), and pushInitialState runs
// it on EVERY session.start. execSync there blocks the whole event loop, which
// on a cold start is exactly when we can least afford it.
let authProbeCache: { value: 'ready' | 'unauth' | 'unknown'; at: number } | null = null;
const AUTH_PROBE_TTL_MS = 30_000;

function probeCopilotAuthUncached(): 'ready' | 'unauth' | 'unknown' {
  try {
    if (process.platform === 'win32') {
      const out = execSync('cmdkey /list', { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] });
      const found = /copilot-cli\//i.test(out);
      log('auth probe (win32 cmdkey): copilot-cli credential', found ? 'FOUND → ready' : 'NOT FOUND → unauth');
      return found ? 'ready' : 'unauth';
    }
    if (process.platform === 'darwin') {
      try {
        execSync(`security find-generic-password -s 'copilot-cli/https://github.com'`, { stdio: 'ignore' });
        return 'ready';
      } catch { return 'unauth'; }
    }
  } catch (e) {
    log('auth probe threw:', String(e));
  }
  return 'unknown';
}

function probeCopilotAuth(): 'ready' | 'unauth' | 'unknown' {
  const now = Date.now();
  if (authProbeCache && now - authProbeCache.at < AUTH_PROBE_TTL_MS) {
    return authProbeCache.value;
  }
  const value = probeCopilotAuthUncached();
  authProbeCache = { value, at: now };
  return value;
}

/** Invalidate the cache after an explicit sign-in attempt so the next probe
 *  reflects reality rather than a stale pre-sign-in reading. */
function invalidateAuthProbeCache(): void {
  authProbeCache = null;
}

/** Locate the Copilot CLI entry point that actually ships with Browy.
 *
 *  COPILOT_CLI_PATH / BROWY_NODE_PATH are read here but NOTHING in the repo
 *  ever set them, so every platform silently fell through to bare `copilot`
 *  on PATH. On a clean machine that binary does not exist — the bundled one
 *  lives under our own node_modules and is never linked into the user's
 *  shell — so clicking "Sign in to GitHub Copilot" opened a terminal that
 *  printed `command not found: copilot`. We now resolve the bundled entry
 *  point relative to this file and only fall back to PATH as a last resort.
 */
function resolveCopilotCli(): string | undefined {
  const explicit = process.env.COPILOT_CLI_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Staged layout: ~/.browy/app/dist/native-host.js → ~/.browy/app/node_modules
    path.join(here, '..', 'node_modules', '@github', 'copilot', 'index.js'),
    // Dev layout: <repo>/dist/native-host.js → <repo>/node_modules
    path.join(here, '..', '..', 'node_modules', '@github', 'copilot', 'index.js'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* keep trying */ }
  }
  return undefined;
}

function openCopilotSignInTerminal(): boolean {
  const copilotCli = resolveCopilotCli();
  const nodeBin = process.env.BROWY_NODE_PATH || process.execPath;
  invalidateAuthProbeCache();
  log('sign-in: copilotCli=', copilotCli || '(not found — falling back to PATH)', 'node=', nodeBin);
  try {
    if (process.platform === 'win32') {
      // If we know an exact CLI path use it; otherwise just invoke `copilot`
      // from PATH (works when the user has @github/copilot installed globally).
      const cmd = copilotCli
        ? `start "Browy — Copilot Sign-In" cmd /k ""${nodeBin}" "${copilotCli}""`
        : `start "Browy — Copilot Sign-In" cmd /k "copilot"`;
      log('opening sign-in terminal:', cmd);
      exec(cmd, { shell: 'cmd.exe' }, (err: unknown) => {
        if (err) log('sign-in terminal exec error:', String(err));
      });
      return true;
    }
    if (process.platform === 'darwin') {
      // Terminal's `do script` takes a shell command as an AppleScript string,
      // so inner double quotes must be escaped for AppleScript and the whole
      // -e argument single-quoted for the shell.
      const target = copilotCli ? `${shQuote(nodeBin)} ${shQuote(copilotCli)}` : 'copilot';
      const apple = `tell application "Terminal"
        activate
        do script ${jsonForAppleScript(target)}
      end tell`;
      exec(`osascript -e '${apple.replace(/'/g, "'\\''")}'`, (err: unknown) => {
        if (err) log('sign-in terminal osascript error:', String(err));
      });
      return true;
    }
    const target = copilotCli ? `${shQuote(nodeBin)} ${shQuote(copilotCli)}` : 'copilot';
    exec(`x-terminal-emulator -e ${target} || gnome-terminal -- ${target} || xterm -e ${target}`, () => {});
    return true;
  } catch (e) {
    log('openCopilotSignInTerminal threw:', String(e));
    return false;
  }
}

/** POSIX single-quote escaping — safe for paths containing spaces or quotes. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** AppleScript string literal (double-quoted, backslash-escaped). */
function jsonForAppleScript(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
async function main() {
  log('native-host starting; node=', process.execPath, 'cwd=', process.cwd());

  const config = loadConfig();
  const agent = new Agent(config);

  // Ensure stdin is in the right mode for binary framing.
  if (process.stdin.isTTY) {
    log('refusing to run on a TTY (this binary expects native-messaging stdio).');
    log('to test interactively, use:  browy serve  (WebSocket frontend instead).');
    process.exit(2);
  }

  const transport = new NativeMessagingTransport();
  const runner = new Runner(agent, {
    serverVersion: SERVER_VERSION,
    authProbe: probeCopilotAuth,
    authSignin: openCopilotSignInTerminal,
  });

  // Kick off Copilot init BEFORE attaching the transport. The panel sends
  // `session.start` the instant the port connects, which triggers
  // pushInitialState → listModels(). If `copilotReady` isn't set yet,
  // whenCopilotReady() is a no-op and listModels returns []. The UI then
  // shows an empty model list / no auth info until the first chat send
  // (which awaits init properly). Setting the promise first guarantees
  // every consumer waits for real data.
  const initPromise = agent.initCopilot()
    .then(() => {
      log('copilot SDK initialised');
      runner.notifyAuth('ready');
      // Tell every attached panel the SDK is actually usable now. Until this
      // lands, chat.list and models.list both come back empty, which the UI
      // would otherwise render as "no past chats yet".
      try { runner.markSdkReady(true); } catch {}
      // Broadcast models to any panel that attached before init finished.
      // Their initial pushInitialState already returned [] because they
      // beat the init; this gives them a real list without a refresh.
      agent.listModels().then((models) => {
        try { runner.broadcast({ type: 'models.list', models }); } catch {}
        try { runner.broadcast({ type: 'models.current', id: agent.getModel() }); } catch {}
      }).catch(() => {});
    })
    .catch((e) => {
      const m = e instanceof Error ? e.message : String(e);
      log('copilot init failed:', m);
      try { runner.markSdkReady(false, m); } catch {}
      runner.notifyAuth('unauth', m);
    });

  runner.attach(transport);
  transport.onClose(() => {
    log('transport closed; exiting');
    agent.disconnect().finally(() => process.exit(0));
  });

  // NOTE: we deliberately do NOT call agent.connect() here.
  //
  // Phase E landed: the extension owns the browser via chrome.debugger and
  // routes CDP through ExtensionContext, so the host never needs a playwright
  // connection of its own. Calling connect() anyway meant every host start
  // fired three parallel chromium.connectOverCDP attempts (1.5s timeout each)
  // plus a fallback — all guaranteed to fail in the normal extension flow —
  // and, on the rare occasion one succeeded, started a 2s setInterval
  // rediscovery loop that kept the host's event loop hot for its whole life.
  // Agent.connect() remains available for any future playwright-driven
  // frontend; no current entry point calls it.

  // Wait for init to settle so the "ready" log line is meaningful, but we
  // already triggered it above so the runner can serve clients in parallel.
  await initPromise;

  log('ready');
}

main().catch((err) => {
  log('fatal:', err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});

// Don't trap signals — Chrome closes stdin to ask us to exit, which the
// transport already turns into a clean shutdown.
