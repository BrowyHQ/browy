// Native Messaging Host installer.
//
// Native messaging registration is per-browser, per-platform. This module
// writes a host manifest pointing at our wrapper script and (on Windows)
// adds the required registry entries.
//
// Usage from cli-bin:
//   browy install-host        # writes manifests for Chrome, Edge, Brave
//   browy uninstall-host      # removes them
//
// Manifest spec: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
//
// The extension ID embedded in `allowed_origins` MUST match whatever ID
// Chrome assigns our extension. We pin it via the `key` field in the
// extension's manifest.json so the ID is stable across loads.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const HOST_NAME = 'com.browy.host';
// Sideload (Load-unpacked) ID, pinned via the manifest's `key` field so it's
// stable across loads.
export const EXTENSION_ID = 'lfeljbgjlkoabhepbkdbjgpbhfmpgmkc';
// Chrome Web Store assigned ID. Pre-approved here so users who install from
// the Web Store get a working native-host connection without re-running the
// installer with --ext-id.
export const CWS_EXTENSION_ID = 'iondecjdokngnlkfpipgolgkfegpmjca';
// Default `allowed_origins` covers both install paths.
export const DEFAULT_EXTENSION_IDS = [EXTENSION_ID, CWS_EXTENSION_ID];

interface BrowserTarget {
  brand: string;
  /** Manifest directory on this platform. */
  dir: string;
  /** Windows registry root key, or null on non-Windows. */
  regKey: string | null;
}

function targetsForPlatform(): BrowserTarget[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      { brand: 'Chrome', dir: path.join(local, 'Google', 'Chrome', 'User Data', 'NativeMessagingHosts'),
        regKey: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}` },
      { brand: 'Edge',   dir: path.join(local, 'Microsoft', 'Edge', 'User Data', 'NativeMessagingHosts'),
        regKey: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}` },
      { brand: 'Brave',  dir: path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data', 'NativeMessagingHosts'),
        regKey: `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${HOST_NAME}` },
    ];
  }
  if (process.platform === 'darwin') {
    return [
      { brand: 'Chrome', dir: path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'), regKey: null },
      { brand: 'Edge',   dir: path.join(home, 'Library', 'Application Support', 'Microsoft Edge', 'NativeMessagingHosts'), regKey: null },
      { brand: 'Brave',  dir: path.join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'), regKey: null },
    ];
  }
  // linux
  const cfg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [
    { brand: 'Chrome', dir: path.join(cfg, 'google-chrome', 'NativeMessagingHosts'), regKey: null },
    { brand: 'Edge',   dir: path.join(cfg, 'microsoft-edge', 'NativeMessagingHosts'), regKey: null },
    { brand: 'Brave',  dir: path.join(cfg, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'), regKey: null },
  ];
}

/** Locate the bundled native-host.js. Walks up from this file looking for
 *  dist/native-host.js, which is where the build emits it. */
function findHostJs(): string {
  // When compiled, this file lives at dist/install-host.js (next to native-host.js).
  // When running from source via tsx, it's at src/install-host.ts.
  const candidates = [
    path.resolve(__dirname, 'native-host.js'),                  // bundled
    path.resolve(__dirname, '..', 'dist', 'native-host.js'),    // source layout
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    'Could not locate dist/native-host.js. Run `npm run build` first.'
  );
}

/** Generates the wrapper script that browsers actually spawn. We need this
 *  because native messaging hosts must be a real executable; a .js file
 *  can't be invoked directly by Chrome on Windows. */
function writeWrapper(installDir: string, hostJs: string): string {
  if (process.platform === 'win32') {
    const bat = path.join(installDir, 'browy-host.bat');
    // %~dp0 = directory of the .bat. Quoted to handle spaces.
    // The wrapper preserves stdin/stdout/stderr and exits with the host's
    // exit code so Chrome sees a clean shutdown.
    const content =
      '@echo off\r\n' +
      `"${process.execPath}" "${hostJs}" %*\r\n`;
    fs.writeFileSync(bat, content, 'utf8');
    return bat;
  }
  // POSIX: a tiny shell wrapper, marked +x.
  const sh = path.join(installDir, 'browy-host.sh');
  const content = `#!/usr/bin/env bash\nexec "${process.execPath}" "${hostJs}" "$@"\n`;
  fs.writeFileSync(sh, content, 'utf8');
  fs.chmodSync(sh, 0o755);
  return sh;
}

interface InstallResult {
  brand: string;
  ok: boolean;
  detail: string;
}

export function installHost(extensionIds: string[] = DEFAULT_EXTENSION_IDS): InstallResult[] {
  const hostJs = findHostJs();
  // We keep our own install dir under the user's home so we don't depend on
  // the npm global node_modules path being writable later.
  const installDir = path.join(os.homedir(), '.browy', 'host');
  fs.mkdirSync(installDir, { recursive: true });
  const wrapper = writeWrapper(installDir, hostJs);

  const manifest = {
    name: HOST_NAME,
    description: 'Browy AI agent native host',
    path: wrapper,
    type: 'stdio',
    allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
  };
  const manifestJson = JSON.stringify(manifest, null, 2);

  const results: InstallResult[] = [];
  for (const t of targetsForPlatform()) {
    try {
      fs.mkdirSync(t.dir, { recursive: true });
      const manifestPath = path.join(t.dir, `${HOST_NAME}.json`);
      fs.writeFileSync(manifestPath, manifestJson, 'utf8');

      if (t.regKey) {
        // Registry entry that Chrome reads to find the manifest.
        // Default value (empty name) holds the absolute manifest path.
        try {
          execSync(`reg add "${t.regKey}" /ve /t REG_SZ /d "${manifestPath}" /f`, {
            stdio: 'ignore',
          });
        } catch (e) {
          results.push({ brand: t.brand, ok: false, detail: `registry write failed (${(e as Error).message})` });
          continue;
        }
      }
      results.push({ brand: t.brand, ok: true, detail: manifestPath });
    } catch (e) {
      results.push({ brand: t.brand, ok: false, detail: (e as Error).message });
    }
  }
  return results;
}

export function uninstallHost(): InstallResult[] {
  const results: InstallResult[] = [];
  for (const t of targetsForPlatform()) {
    const manifestPath = path.join(t.dir, `${HOST_NAME}.json`);
    let removed = false;
    try {
      if (fs.existsSync(manifestPath)) {
        fs.unlinkSync(manifestPath);
        removed = true;
      }
    } catch (e) {
      results.push({ brand: t.brand, ok: false, detail: `manifest delete failed: ${(e as Error).message}` });
      continue;
    }
    if (t.regKey) {
      try {
        execSync(`reg delete "${t.regKey}" /f`, { stdio: 'ignore' });
        removed = true;
      } catch { /* may not exist */ }
    }
    results.push({ brand: t.brand, ok: true, detail: removed ? 'removed' : 'nothing to remove' });
  }
  return results;
}
