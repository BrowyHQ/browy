import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

/** Check target packages even on a cross-build. On the host architecture also
 *  exercise the SDK handshake: two valid npm packages can speak different protocols. */
export async function verifyCopilotRuntime(app, platform) {
  const json = (...parts) => JSON.parse(fs.readFileSync(path.join(app, ...parts), 'utf8'));
  const lock = json('package-lock.json').packages;
  const pkg = (name) => {
    const key = `node_modules/@github/${name}`;
    const meta = json(key, 'package.json');
    if (meta.version !== lock[key]?.version) throw new Error(`${name}: installed ${meta.version}, locked ${lock[key]?.version}`);
    return meta;
  };
  const cli = pkg('copilot').version;
  const sdk = pkg('copilot-sdk');
  if (sdk.copilotCliVersion !== cli || pkg(`copilot-${platform}`).version !== cli) {
    throw new Error(`Expected CLI ${sdk.copilotCliVersion} for SDK ${sdk.version}, got ${cli} for ${platform}.`);
  }
  if (platform !== `${process.platform}-${process.arch}`) return;
  const bin = path.join(app, 'node_modules', '@github', `copilot-${platform}`, process.platform === 'win32' ? 'copilot.exe' : 'copilot');
  const { CopilotClient, RuntimeConnection } = createRequire(path.join(app, 'package.json'))('@github/copilot-sdk');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browy-runtime-check-'));
  const client = new CopilotClient({ connection: RuntimeConnection.forStdio({ path: bin, args: ['--no-auto-update'] }),
    cwd: dir, baseDirectory: dir, useLoggedInUser: false });
  let timer;
  try {
    const status = await Promise.race([
      client.start().then(() => client.getStatus()),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Copilot runtime handshake timed out.')), 30_000); }),
    ]);
    if (status.version !== cli) throw new Error(`Running CLI ${status.version}, expected bundled ${cli}.`);
    console.log(`Verified Copilot CLI ${cli} and SDK ${sdk.version} on ${platform}.`);
  } finally {
    clearTimeout(timer);
    try { await client.forceStop(); } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
  }
}
