// Interactive REPL that talks to the running agent over WebSocket
// and shows the FULL activity stream — every tool call, every status
// transition, every result. Useful for manually probing UX.
//
//   node tests/repl.mjs
//   > what page am I on?
//   ... (live stream of tool calls + final response)
//   > /clear
//   > /probe        # show ground-truth tab list from the browser
//   > /quit

import { Harness, formatTranscript } from './harness.mjs';
import { probe } from './probe.mjs';
import readline from 'readline';

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
};

const harness = new Harness({ verbose: false });
await harness.connect();
console.log(c.green('✓ Connected to agent'));

// Live event stream
harness._listeners.add((msg) => {
  if (msg.type === 'activity') {
    if (msg.event === 'tool_start') {
      const args = JSON.stringify(msg.args || {}).slice(0, 80);
      process.stdout.write(c.cyan(`  ⚡ ${msg.tool}(${args})`));
    } else if (msg.event === 'tool_end') {
      process.stdout.write(c.dim(` → ${msg.durationMs}ms\n`));
      const r = (msg.result || '').replace(/\s+/g, ' ').slice(0, 140);
      if (r) console.log(c.dim(`     ↳ ${r}`));
    } else if (msg.event === 'llm_call_start') {
      process.stdout.write(c.dim('  🧠 thinking...'));
    } else if (msg.event === 'llm_call_end') {
      process.stdout.write(c.dim(` ${msg.durationMs}ms\n`));
    }
  } else if (msg.type === 'status' && msg.status === 'error') {
    console.log(c.red(`  ✗ ${msg.detail}`));
  } else if (msg.type === 'response') {
    console.log('\n' + c.green('  ⇢ ') + msg.text + '\n');
  }
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: c.bold('> ') });
rl.prompt();

rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) return rl.prompt();
  if (text === '/quit' || text === '/exit') { harness.close(); process.exit(0); }
  if (text === '/clear') {
    await harness.clear();
    console.log(c.dim('  (history cleared)'));
    return rl.prompt();
  }
  if (text === '/probe') {
    try {
      const r = await probe();
      console.log(c.bold('  TABS:'));
      for (const t of r.tabs) {
        const flag = t.visibility === 'visible' ? c.green('●') : c.dim('○');
        console.log(`  ${flag} ${t.title || '(untitled)'} ${c.dim(t.url)}`);
      }
      if (r.focused) console.log(c.dim(`  focused → ${r.focused.url}`));
    } catch (e) { console.log(c.red(`  probe failed: ${e.message}`)); }
    return rl.prompt();
  }
  harness.send({ type: 'chat', text });
  // The response listener will print; just re-prompt after a short delay.
  // Use 'response' message to know when to re-prompt.
  const onMsg = (msg) => {
    if (msg.type === 'response') { harness._listeners.delete(onMsg); rl.prompt(); }
  };
  harness._listeners.add(onMsg);
});
