// One-time cleanup: delete BrowserAgent's sessions in its dedicated workdir.
//
// SAFETY: only targets sessions whose context.cwd is EXACTLY
// ~/.browseragent/sessions — a path BrowserAgent owns and nothing else uses.
// Sessions in real project dirs (e.g. C:\Projects\BrowserAgentCLI) are NEVER
// touched, since those may belong to your regular Copilot CLI usage.
//
//   node tests/cleanup-orphans.mjs            # dry-run, just lists
//   node tests/cleanup-orphans.mjs --delete   # actually delete

import { createRequire } from 'module';
import path from 'path';
import os from 'os';
const require = createRequire(import.meta.url);
const { CopilotClient } = require('@github/copilot-sdk');

const dryRun = !process.argv.includes('--delete');
const BROWSERAGENT_WORKDIR = path.join(os.homedir(), '.browseragent', 'sessions');

const c = new CopilotClient();
await c.start();
const targets = (await c.listSessions({ cwd: BROWSERAGENT_WORKDIR }))
  .filter((s) => s.context?.cwd === BROWSERAGENT_WORKDIR);
console.log(`Sessions in BrowserAgent workdir: ${targets.length}`);
if (targets.length === 0) { await c.stop(); process.exit(0); }

if (dryRun) {
  for (const s of targets.slice(0, 10)) {
    console.log(`  ${s.sessionId}  ${new Date(s.startTime).toISOString()}`);
  }
  if (targets.length > 10) console.log(`  ... and ${targets.length - 10} more`);
  console.log('\nDry run. Pass --delete to actually delete.');
  await c.stop();
  process.exit(0);
}

let done = 0;
for (const s of targets) {
  try { await c.deleteSession(s.sessionId); done++; }
  catch (e) { console.error(`  failed ${s.sessionId}: ${e.message}`); }
}
console.log(`Deleted ${done}/${targets.length}.`);
await c.stop();

