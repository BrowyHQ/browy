// The text of one assistant turn (agent/turn-text.ts).
//
// A turn can hold several assistant messages: the model says something, calls
// tools, then says more. Until 0.1.11 Browy compared each message against one
// running string for the whole turn, so a later message was dropped when it
// was shorter than everything said before it, and cut mid-word when it was
// longer. Seen on 14 October 2026: the panel showed only the first sentence of
// a Godot Forum run that went on for twenty more tool calls.
//
// Run: node tests/turn-text.mjs   (Node 23.6+ strips the .ts types itself)

import { TurnText } from '../src/agent/turn-text.ts';

const failures = [];
const check = (name, actual, expected) => {
  if (actual !== expected) failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
};

{
  // No streaming: each message arrives whole.
  const t = new TurnText();
  const first = 'Signed in as ritabrata_maiti. Before posting, I will read the pinned rules.';
  check('first message is shown', t.message('m1', first), first);
  check('a shorter later message is shown, not dropped', t.message('m2', 'Composing the topic now.'), 'Composing the topic now.');
  const long = 'Posted. Here is the link to the new topic in Showcase, along with what I filled in for the title, tags and body.';
  check('a longer later message is shown whole, not cut', t.message('m3', long), long);
  check('the turn keeps every message as its own paragraph', t.text, `${first}\n\nComposing the topic now.\n\n${long}`);
}

{
  // Streaming: deltas, then the finished message repeats the same text.
  const t = new TurnText();
  check('deltas pass through', t.delta('m1', 'Hel') + t.delta('m1', 'lo'), 'Hello');
  check('the finished message adds nothing already shown', t.message('m1', 'Hello'), '');
  check('a missed tail is filled in', (t.delta('m2', 'Done wi'), t.message('m2', 'Done with it.')), 'th it.');
  check('streamed turn text', t.text, 'Hello\n\nDone with it.');
}

{
  // A tool-only message has no text and must not leave an empty paragraph.
  const t = new TurnText();
  t.message('m1', '');
  t.message('m2', 'Only this.');
  check('empty messages are skipped', t.text, 'Only this.');
}

if (failures.length) {
  console.error('FAIL:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
console.log('PASS — turn text (9 assertions)');
