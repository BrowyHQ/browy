// What the side panel shows of a chat (agent/chat-items.ts).
//
// The panel renders chats straight from the Copilot session. Until 0.1.13 it
// kept its own HTML copy of every chat as the record, and the host read a
// chat's transcript by resuming the session. Real chats are big: one from
// 15 October had 977 tool calls, 457 of them in one turn, and a 7.6 MB
// events file. These checks cover the parts that keep that readable and small.
//
// Run: node tests/chat-items.mjs   (Node 23.6+ strips the .ts types itself)

import { stripContext, shortArgs, eventsToTurns, pageTurns, legacyMessages, PAGE_BYTES, RESULT_CHARS } from '../src/agent/chat-items.ts';

const failures = [];
const check = (name, cond, detail = '') => { if (!cond) failures.push(`${name}${detail ? `\n    ${detail}` : ''}`); };

const ctx = '\n\n<browser_context>\nBrowser:    Chrome\nURL:        https://example.com/\n</browser_context>\n<page_snapshot>\n<page_stats>\n3 links\n</page_stats>\n[1]<a href=/x>X</a>\n</page_snapshot>\n<recent_actions>\n- click_index({"index":1}) → ok 12ms\n</recent_actions>\n';

// ── the user sees only what they typed ─────────────────────────────────────

check('context after the text is removed', stripContext('summarize this page' + ctx) === 'summarize this page');
check('context ahead of the text (older Browy) is removed', stripContext(ctx + 'and the next one') === 'and the next one');
check('a block cut off at the end is removed', stripContext('go on\n\n<browser_context>\nURL: https://a.test') === 'go on');
check('plain text is kept as is', stripContext('what is <b>bold</b>?') === 'what is <b>bold</b>?');
check('tool args become one short line', shortArgs({ index: 4, text: 'hello\nworld' }) === '4, hello world');
check('long args are cut', shortArgs({ code: 'x'.repeat(500) }).length === 120);

// ── events → turns ─────────────────────────────────────────────────────────

let n = 0;
const at = (s) => new Date(Date.UTC(2026, 9, 15, 9, 0, s)).toISOString();
const ev = (type, data, extra = {}) => ({ type, data, id: `e${n++}`, timestamp: at(n), ...extra });
const events = [
  ev('session.start', { sessionId: 'sp-test' }),
  ev('user.message', { content: 'check the page' + ctx }),
  ev('assistant.message', { content: 'Looking.', toolRequests: [{ toolCallId: 't1', name: 'get_page_info' }] }),
  ev('tool.execution_start', { toolCallId: 'ri', toolName: 'report_intent', arguments: { intent: 'Looking' } }),
  ev('tool.execution_start', { toolCallId: 't1', toolName: 'get_page_info', arguments: {} }),
  ev('tool.execution_complete', { toolCallId: 't1', success: true, result: { content: 'R'.repeat(5000) } }),
  ev('tool.execution_start', { toolCallId: 't2', toolName: 'click_index', arguments: { index: 7 } }),
  ev('tool.execution_complete', { toolCallId: 't2', success: false, error: { message: 'element 7 is gone', code: 'failure' } }),
  ev('assistant.message', { content: 'Sub-agent noise', parentToolCallId: 't2' }),
  ev('assistant.message', { content: 'Done: the page is about kiwis.' }),
  ev('user.message', { content: 'now wait' + ctx }),
  ev('tool.execution_start', { toolCallId: 't3', toolName: 'wait_for', arguments: { ms: '3000' } }),
  ev('abort', { reason: 'user_initiated' }),
  ev('user.message', { content: 'and again' }),
  ev('tool.execution_start', { toolCallId: 't4', toolName: 'wait_for', arguments: { ms: '3000' } }),
];

