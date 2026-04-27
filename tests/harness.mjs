// Test harness for Browy.
// Connects to the running agent's WebSocket, sends prompts,
// captures every activity event the agent emits, and returns
// a clean transcript per scenario.
//
// Usage:
//   import { Harness } from './harness.mjs';
//   const h = new Harness();
//   await h.connect();
//   const result = await h.run({ name: 'page-info', prompt: 'What page am I on?' });
//   console.log(result);

import WebSocket from 'ws';

const DEFAULT_URL = 'ws://localhost:7890';

export class Harness {
  constructor({ url = DEFAULT_URL, verbose = false } = {}) {
    this.url = url;
    this.verbose = verbose;
    this.ws = null;
    this._listeners = new Set();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.on('open', () => {
        this.ws = ws;
        resolve();
      });
      ws.on('error', reject);
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (this.verbose) console.log('[ws]', msg);
        for (const fn of this._listeners) fn(msg);
      });
    });
  }

  close() {
    if (this.ws) this.ws.close();
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  clear() {
    return new Promise((resolve) => {
      const onMsg = (msg) => {
        if (msg.type === 'status' && msg.status === 'idle') {
          this._listeners.delete(onMsg);
          resolve();
        }
      };
      this._listeners.add(onMsg);
      this.send({ type: 'clear' });
      // Safety timeout
      setTimeout(() => { this._listeners.delete(onMsg); resolve(); }, 500);
    });
  }

  // Send a prompt and collect every event until we see the final response.
  // Returns a structured transcript of what happened.
  run({ name, prompt, timeoutMs = 90_000 }) {
    return new Promise((resolve, reject) => {
      const transcript = {
        name,
        prompt,
        startedAt: Date.now(),
        toolCalls: [],            // [{tool, args, result, durationMs}]
        statusEvents: [],         // [{status, t}]
        llmCalls: 0,              // count of llm_call_start
        totalLlmMs: 0,
        responseText: null,
        error: null,
        durationMs: 0,
      };

      const pending = new Map(); // tool name → start ts (one at a time per name is fine for our agent)
      const timer = setTimeout(() => {
        cleanup();
        transcript.error = `timeout after ${timeoutMs}ms`;
        transcript.durationMs = Date.now() - transcript.startedAt;
        resolve(transcript);
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        this._listeners.delete(onMsg);
      };

      const onMsg = (msg) => {
        if (msg.type === 'activity') {
          if (msg.event === 'tool_start') {
            pending.set(msg.tool, { args: msg.args, t0: Date.now() });
          } else if (msg.event === 'tool_end') {
            const start = pending.get(msg.tool);
            transcript.toolCalls.push({
              tool: msg.tool,
              args: start?.args ?? {},
              result: msg.result ?? '',
              durationMs: msg.durationMs ?? (start ? Date.now() - start.t0 : 0),
            });
            pending.delete(msg.tool);
          } else if (msg.event === 'llm_call_start') {
            transcript.llmCalls += 1;
            transcript._llmStart = Date.now();
          } else if (msg.event === 'llm_call_end') {
            transcript.totalLlmMs += msg.durationMs ?? 0;
          }
        } else if (msg.type === 'status') {
          transcript.statusEvents.push({ status: msg.status, t: Date.now() - transcript.startedAt, detail: msg.detail });
        } else if (msg.type === 'response') {
          transcript.responseText = msg.text;
          transcript.durationMs = Date.now() - transcript.startedAt;
          cleanup();
          resolve(transcript);
        }
      };

      this._listeners.add(onMsg);
      try {
        this.send({ type: 'chat', text: prompt });
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  }
}

// Pretty printer for a transcript.
export function formatTranscript(t, { showResults = true, color = true } = {}) {
  const c = color
    ? { dim: (s) => `\x1b[90m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m` }
    : { dim: (s) => s, bold: (s) => s, green: (s) => s, red: (s) => s, yellow: (s) => s, cyan: (s) => s };

  const lines = [];
  lines.push(c.bold(`▶ ${t.name}`));
  lines.push(c.dim(`  prompt: ${JSON.stringify(t.prompt)}`));
  lines.push(c.dim(`  duration: ${t.durationMs}ms · llm calls: ${t.llmCalls} · llm time: ${t.totalLlmMs}ms · tool calls: ${t.toolCalls.length}`));
  if (t.error) {
    lines.push(c.red(`  ✗ ERROR: ${t.error}`));
  }
  if (t.toolCalls.length === 0) {
    lines.push(c.yellow('  (no tool calls)'));
  } else {
    for (const tc of t.toolCalls) {
      const argsStr = JSON.stringify(tc.args).slice(0, 80);
      lines.push(c.cyan(`  ⚡ ${tc.tool}(${argsStr}) ${c.dim(`${tc.durationMs}ms`)}`));
      if (showResults) {
        const resStr = (tc.result || '').replace(/\s+/g, ' ').slice(0, 160);
        if (resStr) lines.push(c.dim(`     ↳ ${resStr}`));
      }
    }
  }
  if (t.responseText) {
    const preview = t.responseText.replace(/\s+/g, ' ').slice(0, 240);
    lines.push(c.green(`  ⇢ ${preview}${t.responseText.length > 240 ? '…' : ''}`));
  } else {
    lines.push(c.red('  ⇢ (no response)'));
  }
  return lines.join('\n');
}

// Heuristic checks against a transcript.
export function check(t, expectations = {}) {
  const failures = [];
  if (expectations.usedTool) {
    const wanted = Array.isArray(expectations.usedTool) ? expectations.usedTool : [expectations.usedTool];
    const used = new Set(t.toolCalls.map(tc => tc.tool));
    for (const w of wanted) if (!used.has(w)) failures.push(`expected tool '${w}' to be called`);
  }
  if (expectations.didNotUseTool) {
    const banned = Array.isArray(expectations.didNotUseTool) ? expectations.didNotUseTool : [expectations.didNotUseTool];
    for (const b of banned) {
      if (t.toolCalls.some(tc => tc.tool === b)) failures.push(`tool '${b}' should NOT have been used`);
    }
  }
  if (expectations.responseContains) {
    const needles = Array.isArray(expectations.responseContains) ? expectations.responseContains : [expectations.responseContains];
    const txt = (t.responseText || '').toLowerCase();
    for (const n of needles) if (!txt.includes(String(n).toLowerCase())) failures.push(`response missing '${n}'`);
  }
  if (expectations.maxToolCalls !== undefined && t.toolCalls.length > expectations.maxToolCalls) {
    failures.push(`too many tool calls: ${t.toolCalls.length} > ${expectations.maxToolCalls}`);
  }
  if (expectations.maxDurationMs !== undefined && t.durationMs > expectations.maxDurationMs) {
    failures.push(`too slow: ${t.durationMs}ms > ${expectations.maxDurationMs}ms`);
  }
  if (expectations.noError && t.error) failures.push(`unexpected error: ${t.error}`);
  return { ok: failures.length === 0, failures };
}
