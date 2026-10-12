// Which Copilot CLI Browy hands to the SDK.
//
// Newer @github/copilot releases ship the CLI as a native binary in
// @github/copilot-<platform>-<arch>, and Copilot SDK 0.3.0 only knows the old
// @github/copilot/index.js. Without an explicit cliPath the SDK fails to start
// at all, so this guards the lookup on every layout Browy runs from.
//
// Run: node tests/copilot-cli.mjs   (Node 23.6+ strips the .ts types itself)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCopilotCli } from '../src/agent/copilot-cli.ts';

const failures = [];
const check = (name, actual, expected) => {
  if (actual !== expected) failures.push(`${name}\n    expected ${expected}\n    got      ${actual}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browy-cli-test-'));
const touch = (...parts) => {
  const p = path.join(tmp, ...parts);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '');
  return p;
};
const scope = (base) => [base, 'node_modules', '@github'];

try {
  // Staged layout: <app>/dist/native-host.js next to <app>/node_modules.
  const dist = path.join(tmp, 'app', 'dist');
  fs.mkdirSync(dist, { recursive: true });
  check('nothing installed', resolveCopilotCli(dist, {}, 'win32', 'x64'), undefined);

  const legacy = touch(...scope('app'), 'copilot', 'index.js');
  check('old JS CLI is the fallback', resolveCopilotCli(dist, {}, 'win32', 'x64'), legacy);

  const exe = touch(...scope('app'), 'copilot-win32-x64', 'copilot.exe');
  check('native binary wins over index.js', resolveCopilotCli(dist, {}, 'win32', 'x64'), exe);
  check('another arch is not picked', resolveCopilotCli(dist, {}, 'win32', 'arm64'), legacy);

  const mac = touch(...scope('app'), 'copilot-darwin-arm64', 'copilot');
  check('mac binary has no .exe', resolveCopilotCli(dist, {}, 'darwin', 'arm64'), mac);

  const musl = touch(...scope('app'), 'copilot-linuxmusl-x64', 'copilot');
  check('musl package when there is no glibc one', resolveCopilotCli(dist, {}, 'linux', 'x64'), musl);
  const glibc = touch(...scope('app'), 'copilot-linux-x64', 'copilot');
  check('glibc package first', resolveCopilotCli(dist, {}, 'linux', 'x64'), glibc);

  // Dev layout with the package hoisted one level up.
  const nested = path.join(tmp, 'repo', 'packages', 'browy', 'dist');
  fs.mkdirSync(nested, { recursive: true });
  const hoisted = touch(...scope('repo'), 'copilot-win32-x64', 'copilot.exe');
  check('walks up to a hoisted node_modules', resolveCopilotCli(nested, {}, 'win32', 'x64'), hoisted);

  const override = touch('custom', 'copilot.exe');
  check('COPILOT_CLI_PATH wins', resolveCopilotCli(dist, { COPILOT_CLI_PATH: override }, 'win32', 'x64'), override);
  check('a COPILOT_CLI_PATH that does not exist is ignored',
    resolveCopilotCli(dist, { COPILOT_CLI_PATH: path.join(tmp, 'gone.exe') }, 'win32', 'x64'), exe);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`copilot-cli: ${failures.length} failure(s)\n  ` + failures.join('\n  '));
  process.exit(1);
}
console.log('copilot-cli: all checks passed');
