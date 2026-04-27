// Scenario runner. Connects to the running agent, runs scripted prompts,
// optionally probes the live browser to verify ground truth, prints a report.
//
// Run while the agent is up (`node dist/cli.js` running):
//   node tests/run.mjs           # all scenarios
//   node tests/run.mjs basic     # only scenarios whose name starts with 'basic'
//   node tests/run.mjs --verbose # stream every WS message

import { Harness, formatTranscript, check } from './harness.mjs';
import { probe } from './probe.mjs';
import path from 'path';
import os from 'os';

const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const filter = argv.find((a) => !a.startsWith('--'));

// Each scenario:
//   name, prompt, expect (optional checks), probe (optional ground-truth assertion)
const SCENARIOS = [
  {
    name: 'basic.page-info',
    setup: 'Open any non-blank tab in your browser (e.g. wikipedia.org).',
    prompt: 'What page am I currently on? Just tell me the URL and title.',
    expect: { usedTool: 'get_page_info', noError: true, maxToolCalls: 3, maxDurationMs: 30_000 },
  },
  {
    name: 'basic.list-tabs',
    prompt: 'List my open tabs.',
    expect: { usedTool: 'list_tabs', noError: true, maxToolCalls: 3 },
  },
  {
    name: 'context.focused-tab',
    setup: 'Make sure a real page (not a chrome:// page) is the focused tab.',
    prompt: 'What is the main heading or title of the page I\'m looking at right now?',
    expect: { noError: true, maxToolCalls: 5 },
    probeCheck: (probeResult, transcript) => {
      // The agent should describe the focused page, not "new tab".
      if (!probeResult.focused) return null; // can't verify
      const txt = (transcript.responseText || '').toLowerCase();
      const fragment = (probeResult.focused.title || '').toLowerCase().split(/\s+/).filter(w => w.length > 4)[0];
      if (fragment && !txt.includes(fragment)) {
        return `response did not mention any keyword from focused tab title "${probeResult.focused.title}"`;
      }
      return null;
    },
  },
  {
    name: 'tool-restriction.no-default-tools',
    // If includeDefaultTools=false works, the agent shouldn't be able to read
    // local files or run shell commands. It should refuse or use only browser tools.
    prompt: 'List the files in C:\\Windows. Use any tool you have.',
    expect: {
      didNotUseTool: ['shell', 'read', 'bash', 'view'], // these are Copilot SDK default tool names
      noError: true,
    },
  },
  {
    name: 'code-exec.evaluate-js',
    setup: 'Open https://example.com in a tab and focus it.',
    prompt: 'How many <a> links are on this page? Use evaluate_js to count them.',
    expect: { usedTool: 'evaluate_js', noError: true, maxToolCalls: 5 },
  },
  {
    name: 'navigate.new-tab',
    prompt: 'Open https://example.com in a new tab.',
    expect: { usedTool: 'navigate', noError: true, maxToolCalls: 3 },
    probeCheck: (probeResult) => {
      const has = probeResult.tabs.some(t => t.url.includes('example.com'));
      return has ? null : 'expected example.com to be in open tabs after navigate';
    },
  },
  {
    name: 'efficiency.simple-question',
    prompt: 'What URL am I on right now?',
    expect: { noError: true, maxToolCalls: 2, maxDurationMs: 20_000 },
  },
  {
    // Two-turn scenario verifies that conversation history is preserved
    // across chat() calls (i.e. SDK session is reused, not recreated).
    name: 'memory.recall-across-turns',
    multiTurn: [
      { prompt: 'My favorite color is octarine. Just acknowledge.', expect: { noError: true } },
      { prompt: 'What did I just tell you my favorite color was? Answer in one word.', expect: { noError: true, responseContains: 'octarine' } },
    ],
  },
  {
    // Verify that BrowserAgent sessions live in a dedicated directory and
    // never appear in the user's normal copilot session list.
    name: 'isolation.session-namespacing',
    isolationCheck: true,
  },
];

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
};

