#!/usr/bin/env node
/**
 * `browy` — CLI entrypoint for the npm-installed package.
 *
 * Subcommands:
 *   browy install-host     → register native messaging host (run after install)
 *   browy uninstall-host   → remove native messaging host registration
 *   browy repl             → interactive terminal REPL (power-user mode)
 *   browy chat "<message>" → one-shot chat, prints reply, exits
 *   browy --help           → show help
 *   browy --version        → print version
 *
 * The real UI is the Chrome/Edge extension's side panel + DevTools panel.
 * After installing the extension and running `browy install-host`, the
 * extension talks to dist/native-host.js over native messaging.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const cmd = (argv[0] || '').toLowerCase();

if (cmd === '' || cmd === '--help' || cmd === '-h' || cmd === 'help') {
  printHelp();
  process.exit(0);
}
if (cmd === '--version' || cmd === '-v') {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}

if (cmd === 'repl') {
  // Interactive terminal mode — drive Agent directly without WS.
  await runRepl();
} else if (cmd === 'chat') {
  const message = argv.slice(1).join(' ').trim();
  if (!message) {
    console.error('usage: browy chat "your message"');
    process.exit(2);
  }
  await runOneShot(message);
} else if (cmd === 'install-host') {
  await runInstallHost(argv.slice(1));
} else if (cmd === 'uninstall-host') {
  await runUninstallHost();
} else {
  console.error(`unknown command: ${cmd}`);
  printHelp();
  process.exit(2);
}

function printHelp() {
  console.log(`browy — Copilot-powered AI agent for your browser

usage:
  browy install-host     register native messaging host for Chrome/Edge/Brave
                         (run this once after install — lets the Browy
                         browser extension connect to the agent)
  browy uninstall-host   remove native messaging host registration
  browy repl             interactive terminal REPL (power-user mode)
  browy chat "<msg>"     one-shot chat, prints reply
  browy --help           show this help
  browy --version        print version

first run:
  1. install the Browy extension from the Chrome Web Store / Edge Add-ons
  2. run \`browy install-host\` to register the native messaging host
  3. open the Browy side panel — it'll prompt you to sign in to GitHub Copilot
`);
}

async function runOneShot(message: string) {
  const { Agent } = await import('./agent/loop.js');
  const { loadConfig } = await import('./config.js');
  const agent = new Agent(loadConfig());
  try {
    const { text } = await agent.chat(message);
    console.log(text);
    process.exit(0);
  } catch (err) {
    console.error(String((err as Error)?.message || err));
    process.exit(1);
  }
}

async function runRepl() {
  const { Agent } = await import('./agent/loop.js');
  const { loadConfig } = await import('./config.js');
  const { createInterface } = await import('readline');
  const agent = new Agent(loadConfig());
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'browy> ' });
  console.log('browy repl — type a message, or `exit` to quit');
  rl.prompt();
  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) { rl.prompt(); return; }
    if (text === 'exit' || text === 'quit') { rl.close(); return; }
    try {
      const { text: reply } = await agent.chat(text);
      console.log(reply);
    } catch (err) {
      console.error('error:', String((err as Error)?.message || err));
    }
    rl.prompt();
  });
  rl.on('close', () => process.exit(0));
}

async function runInstallHost(args: string[]) {
  const { installHost, EXTENSION_ID } = await import('./install-host.js');
  // Allow extra extension ids via --ext-id (e.g. for the published Web Store id).
  const extraIds: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ext-id' && args[i + 1]) { extraIds.push(args[i + 1]); i++; }
  }
  const ids = [EXTENSION_ID, ...extraIds];
  console.log(`installing native messaging host for extension id(s): ${ids.join(', ')}`);
  const results = installHost(ids);
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.brand.padEnd(8)} ${r.detail}`);
  }
  const failed = results.filter(r => !r.ok).length;
  process.exit(failed ? 1 : 0);
}

async function runUninstallHost() {
  const { uninstallHost } = await import('./install-host.js');
  const results = uninstallHost();
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.brand.padEnd(8)} ${r.detail}`);
  }
  process.exit(0);
}
