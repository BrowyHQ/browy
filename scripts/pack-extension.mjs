#!/usr/bin/env node
/**
 * Packs the Chrome/Edge/Brave extension folder into release zips.
 *
 * Produces two artifacts in release/:
 *
 *   Browy-Extension-<version>.zip       (sideload — wraps in extension/)
 *     For "Load unpacked" sideloading: extract, then point chrome://extensions
 *     at the extracted "extension" folder.
 *
 *   Browy-Extension-<version>-cws.zip   (Chrome Web Store upload)
 *     manifest.json sits at the root of the zip — the layout the CWS
 *     Developer Dashboard expects.
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

// Cross-check: manifest version must match package version, otherwise CWS
// will reject the second upload because Chrome expects monotonic versions.
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  console.error(`[pack-ext] version mismatch: package.json=${pkg.version} manifest.json=${manifest.version}`);
  console.error('[pack-ext] aborting — sync them before packing.');
  process.exit(1);
}

const releaseDir = path.join(root, 'release');
fs.mkdirSync(releaseDir, { recursive: true });

const sideload = path.join(releaseDir, `Browy-Extension-${pkg.version}.zip`);
const cws      = path.join(releaseDir, `Browy-Extension-${pkg.version}-cws.zip`);
for (const f of [sideload, cws]) { try { fs.unlinkSync(f); } catch {} }

function zip(cwd, sources, out) {
  // tar handles zip on Win10+, mac, and modern Linux.
  const list = sources.map(s => `"${s}"`).join(' ');
  try {
    execSync(`tar -a -cf "${out}" -C "${cwd}" ${list}`, { stdio: 'inherit' });
  } catch {
    // PowerShell fallback (Windows only). Compress-Archive doesn't support
    // CWS-flat layout cleanly — only used as a last resort for sideload.
    const inputs = sources.map(s => `'${path.join(cwd, s)}'`).join(',');
    execSync(`powershell -NoProfile -Command "Compress-Archive -Path ${inputs} -DestinationPath '${out}' -Force"`, { stdio: 'inherit' });
  }
}

console.log(`[pack-ext] sideload → ${sideload}`);
zip(root, ['extension'], sideload);

console.log(`[pack-ext] cws      → ${cws}`);
// Pack from inside extension/ so manifest.json lands at the zip root.
const entries = fs.readdirSync(extDir).filter(n => !n.startsWith('.'));
zip(extDir, entries, cws);

for (const f of [sideload, cws]) {
  const sz = fs.statSync(f).size / 1024;
  console.log(`[pack-ext] ✅ ${sz.toFixed(1)}KB → ${path.relative(root, f)}`);
}

