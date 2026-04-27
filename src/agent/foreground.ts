// Win32 foreground-window probe. Spawns one long-lived powershell child that
// reads a poke from stdin and writes back the foreground process name + window
// title on stdout. ~1-2ms steady-state after a ~300ms first-call warmup.
//
// Used by the agent to disambiguate "which browser tab is the user actually
// looking at right now" when multiple browsers / windows are open. The window
// title is the most reliable cross-window-same-browser disambiguator: every
// Chromium browser shows the active tab's title in the OS window title bar.
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';

const PS_BOOT = `Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Diagnostics;
public class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  public static string Probe() {
    var h = GetForegroundWindow();
    uint pid; GetWindowThreadProcessId(h, out pid);
    StringBuilder sb = new StringBuilder(512);
    GetWindowTextW(h, sb, 512);
    string title = sb.ToString().Replace("|", "/").Replace("\\r", " ").Replace("\\n", " ");
    string proc = "";
    try { proc = Process.GetProcessById((int)pid).ProcessName; } catch {}
    return proc + "|" + title;
  }
}
"@
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null -or $line -eq "q") { break }
  [Console]::Out.WriteLine([Fg]::Probe())
  [Console]::Out.Flush()
}
`;

let child: ChildProcessWithoutNullStreams | null = null;
const queue: ((s: string) => void)[] = [];
let buf = '';
let bootSent = false;

function ensureChild(): boolean {
  if (child) return true;
  if (process.platform !== 'win32') return false;
  try {
    child = spawn('powershell', ['-NoProfile', '-Command', '-'], { windowsHide: true });
  } catch { return false; }
  child.stdin.write(PS_BOOT);
  bootSent = true;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d: string) => {
    buf += d;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      const cb = queue.shift();
      if (cb) cb(line);
    }
  });
  child.stderr.on('data', () => { /* swallow */ });
  child.on('exit', () => { child = null; bootSent = false; });
  child.on('error', () => { child = null; bootSent = false; });
  return true;
}

export interface ForegroundInfo {
  processName: string;
  title: string;
}

let cache = { value: null as ForegroundInfo | null, t: 0 };

/** Returns foreground process name + window title. Cached for 300ms. */
export async function getForegroundInfo(): Promise<ForegroundInfo | null> {
  if (process.platform !== 'win32') return null;
  if (Date.now() - cache.t < 300 && cache.value) return cache.value;
  if (!ensureChild() || !child || !bootSent) return null;
  const c = child;
  return new Promise<ForegroundInfo | null>((resolve) => {
    let resolved = false;
    const done = (v: ForegroundInfo | null) => {
      if (!resolved) { resolved = true; cache = { value: v, t: Date.now() }; resolve(v); }
    };
    const timer = setTimeout(() => {
      const idx = queue.indexOf(handler);
      if (idx >= 0) queue.splice(idx, 1);
      done(null);
    }, 1500);
    const handler = (s: string) => {
      clearTimeout(timer);
      const sep = s.indexOf('|');
      if (sep < 0) { done({ processName: s, title: '' }); return; }
      done({ processName: s.slice(0, sep), title: s.slice(sep + 1) });
    };
    queue.push(handler);
    try { c.stdin.write('p\n'); } catch { clearTimeout(timer); done(null); }
  });
}

/** Backwards-compat helper. */
export async function getForegroundProcessName(): Promise<string | null> {
  const info = await getForegroundInfo();
  return info ? info.processName : null;
}

const PROC_TO_BRAND: Record<string, string> = {
  brave: 'Brave',
  msedge: 'Edge',
  chrome: 'Chrome',
  opera: 'Opera',
  vivaldi: 'Vivaldi',
};

export function brandFromProcessName(name: string | null | undefined): string | null {
  if (!name) return null;
  return PROC_TO_BRAND[name.toLowerCase()] || null;
}

/** Strip the trailing browser-name suffix that Chromium adds to window titles
 *  (" - Brave", " - Microsoft\u200bEdge", " - Google Chrome", etc.) plus any
 *  "and N more pages" suffix Edge adds. Returns the bare page-title prefix. */
export function stripBrowserSuffix(windowTitle: string): string {
  if (!windowTitle) return '';
  // Edge: "Title and 5 more pages - Personal - Microsoft Edge"
  let t = windowTitle.replace(/\s+and\s+\d+\s+more\s+page[s]?.*$/i, '');
  // Strip trailing " - <BrowserName>" once
  t = t.replace(/\s[-\u2014]\s+(Brave|Microsoft\s*\u200B?Edge|Google\s+Chrome|Chromium|Opera|Vivaldi)\s*$/i, '');
  // Edge sometimes appends profile " - Personal" before the browser name; strip that too if browser already removed
  t = t.replace(/\s[-\u2014]\s+(Personal|Work|Default)\s*$/i, '');
  return t.trim();
}

export function shutdownForeground() {
  if (child) {
    try { child.stdin.write('q\n'); } catch {}
    try { child.kill(); } catch {}
    child = null;
    bootSent = false;
  }
}

