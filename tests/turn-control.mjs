// Stop, stuck browser calls, and two windows sharing one agent.
//
// 14 October 2026: a Godot Forum run called get_page_info, the extension never
// answered, and the turn sat silent until a five-minute watchdog gave up. The
// bridge had no deadline, Stop could not end a turn that was waiting on a
// tool, and a chat sent from a second window was refused outright.
//
// ExtensionContext and Runner use TypeScript parameter properties, which
// Node's type stripping can't run, so this bundles them with esbuild first.
//
// Run: node tests/turn-control.mjs

import * as esbuild from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browy-turn-control-'));
const load = async (entry) => {
  const out = path.join(tmp, path.basename(entry).replace(/\.ts$/, '.mjs'));
  await esbuild.build({ entryPoints: [path.join(here, '..', entry)], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent' });
  return import(pathToFileURL(out).href);
};
const { ExtensionContext } = await load('src/agent/extension-context.ts');
const { Runner } = await load('src/agent/runner.ts');

const failures = [];
const check = (name, cond, detail = '') => { if (!cond) failures.push(`${name}${detail ? `\n    ${detail}` : ''}`); };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ── the bridge gives up instead of waiting forever ─────────────────────────

{
  const sent = [];
  const silent = { id: 't', send: (m) => sent.push(m), onMessage() {}, onClose() {}, close() {} };
  const ext = new ExtensionContext('sp-a', silent, 50);
  const ctx = ext.build();

  const err = await ctx.cdp.send('Runtime.evaluate', { expression: '1' }).then(() => null, (e) => e);
  check('an unanswered CDP call fails instead of hanging', err && /no answer from the browser/.test(err.message), String(err));

  const pending = ctx.cdp.send('Runtime.evaluate', { expression: '2' }).then(() => null, (e) => e);
  ext.cancelPending('Stopped by the user.');
  const stopped = await pending;
  check('Stop releases a call that is still waiting', stopped && stopped.message === 'Stopped by the user.', String(stopped));
}

{
  // close_tab: the agent's current tab moves to whatever the browser shows next.
  let ext;
  const reply = (m, result) => setTimeout(() => ext.handleToolResult({ type: 'tool.result', sessionId: 'sp-a', callId: m.callId, ok: true, result }), 0);
  const tabs = [{ tabId: 1, url: 'https://a.test/', title: 'A', active: false }, { tabId: 2, url: 'https://b.test/', title: 'B', active: true }];
  const transport = {
    id: 't', onMessage() {}, onClose() {}, close() {},
    send: (m) => {
      if (m.type === 'tab.getActive') reply(m, tabs[1]);
      else if (m.type === 'tab.list') reply(m, tabs);
      else if (m.type === 'tab.close') reply(m, tabs[0]);
    },
  };
  ext = new ExtensionContext('sp-a', transport, 1000);
  const ctx = ext.build();
  await ctx.getActiveTabInfo();
  check('the current tab is known', ctx.getActivePageIndex() === 1, String(ctx.getActivePageIndex()));
  await ctx.getPages()[1].close();
  check('the closed tab leaves the list', ctx.getPages().length === 1);
  check('the agent moves to the tab now showing', ctx.getActivePageIndex() === 0, String(ctx.getActivePageIndex()));
}

// ── one agent, several panels ──────────────────────────────────────────────

function fakeAgent() {
  const a = {
    chats: [], aborts: 0, current: null,
    setActivityCallback() {}, setBrowyProtocolSessionId() {}, setBrowserContextOverride() {},
    setDisabledTools() {}, setEnabledHostTools() {}, getModel: () => 'm', listModels: async () => [],
    chat(text) {
      a.chats.push(text);
      return new Promise((resolve) => { a.current = resolve; });
    },
    finish(text) { const r = a.current; a.current = null; r({ text, toolCalls: [] }); },
    async abort() {
      a.aborts++;
      const r = a.current; a.current = null;
      if (r) r({ text: 'partial', toolCalls: [], stopped: true });
    },
  };
  return a;
}

function harness() {
  const agent = fakeAgent();
  const runner = new Runner(agent, { serverVersion: 'test' });
  const out = [];
  let deliver;
  runner.attach({ id: 'native', send: (m) => out.push(m), onMessage: (cb) => { deliver = cb; }, onClose() {}, close() {} });
  const send = async (m) => { deliver(m); await tick(); };
  return { agent, out, send, of: (sid, type) => out.filter((m) => m.sessionId === sid && m.type === type) };
}

{
  const h = harness();
  await h.send({ type: 'session.start', sessionId: 'sp-a', capabilities: [] });
  await h.send({ type: 'session.start', sessionId: 'sp-b', capabilities: [] });
  await h.send({ type: 'chat.send', sessionId: 'sp-a', text: 'first' });
  await h.send({ type: 'chat.send', sessionId: 'sp-b', text: 'second' });
  check('a second window waits in line instead of erroring', h.of('sp-b', 'chat.queued').length === 1 && h.of('sp-b', 'chat.error').length === 0,
    JSON.stringify(h.out.filter((m) => m.sessionId === 'sp-b')));
  check('it does not start while the first runs', h.agent.chats.join() === 'first');
  h.agent.finish('done a');
  await tick();
  check('it starts as soon as the first ends', h.agent.chats.join() === 'first,second');
  h.agent.finish('done b');
  await tick();
  check('both panels get their own answer', h.of('sp-a', 'chat.done')[0]?.text === 'done a' && h.of('sp-b', 'chat.done')[0]?.text === 'done b');
}

{
  const h = harness();
  await h.send({ type: 'session.start', sessionId: 'sp-a', capabilities: [] });
  await h.send({ type: 'session.start', sessionId: 'sp-b', capabilities: [] });
  await h.send({ type: 'chat.send', sessionId: 'sp-a', text: 'first' });
  await h.send({ type: 'chat.send', sessionId: 'sp-b', text: 'second' });
  await h.send({ type: 'chat.cancel', sessionId: 'sp-b' });
  check('Stop on a waiting chat ends it without touching the running one', h.agent.aborts === 0 && h.of('sp-b', 'chat.done')[0]?.stopped === true);
  h.agent.finish('done a');
  await tick();
  check('a cancelled chat never runs', h.agent.chats.join() === 'first');
}

{
  const h = harness();
  await h.send({ type: 'session.start', sessionId: 'sp-a', capabilities: [] });
  await h.send({ type: 'chat.send', sessionId: 'sp-a', text: 'first' });
  await h.send({ type: 'chat.cancel', sessionId: 'sp-a' });
  const done = h.of('sp-a', 'chat.done')[0];
  check('Stop ends the running turn at once with what was said', h.agent.aborts === 1 && done?.stopped === true && done?.text === 'partial', JSON.stringify(done));
}

{
  const h = harness();
  await h.send({ type: 'session.start', sessionId: 'sp-a', capabilities: [] });
  await h.send({ type: 'session.start', sessionId: 'sp-b', capabilities: [] });
  await h.send({ type: 'chat.send', sessionId: 'sp-a', text: 'first' });
  await h.send({ type: 'chat.send', sessionId: 'sp-b', text: 'second' });
  await h.send({ type: 'session.end', sessionId: 'sp-a' });
  check('closing a panel mid-turn stops its turn', h.agent.aborts === 1);
  check('and the next window in line gets the agent', h.agent.chats.join() === 'first,second');
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failures.length) {
  console.error('FAIL:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
console.log('PASS — turn control (14 assertions)');
