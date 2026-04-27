#!/usr/bin/env node
/**
 * Packs the Chrome/Edge/Brave extension folder into a zip suitable for
 * "Load unpacked" sideloading from a GitHub Release.
 *
 * Output: release/Browy-Extension-<version>.zip
 *
 * Users install it via:
 *   1. Download and extract the zip
 *   2. chrome://extensions → enable Developer mode → Load unpacked
 *   3. Point at the extracted "extension" folder
 *
 * The extension's manifest pins a public key, so the assigned extension ID
 * is stable (lfeljbgjlkoabhepbkdbjgpbhfmpgmkc) and matches the native host's
 * allowed_origins regardless of install source.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const extDir = path.join(root, 'extension');
if (!fs.existsSync(extDir)) {
  console.error('[pack-ext] missing extension/ folder');
  process.exit(1);
}

const releaseDir = path.join(root, 'release');
fs.mkdirSync(releaseDir, { recursive: true });
const out = path.join(releaseDir, `Browy-Extension-${pkg.version}.zip`);
try { fs.unlinkSync(out); } catch {}

console.log(`[pack-ext] → ${out}`);

// tar handles zip on Win10+, mac, and modern Linux. Wrapping in extension/
// preserves the directory layout users expect when they "Load unpacked".
try {
  execSync(`tar -a -cf "${out}" -C "${root}" extension`, { stdio: 'inherit' });
} catch {
  // PowerShell fallback (Windows only).
  execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${extDir}' -DestinationPath '${out}' -Force"`, { stdio: 'inherit' });
}

const sz = fs.statSync(out).size / 1024;
console.log(`[pack-ext] ✅ ${sz.toFixed(1)}KB → ${out}`);
