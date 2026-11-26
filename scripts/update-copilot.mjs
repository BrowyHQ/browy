// Upgrade before tagging. Release builds install the reviewed lockfile.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyCopilotRuntime } from './verify-copilot-runtime.mjs';

const versions = process.argv.slice(2);
const stable = v => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v);
if (versions.length !== 0 && (versions.length !== 2 || !versions.every(stable))) {
  console.error('Usage: npm run release:update-copilot [-- <cli-version> <sdk-version>]');
  process.exit(2);
}
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this command through npm run release:update-copilot.');
const root = new URL('../', import.meta.url);
const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8'));
const sdk = JSON.parse(execFileSync(process.execPath, [npm, 'view', `@github/copilot-sdk@${versions[1] || 'latest'}`,
  'version', 'copilotCliVersion', '--json', '--prefer-online'], { cwd: fileURLToPath(root), encoding: 'utf8' }));
if (!stable(sdk.version) || !stable(sdk.copilotCliVersion)) throw new Error('SDK metadata does not specify a stable SDK and companion CLI.');
if (!versions.length && sdk.version.split('.')[0] !== lock.packages['node_modules/@github/copilot-sdk'].version.split('.')[0]) {
  throw new Error('New SDK major: review its migration notes and explicitly select a compatible pair.');
}
if (versions.length && (versions[1] !== sdk.version || versions[0] !== sdk.copilotCliVersion)) {
  throw new Error(`SDK ${sdk.version} was released with CLI ${sdk.copilotCliVersion}. No packages changed.`);
}
console.log(`Selecting Copilot CLI ${sdk.copilotCliVersion} with SDK ${sdk.version}.`);
execFileSync(process.execPath, [npm, 'install', '--save-exact', `@github/copilot@${sdk.copilotCliVersion}`,
  `@github/copilot-sdk@${sdk.version}`, '--prefer-online', '--no-fund', '--no-audit'], {
  cwd: fileURLToPath(root), stdio: 'inherit',
});
await verifyCopilotRuntime(fileURLToPath(root), `${process.platform}-${process.arch}`);
