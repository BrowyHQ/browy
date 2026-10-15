// Replies to chat.list and chat.history (agent/runner.ts).
//
// The side panel opens its chats list from a cache and refreshes it in the
// background, and renders chats a page at a time from the Copilot session.
// Every panel used to receive every chat.list / chat.history reply: a side
// panel opening its list made the DevTools panel print it. A 0.1.14 panel
// names its session, so its replies are routed to it alone. Older panels and
// the DevTools panel send no new fields and get the old replies.
//
// Run: node tests/chat-replies.mjs

import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const built = await esbuild.build({
  entryPoints: [path.join(here, '..', 'src', 'agent', 'runner.ts')],
  bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
});
const { Runner } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));

const failures = [];
const check = (name, cond, detail = '') => { if (!cond) failures.push(`${name}${detail ? `\n    ${detail}` : ''}`); };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const fast = [{ id: 'sp-new', startTime: 2, modifiedTime: 2 }];
const all = [...fast, { id: '9135-old', startTime: 1, modifiedTime: 1 }];
const agent = {
  setActivityCallback() {}, setDisabledTools() {}, setEnabledHostTools() {}, getModel: () => 'm', listModels: async () => [],
  async listChats(onFast) { if (onFast) onFast(fast); await tick(5); return all; },
  async getHistory(id, opts) { return { items: [{ kind: 'turn', turn: 4 }], start: 4, end: 5, total: 5, opts }; },
  async getChatMessages() { return [{ role: 'user', text: 'hi' }]; },
};
const runner = new Runner(agent, { serverVersion: 'test' });
const out = [];
let deliver;
runner.attach({ id: 'native', send: (m) => out.push(m), onMessage: (cb) => { deliver = cb; }, onClose() {}, close() {} });
const send = async (m) => { out.length = 0; deliver(m); await tick(20); return out.filter((x) => x.type !== 'session.ready' && x.type !== 'models.current'); };

await send({ type: 'session.start', sessionId: 'sp-a', capabilities: [] });

{
  const r = await send({ type: 'chat.list', reqId: 'q1', sessionId: 'sp-a', progressive: true });
  check('a progressive list replies twice', r.length === 2, JSON.stringify(r));
  check('first with the quick list', r[0]?.complete === false && r[0].chats.length === 1);
  check('then with every chat', r[1]?.complete === true && r[1].chats.length === 2);
  check('both carry the request id and go to the asking panel', r.every((m) => m.reqId === 'q1' && m.sessionId === 'sp-a'));
}
{
  const r = await send({ type: 'chat.list' });
  check('an old-style list gets one full, unrouted reply', r.length === 1 && r[0].chats.length === 2 && !('sessionId' in r[0]) && !('complete' in r[0]), JSON.stringify(r));
}
{
  const r = await send({ type: 'chat.list', reqId: 'q2', sessionId: 'sp-gone' });
  check('a session the host has never seen is not used for routing', r.length === 1 && !('sessionId' in r[0]) && r[0].reqId === 'q2', JSON.stringify(r));
}
{
  const r = await send({ type: 'chat.history', id: 'sp-x', items: true, limit: 3, before: 5, reqId: 'h1', sessionId: 'sp-a' });
  const m = r[0];
  check('an items request gets a page', m?.items?.length === 1 && m.start === 4 && m.total === 5 && !m.messages, JSON.stringify(r));
  check('with its paging options passed on', m?.opts?.limit === 3 && m.opts.before === 5);
  check('routed to the asking panel', m?.reqId === 'h1' && m.sessionId === 'sp-a');
}
{
  const r = await send({ type: 'chat.history', id: 'sp-x' });
  check('an old-style history request gets messages', r[0]?.messages?.[0]?.text === 'hi' && !r[0].items && !('sessionId' in r[0]), JSON.stringify(r));
}
{
  agent.getHistory = async () => { throw new Error('disk on fire'); };
  const r = await send({ type: 'chat.history', id: 'sp-x', items: true, reqId: 'h2', sessionId: 'sp-a' });
  check('a failed read answers with the error instead of a chat error', r.length === 1 && r[0].type === 'chat.history.result' && r[0].error === 'disk on fire', JSON.stringify(r));
}
{
  // An empty list would read as "no chats yet" in the panel.
  agent.listChats = async () => { throw new Error('Copilot is not running'); };
  const r = await send({ type: 'chat.list', reqId: 'q3', sessionId: 'sp-a', progressive: true });
  check('a failed list says so', r.length === 1 && r[0].error === 'Copilot is not running' && r[0].chats.length === 0 && r[0].reqId === 'q3', JSON.stringify(r));
}

if (failures.length) {
  console.error('FAIL:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
console.log('PASS: chat.list / chat.history replies');
