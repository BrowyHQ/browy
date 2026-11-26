// Upgrade before tagging. Release builds install the reviewed lockfile.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const versions = process.argv.slice(2);
if (versions.length !== 0 && (versions.length !== 2 || !versions.every(v => /^\d+\.\d+\.\d+$/.test(v)))) {
  console.error('Usage: npm run release:update-copilot [-- <cli-version> <sdk-version>]');
  process.exit(2);
}
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this command through npm run release:update-copilot.');
const names = ['@github/copilot', '@github/copilot-sdk'];
const args = versions.length
  ? ['install', '--save-prefix=^', ...names.map((name, i) => `${name}@${versions[i]}`)]
  : ['update', '--save', ...names];
const root = new URL('../', import.meta.url);
execFileSync(process.execPath, [npm, ...args, '--prefer-online', '--no-fund', '--no-audit'], {
  cwd: fileURLToPath(root), stdio: 'inherit',
});
const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8'));
for (const name of names) console.log(`${name}: ${lock.packages[`node_modules/${name}`].version}`);
