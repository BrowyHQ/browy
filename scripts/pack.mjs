#!/usr/bin/env node
/**
 * Packs a staged bundle (stage/<target>/Browy/) into a portable archive
 * suitable for direct download from GitHub Releases.
 *
 * Output:
 *   release/Browy-<version>-<target>.zip      (Windows)
 *   release/Browy-<version>-<target>.tar.gz   (mac, linux)
 *
 * Windows zip is preferred so users can extract via right-click → Extract All
 * with no extra tooling. Mac/Linux use tar.gz which preserves the +x bit on
 * node and install.sh.
 *
 * Usage:
 *   node scripts/pack.mjs --target=win-x64
 *   node scripts/pack.mjs --target=darwin-arm64
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const targetArg = process.argv.find((a) => a.startsWith('--target='));
if (!targetArg) {
  console.error('[pack] need --target=<win-x64|darwin-x64|darwin-arm64|linux-x64|linux-arm64>');
  process.exit(1);
}
const target = targetArg.slice('--target='.length);
const isWin = target === 'win-x64';

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const stageDir = path.join(root, 'stage', target);
const stageBrowy = path.join(stageDir, 'Browy');
if (!fs.existsSync(stageBrowy)) {
  console.error(`[pack] missing ${stageBrowy} — run scripts/stage.mjs --target=${target} first`);
  process.exit(1);
}

const releaseDir = path.join(root, 'release');
fs.mkdirSync(releaseDir, { recursive: true });

const baseName = `Browy-${pkg.version}-${target}`;
const out = path.join(releaseDir, baseName + (isWin ? '.zip' : '.tar.gz'));
try { fs.unlinkSync(out); } catch {}

console.log(`[pack:${target}] → ${out}`);

if (isWin) {
  // Use system tar (Win10+) to make a zip — it supports both .zip and .tar.gz
  // and preserves directory layout. Fallback to PowerShell Compress-Archive
  // if that fails for any reason.
  try {
    execSync(`tar -a -cf "${out}" -C "${stageDir}" Browy`, { stdio: 'inherit' });
  } catch {
    execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${stageBrowy}' -DestinationPath '${out}' -Force"`, { stdio: 'inherit' });
  }
} else {
  // tar.gz preserves +x on node + install.sh. -z=gzip, -h follow symlinks.
  execSync(`tar -czf "${out}" -C "${stageDir}" Browy`, { stdio: 'inherit' });
}

const sz = fs.statSync(out).size / 1024 / 1024;
console.log(`[pack:${target}] ✅ ${sz.toFixed(1)}MB → ${out}`);
