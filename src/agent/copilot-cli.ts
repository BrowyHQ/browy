// Where the Copilot CLI that Browy runs lives.
//
// Up to @github/copilot 1.0.36 the npm package was the CLI itself, a Node
// script at @github/copilot/index.js. Later releases ship the CLI as a native
// binary in a per-platform package, @github/copilot-<platform>-<arch>, and
// @github/copilot is only a loader that execs it.
//
// Copilot SDK 1.x brings its own runtime in @github/copilot-sdk-<platform>,
// but that runtime can't run an interactive `copilot` for sign-in, so Browy
// keeps shipping the full CLI and hands it to the SDK as the stdio runtime.
// The SDK's runtime package is left out of releases (scripts/stage.mjs).

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

/** Platform package names to try, most specific first. */
export function copilotPlatformPackages(platform: string = process.platform, arch: string = process.arch): string[] {
  if (platform === 'linux') return [`copilot-linux-${arch}`, `copilot-linuxmusl-${arch}`];
  return [`copilot-${platform}-${arch}`];
}

/** Absolute path to the Copilot CLI, or undefined if none is installed.
 *
 *  Order: COPILOT_CLI_PATH, then the native binary for this platform, then the
 *  legacy index.js. Searches each node_modules from `startDir` upwards, which
 *  covers the staged layout (<app>/dist/*.js next to <app>/node_modules) and
 *  the dev layout (<repo>/dist/*.js). */
export function resolveCopilotCli(
  startDir: string = path.dirname(fileURLToPath(import.meta.url)),
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  arch: string = process.arch,
): string | undefined {
  const explicit = env.COPILOT_CLI_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const exe = platform === 'win32' ? 'copilot.exe' : 'copilot';
  const roots: string[] = [];
  for (let dir = path.resolve(startDir); ; dir = path.dirname(dir)) {
    roots.push(path.join(dir, 'node_modules', '@github'));
    if (path.dirname(dir) === dir) break;
  }
  for (const root of roots) {
    for (const pkg of copilotPlatformPackages(platform, arch)) {
      const bin = path.join(root, pkg, exe);
      if (fs.existsSync(bin)) return bin;
    }
  }
  for (const root of roots) {
    const legacy = path.join(root, 'copilot', 'index.js');
    if (fs.existsSync(legacy)) return legacy;
  }
  return undefined;
}

/** Options for `new CopilotClient(...)`: the CLI above as the SDK's stdio
 *  runtime. Empty when no CLI was found, which leaves the SDK's own runtime
 *  lookup and its error message in charge. */
export function copilotClientOptions(): { connection?: unknown } {
  const cliPath = resolveCopilotCli();
  if (!cliPath) return {};
  const { RuntimeConnection } = createRequire(import.meta.url)('@github/copilot-sdk');
  return { connection: RuntimeConnection.forStdio({ path: cliPath }) };
}
