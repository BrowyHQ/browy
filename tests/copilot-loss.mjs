// Copilot quitting under a chat (0.1.14).
//
// When the Copilot CLI exits or its connection closes, the SDK quietly drops
// the session's listeners. Up to 0.1.13 the turn then sat there until the
// five-minute watchdog, and the next message failed on the dead handle. The
// agent now ends the turn at once, starts Copilot again, and resumes the chat
// from disk on the next message.
//
// This runs the real Agent from src/agent/loop.ts against a stand-in for the
// Copilot SDK, swapped in where loop.ts requires it.
//
// Run: node tests/copilot-loss.mjs

import * as esbuild from 'esbuild';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Inside the repo so the bundle finds node_modules; .cache/ is gitignored.
const out = path.join(here, '.cache', 'copilot-loss');
const swapSdk = {
  name: 'fake-copilot-sdk',
  setup(b) {
    b.onLoad({ filter: /[\\/]src[\\/]agent[\\/](loop|copilot-cli)\.ts$/ }, async (args) => ({
      contents: (await fs.promises.readFile(args.path, 'utf8'))
        .replace(/createRequire\(import\.meta\.url\)\('@github\/copilot-sdk'\)/g, 'globalThis.__fakeSdk')
        .replace(/require\('@github\/copilot-sdk'\)/g, 'globalThis.__fakeSdk'),
      loader: 'ts',
    }));
  },
};
await esbuild.build({
  entryPoints: [path.join(here, '..', 'src', 'agent', 'loop.ts')],
  bundle: true, platform: 'node', format: 'esm', packages: 'external',
  outfile: path.join(out, 'loop.mjs'), plugins: [swapSdk], logLevel: 'silent',
});

// ── the stand-in SDK ────────────────────────────────────────────────────────

const clients = [];
const onDisk = new Set();

class FakeSession {
  constructor(id, config) {
    this.sessionId = id;
    this.config = config;
    this.disconnected = false;
    this.sent = [];
    this.handlers = new Set();
    this.rpc = { tools: { handlePendingToolCall: async () => ({}) } };
  }
  on(h) { this.handlers.add(h); return () => this.handlers.delete(h); }
  emit(type, data = {}) { for (const h of [...this.handlers]) h({ type, data }); }
  async send({ prompt }) {
    if (this.disconnected) throw new Error('Session is disconnected');
    this.sent.push(prompt);
  }
  async abort() { if (this.disconnected) throw new Error('Session is disconnected'); }
  async disconnect() { this.markDisconnected(); }
  async getEvents() { return []; }
  // What SDK 1.0.21 does when the connection goes: no event, listeners dropped.
  markDisconnected() { this.disconnected = true; this.handlers.clear(); }
}

class FakeClient {
  constructor() {
    this.sessions = [];
    this.resumes = [];
    this.creates = [];
    this.connected = false;
    clients.push(this);
  }
  async start() { this.cliProcess = new EventEmitter(); this.connected = true; }
  async resumeSession(id, config) {
    if (!onDisk.has(id)) throw new Error(`Request session.resume failed with message: Failed to load session events: Session not found: ${id}`);
    const s = new FakeSession(id, config);
    this.sessions.push(s);
    this.resumes.push(config);
    return s;
  }
  async createSession(config) {
    onDisk.add(config.sessionId);
    const s = new FakeSession(config.sessionId, config);
    this.sessions.push(s);
    this.creates.push(config);
    return s;
  }
  async listModels() { return [{ id: 'gpt-5-mini' }]; }
  async listSessions() { return []; }
  async deleteSession(id) { this.deleted = [...(this.deleted || []), id]; onDisk.delete(id); }
  async ping() { if (!this.connected || this.pingHangs) throw new Error('Client not connected'); return {}; }
  async forceStop() { this.connected = false; this.stopped = true; for (const s of this.sessions) s.markDisconnected(); }
  async stop() { return this.forceStop(); }
  /** The CLI exits: the connection closes, then the child's exit event. */
  crash() { this.connected = false; for (const s of this.sessions) s.markDisconnected(); this.cliProcess.emit('exit', 1, null); }
  /** The connection closes and the process lingers. */
  dropConnection() { this.connected = false; for (const s of this.sessions) s.markDisconnected(); }
}

globalThis.__fakeSdk = {
  CopilotClient: FakeClient,
  defineTool: (name, def) => ({ name, ...def }),
  approveAll: () => ({ kind: 'approved' }),
  RuntimeConnection: { forStdio: (o) => ({ kind: 'stdio', ...o }) },
};

// ── the test ────────────────────────────────────────────────────────────────

// A home of its own: the agent writes ~/.browy/data/prefs.json when the model
// changes, and that file belongs to the real Browy on this machine.
const home = path.join(out, 'home');
fs.mkdirSync(home, { recursive: true });
process.env.USERPROFILE = home;
process.env.HOME = home;
const { Agent } = await import(pathToFileURL(path.join(out, 'loop.mjs')).href);