{
  const turns = eventsToTurns(events);
  check('one turn per user message', turns.length === 3, `${turns.length} turns`);
  const [t0, t1, t2] = turns;
  const user = t0.find((i) => i.kind === 'user');
  check('the user item has no injected context', user && user.text === 'check the page', JSON.stringify(user));
  const tools = t0.filter((i) => i.kind === 'tool');
  check('bookkeeping tools are left out', !tools.some((t) => t.name === 'report_intent'));
  check('a tool result is trimmed', tools[0].status === 'ok' && tools[0].result.length === RESULT_CHARS, `${tools[0].result?.length}`);
  check('a tool call has its duration', tools[0].durationMs === 1000, String(tools[0].durationMs));
  check('a failed tool carries the error', tools[1].status === 'error' && tools[1].result === 'element 7 is gone', JSON.stringify(tools[1]));
  const said = t0.filter((i) => i.kind === 'assistant').map((i) => i.text);
  check('sub-agent messages are left out', said.join('|') === 'Looking.|Done: the page is about kiwis.', said.join('|'));
  check('every item knows its turn', t1.every((i) => i.turn === 1) && t2.every((i) => i.turn === 2));
  check('a stopped turn says so', t1[0].end === 'stopped');
  check("a stopped turn's unfinished call shows as stopped", t1.find((i) => i.kind === 'tool').status === 'stopped');
  check('an old unfinished call shows as stopped', t2.find((i) => i.kind === 'tool').status === 'stopped');
  const live = eventsToTurns(events, { live: true });
  check('the running turn keeps its running call', live[2].find((i) => i.kind === 'tool').status === 'running');
}

// ── pages ──────────────────────────────────────────────────────────────────

{
  const many = [];
  for (let i = 0; i < 25; i++) {
    many.push(ev('user.message', { content: `question ${i}` + ctx }));
    many.push(ev('assistant.message', { content: `answer ${i}` }));
  }
  const turns = eventsToTurns(many);
  const p1 = pageTurns(turns, { limit: 10 });
  check('the first page is the newest turns', p1.start === 15 && p1.end === 25 && p1.total === 25, JSON.stringify({ ...p1, items: undefined }));
  const p2 = pageTurns(turns, { limit: 10, before: p1.start });
  check('the next page comes before it', p2.start === 5 && p2.end === 15);
  const p3 = pageTurns(turns, { limit: 10, before: p2.start });
  check('the last page reaches the first turn', p3.start === 0 && p3.end === 5 && p3.items[1].text === 'question 0');
}

{
  // One turn with 1000 tool calls and long results, like the 15 October run.
  const big = [ev('user.message', { content: 'work through the inbox' + ctx })];
  for (let i = 0; i < 1000; i++) {
    big.push(ev('tool.execution_start', { toolCallId: `b${i}`, toolName: 'evaluate_js', arguments: { code: 'document.title'.repeat(20) } }));
    big.push(ev('tool.execution_complete', { toolCallId: `b${i}`, success: true, result: { content: 'Z'.repeat(3000) } }));
  }
  const turns = eventsToTurns(big);
  const page = pageTurns(turns, { limit: 10 });
  const size = Buffer.byteLength(JSON.stringify(page), 'utf8');
  check('a huge turn still fits one reply', size < PAGE_BYTES && size < 1024 * 1024, `${size} bytes`);
  const tools = page.items.filter((i) => i.kind === 'tool');
  const clipped = page.items[0].clipped || 0;
  check('no tool call goes missing without a count', tools.length + clipped === 1000, `${tools.length} shown, ${clipped} clipped`);
  check('the user text survives trimming', page.items.some((i) => i.kind === 'user' && i.text === 'work through the inbox'));
}

// ── the reply older panels understand ──────────────────────────────────────

{
  const msgs = legacyMessages(eventsToTurns(events));
  check('legacy replies keep the old roles', msgs.map((m) => m.role).join(',') === 'user,assistant,tool,tool,assistant,user,tool,user,tool', msgs.map((m) => m.role).join(','));
  check('legacy tool rows keep the old shape', msgs[2].name === 'get_page_info' && msgs[2].ok === true && msgs[2].summary.length === 120);
  const capped = legacyMessages(eventsToTurns(events), 400);
  check('legacy replies drop the oldest messages to fit', capped.length < msgs.length && capped.at(-1).role === 'tool');
}

if (failures.length) {
  console.error('FAIL:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
console.log('PASS: chat items from the Copilot session');
