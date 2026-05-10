#!/usr/bin/env node
/**
 * Downloads the Node runtime for one or more target platforms and caches it
 * under build-resources/node/<target>/. Idempotent — skips targets already
 * present at the expected size.
 *
 * Targets: win-x64, darwin-x64, darwin-arm64, linux-x64, linux-arm64.
 *
 * Usage:
 *   node scripts/fetch-node.mjs                  # current host platform
 *   node scripts/fetch-node.mjs --all            # all five targets
 *   node scripts/fetch-node.mjs --target=mac-arm64,linux-x64
 *
 * Output (per target):
 *   build-resources/node/<target>/node[.exe]
 *
 * For non-Windows targets we extract just `bin/node` from the official tarball
 * to keep build-resources lean (~25MB vs ~80MB raw tarball).
 */
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const cacheRoot = path.join(root, 'build-resources', 'node');

// Node 24 LTS — required for stable node:sqlite (used by @github/copilot).
const NODE_VERSION = process.env.BROWY_BUNDLED_NODE_VERSION || 'v24.11.0';

const TARGETS = {
  'win-x64':      { url: `nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`,                  file: 'node.exe', kind: 'raw' },
  'darwin-x64':   { url: `nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-darwin-x64.tar.gz`,   file: 'node', kind: 'tarball' },
  'darwin-arm64': { url: `nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-darwin-arm64.tar.gz`, file: 'node', kind: 'tarball' },
  'linux-x64':    { url: `nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz`,    file: 'node', kind: 'tarball-xz' },
  'linux-arm64':  { url: `nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-arm64.tar.xz`,  file: 'node', kind: 'tarball-xz' },
};

function hostTarget() {
  const a = process.arch;
  if (process.platform === 'win32') return 'win-x64';
  if (process.platform === 'darwin') return a === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  return a === 'arm64' ? 'linux-arm64' : 'linux-x64';
}

function parseTargets(argv) {
  if (argv.includes('--all')) return Object.keys(TARGETS);
  const t = argv.find((a) => a.startsWith('--target='));
  if (t) return t.slice('--target='.length).split(',').map((s) => s.trim()).filter(Boolean);
  return [hostTarget()];
}

function get(u, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get('https://' + u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = res.headers.location.replace(/^https?:\/\//, '');
        return get(next, redirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} from ${u}`));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function fetchTarget(target) {
  const meta = TARGETS[target];
  if (!meta) throw new Error(`unknown target ${target}`);
  const outDir = path.join(cacheRoot, target);
  const outFile = path.join(outDir, meta.file);
  if (fs.existsSync(outFile) && fs.statSync(outFile).size > 1_000_000) {
    console.log(`[fetch-node] ✓ ${target} cached (${(fs.statSync(outFile).size / 1024 / 1024).toFixed(1)}MB)`);
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`[fetch-node] ↓ ${target} from ${meta.url}`);
  const buf = await get(meta.url);

  if (meta.kind === 'raw') {
    fs.writeFileSync(outFile, buf);
  } else {
    // Extract bin/node from the tarball. Windows' bundled tar (libarchive)
    // doesn't support --wildcards, so we ask for the exact path which the
    // tarball uses (node-vX.Y.Z-<platform>/bin/node) — works on tar
    // (libarchive) on Windows AND GNU/BSD tar on mac/linux.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browy-node-'));
    const arc = path.join(tmp, meta.kind === 'tarball-xz' ? 'node.tar.xz' : 'node.tar.gz');
    fs.writeFileSync(arc, buf);
    const platSeg = target === 'darwin-x64'   ? 'darwin-x64'
                   : target === 'darwin-arm64' ? 'darwin-arm64'
                   : target === 'linux-x64'    ? 'linux-x64'
                   : target === 'linux-arm64'  ? 'linux-arm64'
                   : (() => { throw new Error(`no platSeg for ${target}`); })();
    const innerPath = `node-${NODE_VERSION}-${platSeg}/bin/node`;
    execSync(`tar -xf "${arc}" -C "${tmp}" --strip-components=2 "${innerPath}"`, {
      stdio: 'inherit',
    });
    fs.copyFileSync(path.join(tmp, 'node'), outFile);
    fs.chmodSync(outFile, 0o755);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`[fetch-node] ✓ ${target} → ${(fs.statSync(outFile).size / 1024 / 1024).toFixed(1)}MB`);
}

const targets = parseTargets(process.argv.slice(2));
for (const t of targets) {
  await fetchTarget(t);
}
