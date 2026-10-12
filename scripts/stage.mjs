#!/usr/bin/env node
/**
 * Stages a self-contained Browy distribution for one target platform into
 * stage/<target>/Browy/. The bundle includes:
 *
 *   node[.exe]                 bundled Node 24 LTS
 *   dist/                      compiled JS (cli-bin.js, native-host.js)
 *   node_modules/              runtime deps only (npm ci --omit=dev)
 *   package.json               pruned copy
 *   install.sh / install.bat   thin wrapper that registers the native host
 *   README.txt                 quick install instructions
 *
 * After staging, scripts/pack.mjs turns it into a .zip (Windows) or .tar.gz
 * (mac/linux) for distribution.
 *
 * Usage:
 *   node scripts/stage.mjs                          # host platform
 *   node scripts/stage.mjs --target=darwin-arm64
 *   node scripts/stage.mjs --target=linux-x64
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function hostTarget() {
  if (process.platform === 'win32') return 'win-x64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
}

const targetArg = process.argv.find((a) => a.startsWith('--target='));
const target = targetArg ? targetArg.slice('--target='.length) : hostTarget();
const isWin = target === 'win-x64';

const stage = path.join(root, 'stage', target, 'Browy');

function log(...m) { console.log('[stage:' + target + ']', ...m); }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function copyDir(src, dst, filter) { fs.cpSync(src, dst, { recursive: true, filter: filter || (() => true) }); }
function dirSizeMB(p) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else { try { total += fs.statSync(full).size; } catch {} }
    }
  };
  walk(p);
  return total / (1024 * 1024);
}

// 1. Reset stage dir
rm(stage);
fs.mkdirSync(stage, { recursive: true });

// 2. Copy bundled node binary for the target
const nodeSrc = path.join(root, 'build-resources', 'node', target, isWin ? 'node.exe' : 'node');
if (!exists(nodeSrc)) {
  console.error(`[stage] missing ${nodeSrc} — run: node scripts/fetch-node.mjs --target=${target}`);
  process.exit(1);
}
const nodeDst = path.join(stage, isWin ? 'node.exe' : 'node');
fs.copyFileSync(nodeSrc, nodeDst);
if (!isWin) fs.chmodSync(nodeDst, 0o755);
log('node →', `${(fs.statSync(nodeSrc).size / 1024 / 1024).toFixed(1)}MB`);

// 3. Copy dist/
const distSrc = path.join(root, 'dist');
if (!exists(distSrc)) {
  console.error('[stage] missing dist/ — run npm run build:prod first');
  process.exit(1);
}
copyDir(distSrc, path.join(stage, 'dist'), (s) => !s.endsWith('.map'));

// 4. Pruned package.json + lock for npm ci
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
  name: pkg.name, version: pkg.version, type: pkg.type, dependencies: pkg.dependencies,
}, null, 2));
fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(stage, 'package-lock.json'));

// 5. Install runtime deps only
log('npm ci --omit=dev …');
execSync('npm ci --omit=dev --no-audit --no-fund --ignore-scripts', { cwd: stage, stdio: 'inherit' });

// 6. Trim playwright-core bundled browsers (we use it as a CDP client only).
const pw = path.join(stage, 'node_modules', 'playwright-core');
if (exists(pw)) {
  for (const sub of ['browsers', '.local-browsers']) rm(path.join(pw, sub));
}

// 7. Trim @github/copilot non-target prebuilds. Each prebuild is ~3MB; on a
// per-target installer we only need the matching arch.
const copilotPrebuilds = path.join(stage, 'node_modules', '@github', 'copilot', 'prebuilds');
const prebuildName = {
  'win-x64': 'win32-x64',
  'darwin-x64': 'darwin-x64',
  'darwin-arm64': 'darwin-arm64',
  'linux-x64': 'linux-x64',
  'linux-arm64': 'linux-arm64',
}[target];
if (exists(copilotPrebuilds) && prebuildName) {
  for (const dir of fs.readdirSync(copilotPrebuilds)) {
    if (dir !== prebuildName) {
      rm(path.join(copilotPrebuilds, dir));
    }
  }
}

// 7.1 Keep exactly one Copilot CLI: the TARGET's native binary.
//
// @github/copilot used to be the CLI itself (index.js, loaded by the SDK with
// node). Since it moved to native binaries it is only a loader, npm-loader.js,
// and the CLI is @github/copilot-<platform>-<arch>/copilot[.exe], which
// src/agent/copilot-cli.ts finds and hands to the SDK as `cliPath`.
//
// npm installs that package by the arch of the machine running `npm ci`, and
// release.yml stages darwin-x64 on an arm64 runner and linux-arm64 on an x64
// runner. (That is how Browy-0.1.5-darwin-x64.tar.gz came to contain
// @github/copilot-darwin-arm64.) So drop whatever npm picked and fetch the
// target's own package with `npm pack`, which ignores os and cpu.
const githubScope = path.join(stage, 'node_modules', '@github');
const cliPlatform = {
  'win-x64': 'win32-x64',
  'darwin-x64': 'darwin-x64',
  'darwin-arm64': 'darwin-arm64',
  'linux-x64': 'linux-x64',
  'linux-arm64': 'linux-arm64',
}[target];
const cliPkgJson = path.join(githubScope, 'copilot', 'package.json');
if (!cliPlatform || !exists(cliPkgJson)) {
  throw new Error(`[stage:${target}] cannot place the Copilot CLI: unknown target or @github/copilot not installed`);
}
const cliVersion = JSON.parse(fs.readFileSync(cliPkgJson, 'utf8')).version;
for (const dir of fs.readdirSync(githubScope)) {
  if (/^copilot-(win32|darwin|linux|linuxmusl)-(x64|arm64)$/.test(dir) && dir !== `copilot-${cliPlatform}`) {
    const full = path.join(githubScope, dir);
    const mb = dirSizeMB(full);
    rm(full);
    log(`removed node_modules/@github/${dir} (${mb.toFixed(1)}MB, not this target)`);
  }
}
const cliDir = path.join(githubScope, `copilot-${cliPlatform}`);
const cliBin = path.join(cliDir, isWin ? 'copilot.exe' : 'copilot');
const cliDirVersion = exists(path.join(cliDir, 'package.json'))
  ? JSON.parse(fs.readFileSync(path.join(cliDir, 'package.json'), 'utf8')).version
  : null;
if (cliDirVersion !== cliVersion || !exists(cliBin)) {
  rm(cliDir);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browy-cli-'));
  const tgz = execSync(`npm pack @github/copilot-${cliPlatform}@${cliVersion} --pack-destination "${tmp}" --silent`, { cwd: tmp })
    .toString().trim().split(/\r?\n/).pop();
  fs.mkdirSync(cliDir, { recursive: true });
  execSync(`tar -xzf "${path.join(tmp, tgz)}" -C "${cliDir}" --strip-components=1`);
  rm(tmp);
  log(`fetched @github/copilot-${cliPlatform}@${cliVersion} for this target`);
}
if (!exists(cliBin)) throw new Error(`[stage:${target}] Copilot CLI binary missing: ${cliBin}`);
if (!isWin) fs.chmodSync(cliBin, 0o755);
log(`Copilot CLI ${cliVersion}: @github/copilot-${cliPlatform} (${dirSizeMB(cliDir).toFixed(1)}MB)`);

// 7.5 Bundle the browser extension at a stable path next to the host so the
// installer can lay it down somewhere the user can `Load unpacked` from
// without hunting through %TEMP% or downloading a separate zip.
const extSrc = path.join(root, 'extension');
if (exists(extSrc)) {
  copyDir(extSrc, path.join(stage, 'extension'), (s) => {
    const base = path.basename(s);
    return base !== '.DS_Store' && base !== 'Thumbs.db';
  });
  log('extension → bundled');
} else {
  console.warn('[stage] WARNING: extension/ not found — installer will ship without it');
}

// 8. Drop a thin platform-appropriate installer wrapper into the bundle so
// users can run a single command after extracting the archive.
if (isWin) {
  fs.writeFileSync(path.join(stage, 'install.bat'),
    '@echo off\r\n' +
    'echo Installing Browy native messaging host...\r\n' +
    '"%~dp0node.exe" "%~dp0dist\\cli-bin.js" install-host\r\n' +
    'if errorlevel 1 (\r\n' +
    '  echo Install failed. See output above.\r\n' +
    '  pause & exit /b 1\r\n' +
    ')\r\n' +
    'echo Browy installed. Open the side panel in your browser to start.\r\n' +
    'pause\r\n');
  fs.writeFileSync(path.join(stage, 'uninstall.bat'),
    '@echo off\r\n' +
    '"%~dp0node.exe" "%~dp0dist\\cli-bin.js" uninstall-host\r\n' +
    'pause\r\n');
} else {
  const sh =
    '#!/usr/bin/env bash\n' +
    'set -e\n' +
    'DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\n' +
    'echo "Installing Browy native messaging host..."\n' +
    '"$DIR/node" "$DIR/dist/cli-bin.js" install-host\n' +
    'echo "Browy installed. Open the side panel in your browser to start."\n';
  fs.writeFileSync(path.join(stage, 'install.sh'), sh);
  fs.chmodSync(path.join(stage, 'install.sh'), 0o755);
  const ush =
    '#!/usr/bin/env bash\n' +
    'set -e\n' +
    'DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\n' +
    '"$DIR/node" "$DIR/dist/cli-bin.js" uninstall-host\n';
  fs.writeFileSync(path.join(stage, 'uninstall.sh'), ush);
  fs.chmodSync(path.join(stage, 'uninstall.sh'), 0o755);
}

fs.writeFileSync(path.join(stage, 'README.txt'),
  'Browy — browser AI agent\n' +
  '========================\n\n' +
  'Quick start:\n' +
  (isWin
    ? '  1. Double-click install.bat to register the native host\n'
    : '  1. Run ./install.sh in this directory to register the native host\n') +
  '  2. Open chrome://extensions in Chrome or Edge\n' +
  '  3. Enable "Developer mode" (top-right toggle)\n' +
  '  4. Click "Load unpacked" and select the extension/ folder next to\n' +
  '     this README\n' +
  '  5. Pin the Browy extension and click it to open the side panel\n\n' +
  'Uninstall: run ' + (isWin ? 'uninstall.bat' : './uninstall.sh') + '\n' +
  'Source & docs: https://github.com/BrowyHQ/browy\n');

// 9. Final size report
function dirSize(p) {
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, e.name);
    if (e.isDirectory()) total += dirSize(full);
    else if (e.isFile()) total += fs.statSync(full).size;
  }
  return total;
}
const totalMB = dirSize(stage) / 1024 / 1024;
log(`✅ staged → ${stage}  (${totalMB.toFixed(1)}MB raw)`);
