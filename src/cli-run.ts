// `browy run` — headless terminal agent (no browser required).
//
// This is a separate code path from the browser Agent in src/agent/loop.ts.
// It speaks to the Copilot SDK directly with its own default toolset
// (read_file, write_file, bash, grep, glob, web_fetch, ...), making it a
// drop-in `gh copilot`-style CLI powered by the user's existing GitHub
// Copilot subscription.
//
// Sessions live under ~/.browy/cli-sessions/ so they can never collide with
// either the user's regular `copilot` CLI sessions or Browy's browser
// sessions (which use ~/.browseragent/sessions/).
//
// Subcommands:
//   browy run "<task>"          one-shot — stream the agent's reply, exit
//   browy run                   interactive REPL — keep chatting until exit
//   browy run --resume <id>     resume a prior session by id
//   browy run --list            list recent sessions and exit
//
// Flags:
//   --model <id>                override the default model (e.g. gpt-5-mini)
//   --cwd <path>                working directory for file/shell tools
//                               (default: process.cwd())

import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { createInterface } from 'readline';

const require = createRequire(import.meta.url);
const { CopilotClient, approveAll } = require('@github/copilot-sdk');

const BROWY_CLI_CLIENT = 'browy-cli';
const BROWY_CLI_WORKDIR_DEFAULT = path.join(os.homedir(), '.browy', 'cli-sessions');

interface RunOptions {
  task: string | null;
  resumeId: string | null;
  listOnly: boolean;
  model: string | null;
  cwd: string;
}

function parseArgs(argv: string[]): RunOptions {
  const opts: RunOptions = {
    task: null,
    resumeId: null,
    listOnly: false,
    model: null,
    cwd: process.cwd(),
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list')          opts.listOnly = true;
    else if (a === '--resume')   opts.resumeId = argv[++i] || null;
    else if (a === '--model')    opts.model = argv[++i] || null;
    else if (a === '--cwd')      opts.cwd = argv[++i] || opts.cwd;
    else if (a === '--help' || a === '-h') { printRunHelp(); process.exit(0); }
    else rest.push(a);
  }
  if (rest.length) opts.task = rest.join(' ');
  return opts;
}

function printRunHelp() {
  console.log(`browy run — headless agent for the terminal

usage:
  browy run                          interactive REPL (no browser)
  browy run "<task description>"     one-shot — print reply and exit
  browy run --resume <session-id>    resume a prior session
  browy run --list                   list recent sessions

flags:
  --model <id>     override the model (e.g. gpt-5-mini, claude-sonnet-4.5)
  --cwd <path>     working directory for file/shell tools
                   (default: current directory)
  --help, -h       show this help

available tools (provided by the Copilot SDK):
  read_file, write_file, bash, grep, glob, web_fetch — full toolset.

sessions are stored under ~/.browy/cli-sessions/.
`);
}

export async function runHeadless(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);

  // Ensure the workdir exists — SDK uses it as cwd-tag for session listing.
  const fs = await import('fs');
  fs.mkdirSync(BROWY_CLI_WORKDIR_DEFAULT, { recursive: true });

  const client = new CopilotClient();
  await client.start();

  if (opts.listOnly) {
    await listSessions(client);
    process.exit(0);
  }

  let session: any = null;
  if (opts.resumeId) {
    try {
      session = await client.resumeSession(opts.resumeId, {
        clientName: BROWY_CLI_CLIENT,
        workingDirectory: opts.cwd,
        ...(opts.model ? { model: opts.model } : {}),
        onPermissionRequest: approveAll,
      });
    } catch (err) {
      console.error(`could not resume session ${opts.resumeId}: ${(err as Error).message}`);
      process.exit(1);
    }
  } else {
    session = await client.createSession({
      clientName: BROWY_CLI_CLIENT,
      workingDirectory: opts.cwd,
      ...(opts.model ? { model: opts.model } : {}),
      onPermissionRequest: approveAll,
    });
  }

  const sessionId = session.sessionId || session.id || '<unknown>';

  if (opts.task) {
    process.stderr.write(`\x1b[2msession ${sessionId} · ${opts.cwd}\x1b[0m\n`);
    await streamOnce(session, opts.task);
    try { await session.disconnect(); } catch {}
    process.exit(0);
  }

  // Interactive REPL.
  process.stderr.write(`browy run — terminal agent · session ${sessionId}\n`);
  process.stderr.write(`\x1b[2mcwd ${opts.cwd}\x1b[0m\n`);
  process.stderr.write(`\x1b[2mtype a task; "exit" to quit. Ctrl+D also quits.\x1b[0m\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'browy> ' });
  rl.prompt();
  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) { rl.prompt(); return; }
    if (text === 'exit' || text === 'quit') { rl.close(); return; }
    try {
      await streamOnce(session, text);
    } catch (err) {
      console.error('error:', (err as Error).message);
    }
    rl.prompt();
  });
  rl.on('close', async () => {
    try { await session.disconnect(); } catch {}
    process.exit(0);
  });
}

async function streamOnce(session: any, text: string): Promise<void> {
  const stream = await session.sendMessage(text);
  for await (const event of stream) {
    if (!event || typeof event !== 'object') continue;
    switch (event.type) {
      case 'text_delta':
      case 'text':
      case 'response.output_text.delta':
        if (typeof event.delta === 'string') process.stdout.write(event.delta);
        else if (typeof event.text === 'string') process.stdout.write(event.text);
        break;
      case 'tool_call':
      case 'tool_use': {
        const name = event.name || event.tool || '?';
        process.stderr.write(`\n\x1b[2m· ${name}\x1b[0m\n`);
        break;
      }
      case 'tool_result': {
        // Keep terminal output clean; tool results are large.
        break;
      }
      case 'error':
        process.stderr.write(`\n\x1b[31merror: ${event.message || JSON.stringify(event)}\x1b[0m\n`);
        break;
      default:
        // Unknown event types are no-ops; the SDK's stream shape evolves.
        break;
    }
  }
  process.stdout.write('\n');
}

async function listSessions(client: any): Promise<void> {
  let sessions: any[] = [];
  try {
    sessions = await client.listSessions({ clientName: BROWY_CLI_CLIENT });
  } catch {
    console.log('(this SDK build does not support session listing)');
    return;
  }
  if (!sessions || sessions.length === 0) {
    console.log('no `browy run` sessions yet — run `browy run "your task"` to create one.');
    return;
  }
  for (const s of sessions.slice(0, 30)) {
    const id = s.sessionId || s.id || '?';
    const cwd = s?.context?.cwd || '?';
    const summary = s.summary || '(no summary)';
    console.log(`${id}\n  cwd: ${cwd}\n  ${summary}\n`);
  }
}
