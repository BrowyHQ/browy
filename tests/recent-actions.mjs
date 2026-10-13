// <recent_actions> belongs to one chat.
//
// One Agent serves every chat in the host. When the buffer was shared, a new
// chat's first prompt carried the previous chat's tool calls; asked to fill a
// form it had just filled in another chat, the model said the form was filled
// and called no tools. Recorded on 13 October 2026 while filming the demo.
//
// Run: node tests/recent-actions.mjs   (Node 23.6+ strips the .ts types itself)

import { RecentActions } from '../src/agent/recent-actions.ts';

const failures = [];
const check = (name, cond, detail = '') => { if (!cond) failures.push(`${name}${detail ? `\n    ${detail}` : ''}`); };
const act = (name) => ({ name, args: '{}', result: 'done', ok: true, ms: 3 });

const r = new RecentActions(5);
r.record('chat-a', act('extract_form'));
r.record('chat-a', act('fill_form'));

check('a new chat starts with no recent actions', r.serialize('chat-b') === '', JSON.stringify(r.serialize('chat-b')));
check("the chat that ran them still sees them", /fill_form/.test(r.serialize('chat-a')) && /<recent_actions>/.test(r.serialize('chat-a')));

r.record('chat-b', act('list_tabs'));
check("chat b sees only its own", !/fill_form/.test(r.serialize('chat-b')) && /list_tabs/.test(r.serialize('chat-b')));
check("chat a is untouched by chat b", !/list_tabs/.test(r.serialize('chat-a')));

for (let i = 0; i < 7; i++) r.record('chat-c', act(`step_${i}`));
const c = r.serialize('chat-c');
check('keeps the last five per chat', !/step_0|step_1\b/.test(c) && /step_2/.test(c) && /step_6/.test(c), c);

r.clear('chat-a');
check('clearing a chat empties only that chat', r.serialize('chat-a') === '' && /list_tabs/.test(r.serialize('chat-b')));

if (failures.length) {
  console.error(`recent-actions: ${failures.length} failure(s)\n  ` + failures.join('\n  '));
  process.exit(1);
}
console.log('recent-actions: all checks passed');