const failures = [];
const check = (name, cond, detail = '') => { if (!cond) failures.push(`${name}${detail ? `\n    ${detail}` : ''}`); };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (what, cond, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await tick(5);
  }
};

const agent = new Agent({ model: 'gpt-5-mini', cdpEndpoints: [] });
const statuses = [];
agent.setActivityCallback((m) => { if (m.type === 'host_status') statuses.push(m.state); });
const ready = () => statuses.filter((s) => s === 'copilot_ready').length;

try {
  await agent.initCopilot();
  agent.setBrowyProtocolSessionId('sp-loss');

  // A normal turn opens the chat.
  const t1 = agent.chat('first');
  await until('the first send', () => clients[0].sessions[0]?.sent.length === 1);
  const s1 = clients[0].sessions[0];
  s1.emit('session.idle');
  await t1;

  // Copilot exits mid-turn.
  const t2 = agent.chat('do the long thing');
  await until('the second send', () => s1.sent.length === 2);
  s1.emit('assistant.message_delta', { messageId: 'm2', deltaContent: 'Working on it' });
  const tCrash = Date.now();
  clients[0].crash();
  const r2 = await t2;
  check('Copilot quitting ends the turn at once, keeping what was said',
    r2.stopped === true && r2.interrupted === 'copilot' && r2.text === 'Working on it' && Date.now() - tCrash < 1000, JSON.stringify(r2));
  await until('the restart', () => ready() === 1);
  check('Copilot is started again by itself', clients.length === 2 && clients[0].stopped && statuses.join() === 'copilot_restarting,copilot_ready', statuses.join());

  // Picking another model before the next message must not cost the chat.
  await agent.setModel('gpt-5');
  check('changing the model while no chat is open keeps the chat on disk', onDisk.has('sp-loss') && !clients.some((c) => c.deleted?.length));

  // The next message resumes the same chat on the new Copilot.
  const t3 = agent.chat('continue');
  await until('the resumed send', () => clients[1].sessions[0]?.sent.length === 1);
  const s3 = clients[1].sessions[0];
  const opened = clients[0].creates[0];
  const resumed = clients[1].resumes[0];
  check('the next message resumes the same chat from disk, with the new model', s3.sessionId === 'sp-loss' && clients[1].creates.length === 0 && resumed?.model === 'gpt-5');
  check('with the same system message, streaming and tools as before',
    /You are Browy/.test(resumed?.systemMessage?.content) && resumed.systemMessage.content === opened.systemMessage.content
      && resumed.streaming === true && JSON.stringify(resumed.availableTools) === JSON.stringify(opened.availableTools));
  check('and tells the model its last turn was cut short', /<browy_note>[\s\S]*Copilot runtime quit[\s\S]*<\/browy_note>/.test(s3.sent[0]), s3.sent[0].slice(-400));
  s3.emit('session.idle');
  await t3;

  const t4 = agent.chat('again');
  await until('the fourth send', () => s3.sent.length === 2);
  check('just once', !/browy_note/.test(s3.sent[1]));
  s3.emit('session.idle');
  await t4;

  // After a sleep, a Copilot that no longer answers is restarted before the next message.
  clients[1].pingHangs = true;
  await agent.checkCopilot();
  await until('the second restart', () => ready() === 2);
  check('a Copilot that stopped answering after a sleep is restarted', clients.length === 3 && clients[1].stopped);

  // The connection closes while the CLI lingers. That is the third loss in
  // two minutes, so Copilot is left for the next message to start.
  const t5 = agent.chat('more');
  await until('the fifth send', () => clients[2].sessions[0]?.sent.length === 1);
  const tDrop = Date.now();
  clients[2].dropConnection();
  const r5 = await t5;
  check('a connection that closes on its own is noticed within seconds', r5.interrupted === 'copilot' && Date.now() - tDrop < 2500, `${Date.now() - tDrop} ms`);
  await tick(20);
  check('after three losses in two minutes it is not restarted by itself', clients.length === 3 && statuses.at(-1) === 'copilot_failed', statuses.join());

  const t6 = agent.chat('are you there');
  await until('the on-demand restart', () => clients[3]?.sessions[0]?.sent.length === 1);
  clients[3].sessions[0].emit('assistant.message', { messageId: 'm6', content: 'Yes.' });
  clients[3].sessions[0].emit('session.idle');
  const r6 = await t6;
  check('the next message starts it again and carries on', r6.text === 'Yes.' && !r6.stopped && clients[3].resumes.length === 1, JSON.stringify(r6));
} catch (e) {
  check('no unexpected error', false, e?.stack || String(e));
} finally {
  await agent.disconnect().catch(() => {});
  fs.rmSync(out, { recursive: true, force: true });
}

if (failures.length) {
  console.error('FAIL:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
console.log('PASS: Copilot quitting under a chat (11 assertions)');
process.exit(0);
