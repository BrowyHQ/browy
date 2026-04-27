/**
 * Browser detection + launching.
 *
 * Browy uses fixed CDP ports per brand so multiple browsers can coexist:
 *   Brave  → 9222
 *   Edge   → 9223
 *   Chrome → 9224
 *
 * Launch policy: spawn the user's existing default profile so cookies, logins,
 * and extensions are preserved. Caveat (documented in the UI): if the browser
 * is already running, the new process exits immediately and the existing
 * windows do NOT have CDP enabled. The user has to fully quit the browser
 * (every window + tray icon) before Browy can attach.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { BrowserStatus } from '../types.ts';

export interface BrandSpec {
  brand: string;
  port: number;
  /** Candidate exe paths in priority order, per platform. */
  paths: { win32?: string[]; darwin?: string[]; linux?: string[] };
}

export const BRANDS: BrandSpec[] = [
  {
    brand: 'Brave', port: 9222,
    paths: {
      win32: [
        'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
        'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      ],
      darwin: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
      linux: ['/usr/bin/brave-browser', '/usr/bin/brave'],
    },
  },
  {
    brand: 'Edge', port: 9223,
    paths: {
      win32: [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ],
      darwin: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      linux: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
    },
  },
  {
    brand: 'Chrome', port: 9224,
    paths: {
      win32: [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ],
      darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
    },
  },
];

function platformPaths(spec: BrandSpec): string[] {
  const p = process.platform as 'win32' | 'darwin' | 'linux';
  return spec.paths[p] || [];
}

export function findExe(spec: BrandSpec): string | undefined {
  for (const candidate of platformPaths(spec)) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* keep trying */ }
  }
  return undefined;
}

/** Probe http://localhost:PORT/json/version to see if a Chromium debug
 *  server is reachable. Tight timeout so this can run on a 1-2s loop. */
function probePort(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.get({ host: 'localhost', port, path: '/json/version', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** Snapshot of every known brand's install + connection state. The agent
 *  passes in `connectedPorts` (the set it currently has live CDP sessions
 *  to) so we don't double-probe ports we already know are alive. */
export async function getBrowsersStatus(connectedPorts: Set<number>): Promise<BrowserStatus[]> {
  const out: BrowserStatus[] = [];
  await Promise.all(BRANDS.map(async (spec) => {
    const exe = findExe(spec);
    const installed = !!exe;
    let connected = connectedPorts.has(spec.port);
    if (!connected && installed) {
      // Maybe someone else launched it with the right port — probe to find out
      connected = await probePort(spec.port);
    }
    out.push({ brand: spec.brand, port: spec.port, installed, connected, exe });
  }));
  // Sort to match BRANDS order (Brave, Edge, Chrome)
  out.sort((a, b) => BRANDS.findIndex(s => s.brand === a.brand) - BRANDS.findIndex(s => s.brand === b.brand));
  return out;
}

export interface LaunchResult { ok: boolean; error?: string }

/** Spawn the browser detached so it survives Browy exit. We use a dedicated
 *  per-brand user-data-dir so the debug port reliably attaches — Edge in
 *  particular silently drops --remote-debugging-port on the default profile.
 *  Returns ok=true if the CDP port starts answering within ~10s. */
export async function launchBrowser(brand: string): Promise<LaunchResult> {
  const spec = BRANDS.find(s => s.brand.toLowerCase() === brand.toLowerCase());
  if (!spec) return { ok: false, error: `Unknown browser: ${brand}` };
  const exe = findExe(spec);
  if (!exe) return { ok: false, error: `${spec.brand} not installed in any standard location` };

  // If CDP is already up on this port, nothing to do
  if (await probePort(spec.port)) return { ok: true };

  // Per-brand profile dir: keeps cookies/logins between Browy sessions, but
  // separate from the user's main profile so the debug port actually attaches
  // (and so opening Browy doesn't fight with their normal browsing).
  const profileDir = path.join(os.homedir(), '.browy', `${spec.brand.toLowerCase()}-profile`);
  try { fs.mkdirSync(profileDir, { recursive: true }); } catch { /* ignore */ }

  try {
    const child = spawn(exe, [
      `--remote-debugging-port=${spec.port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--restore-last-session',
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    child.on('error', () => { /* swallow — we'll detect via probe */ });
  } catch (err) {
    return { ok: false, error: `Failed to spawn: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Poll for up to 10s — cold-start Edge/Chrome can take 4-6s to bind the port.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await probePort(spec.port)) return { ok: true };
    await new Promise(r => setTimeout(r, 400));
  }
  return {
    ok: false,
    error: `${spec.brand} did not expose a debug port within 10s. ` +
           `If a window opened, try clicking launch again — sometimes the first cold-start is slow.`,
  };
}