async function main() {
  const harness = new Harness({ verbose });
  console.log(c.dim('Connecting to agent at ws://localhost:7890 ...'));
  try {
    await harness.connect();
  } catch (e) {
    console.error(c.red(`✗ Cannot connect: ${e.message}`));
    console.error(c.dim('  Make sure the agent is running:  node dist/cli.js'));
    process.exit(1);
  }
  console.log(c.green('✓ Connected'));

  const scenarios = filter ? SCENARIOS.filter((s) => s.name.startsWith(filter)) : SCENARIOS;
  if (scenarios.length === 0) {
    console.error(c.red(`No scenarios matched filter '${filter}'`));
    process.exit(1);
  }

  const results = [];
  for (const scn of scenarios) {
    console.log('\n' + c.bold(`════ ${scn.name} ════`));
    if (scn.setup) console.log(c.dim(`  setup hint: ${scn.setup}`));

    // Clear conversation between scenarios
    await harness.clear();

    if (scn.isolationCheck) {
      // Use the SDK directly to verify that:
      //   1. BrowserAgent sessions are tagged with our clientName/cwd
      //   2. They don't appear in the default-cwd session list
      const { CopilotClient } = await import('@github/copilot-sdk');
      const probeClient = new CopilotClient();
      let isolFailures = [];
      try {
        await probeClient.start();
        // Trigger BrowserAgent to create a session by sending one chat
        await harness.run({ name: scn.name + '#trigger', prompt: 'Hi.' });

        const ourSessions = await probeClient.listSessions({ cwd: path.join(os.homedir(), '.browseragent', 'sessions') });
        const taggedOurs = ourSessions.filter((s) => s.context?.cwd === path.join(os.homedir(), '.browseragent', 'sessions'));
        console.log(`  found ${taggedOurs.length} BrowserAgent session(s) in dedicated cwd`);
        if (taggedOurs.length === 0) isolFailures.push('expected at least 1 session in dedicated workdir');

        const userCwdSessions = await probeClient.listSessions({ cwd: process.cwd() });
        const leakedToUserCwd = userCwdSessions.filter((s) => s.context?.cwd === path.join(os.homedir(), '.browseragent', 'sessions'));
        if (leakedToUserCwd.length > 0) isolFailures.push(`${leakedToUserCwd.length} BrowserAgent session(s) leaked into cwd=${process.cwd()}`);
      } catch (e) {
        isolFailures.push(`isolation probe failed: ${e.message}`);
      } finally {
        try { await probeClient.stop(); } catch {}
      }
      if (isolFailures.length === 0) {
        console.log(c.green('  ✓ PASS'));
      } else {
        console.log(c.red('  ✗ FAIL'));
        for (const f of isolFailures) console.log(c.red(`    - ${f}`));
      }
      results.push({ name: scn.name, pass: isolFailures.length === 0, failures: isolFailures });
      continue;
    }

    if (scn.multiTurn) {
      // Run a sequence of prompts in the SAME conversation (no clear between).
      const turnFailures = [];
      let lastTranscript = null;
      for (let i = 0; i < scn.multiTurn.length; i++) {
        const turn = scn.multiTurn[i];
        console.log(c.dim(`  turn ${i + 1}/${scn.multiTurn.length}`));
        const transcript = await harness.run({ name: `${scn.name}#${i + 1}`, prompt: turn.prompt });
        console.log(formatTranscript(transcript));
        const r = check(transcript, turn.expect || {});
        for (const f of r.failures) turnFailures.push(`turn ${i + 1}: ${f}`);
        lastTranscript = transcript;
      }
      if (turnFailures.length === 0) {
        console.log(c.green('  ✓ PASS'));
      } else {
        console.log(c.red('  ✗ FAIL'));
        for (const f of turnFailures) console.log(c.red(`    - ${f}`));
      }
      results.push({ name: scn.name, pass: turnFailures.length === 0, failures: turnFailures, transcript: lastTranscript });
      continue;
    }

    const transcript = await harness.run({ name: scn.name, prompt: scn.prompt });
    console.log(formatTranscript(transcript));

    const checkResult = check(transcript, scn.expect || {});
    let probeFailures = [];
    if (scn.probeCheck) {
      try {
        const probeResult = await probe();
        const fail = scn.probeCheck(probeResult, transcript);
        if (fail) probeFailures.push(fail);
        if (verbose) console.log(c.dim('  probe: ' + JSON.stringify(probeResult.focused || {})));
      } catch (e) {
        probeFailures.push(`probe failed: ${e.message}`);
      }
    }

    const allFailures = [...checkResult.failures, ...probeFailures];
    if (allFailures.length === 0) {
      console.log(c.green('  ✓ PASS'));
    } else {
      console.log(c.red('  ✗ FAIL'));
      for (const f of allFailures) console.log(c.red(`    - ${f}`));
    }
    results.push({ name: scn.name, pass: allFailures.length === 0, failures: allFailures, transcript });
  }

  // Summary
  console.log('\n' + c.bold('════ SUMMARY ════'));
  const passed = results.filter(r => r.pass).length;
  for (const r of results) {
    const icon = r.pass ? c.green('✓') : c.red('✗');
    console.log(`  ${icon} ${r.name}${r.pass ? '' : c.red(` — ${r.failures.join('; ')}`)}`);
  }
  console.log(c.bold(`\n  ${passed}/${results.length} passed`));

  harness.close();
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
