// What the side panel shows of a chat, built from the chat's Copilot session.
//
// The session is the only record of a conversation. The panel renders these
// items and keeps no transcript of its own: stored history arrives as items,
// and when a live turn finishes the panel swaps it for the same turn read back
// from the session, so the two can't drift apart.
//
// Real chats are big. One from 15 October had 977 tool calls (457 in a single
// turn) and a 7.6 MB events file, so results are trimmed here, chats go out a
// page of turns at a time, and every reply stays well under Chrome's 1 MB
// limit for a message from a native host (a bigger one drops the connection).

/** Start of a user turn. Every item carries the index of its turn, counted
 *  from the start of the chat, so pages from different reads line up. */
export interface TurnItem {
  kind: 'turn';
  turn: number;
  ts?: number;
  /** The user pressed Stop, or the turn ended on an error. */
  end?: 'stopped' | 'error';
  error?: string;
  /** Items of this turn left out to keep the reply small. */
  clipped?: number;
}
/** What the user typed, without the page context Browy sends along with it. */
export interface UserItem { kind: 'user'; turn: number; text: string; ts?: number }
/** One message from the model. A turn often has several. */
export interface AssistantItem { kind: 'assistant'; turn: number; text: string; ts?: number }
export type ToolStatus = 'ok' | 'error' | 'running' | 'stopped';
/** One tool call, with short args and a trimmed result. */
export interface ToolItem {
  kind: 'tool';
  turn: number;
  id: string;
  name: string;
  args: string;
  status: ToolStatus;
  result?: string;
  durationMs?: number;
  ts?: number;
}
export type ChatItem = TurnItem | UserItem | AssistantItem | ToolItem;

/** A page of turns: items for turns [start, end) of `total`. */
export interface ChatPage { items: ChatItem[]; start: number; end: number; total: number }

/** The shape the side panel and DevTools panel understood before items. */
export type LegacyMessage =
  | { role: 'user'; text: string; timestamp?: number }
  | { role: 'assistant'; text: string; timestamp?: number }
  | { role: 'tool'; name: string; ok: boolean; summary?: string; timestamp?: number };

export const RESULT_CHARS = 600;
export const ARGS_CHARS = 120;
export const PAGE_TURNS = 10;
export const MAX_PAGE_TURNS = 50;
/** Byte budget for one page. Chrome drops a native host that sends more than 1 MB. */
export const PAGE_BYTES = 600_000;
export const LEGACY_BYTES = 700_000;

/** Tools the runtime calls for its own bookkeeping; nothing happened in the browser. */
const HIDDEN_TOOLS = new Set(['report_intent']);

const CONTEXT_TAGS = ['browser_context', 'page_snapshot', 'recent_actions', 'page_stats', 'page_info'];

/** The user's own words. Browy sends every message with a <browser_context>,
 *  <page_snapshot> and <recent_actions> block after it (before 0.1.x, ahead
 *  of it), which the user never typed. */
export function stripContext(text: string): string {
  let out = String(text || '');
  for (const t of CONTEXT_TAGS) out = out.replace(new RegExp(`<${t}>[\\s\\S]*?</${t}>`, 'g'), '');
  // A block whose closing tag is missing runs to the end.
  for (const t of CONTEXT_TAGS) out = out.replace(new RegExp(`<${t}>[\\s\\S]*$`), '');
  return out.trim();
}

export function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Tool arguments on one short line: the values, in order. */
export function shortArgs(args: unknown, max = ARGS_CHARS): string {
  if (args == null) return '';
  let vals: string[];
  if (typeof args === 'object' && !Array.isArray(args)) {
    vals = Object.values(args as Record<string, unknown>).map((v) => {
      if (typeof v === 'string') return v;
      if (v == null) return '';
      try { return JSON.stringify(v); } catch { return String(v); }
    });
  } else {
    vals = [typeof args === 'string' ? args : JSON.stringify(args)];
  }
  return clip(vals.filter(Boolean).join(', ').replace(/\s+/g, ' ').trim(), max);
}

function resultText(r: unknown): string {
  if (r == null) return '';
  if (typeof r === 'string') return r;
  if (typeof r === 'object') {
    const o = r as Record<string, unknown>;
    if (typeof o.content === 'string') return o.content;
    if (typeof o.textResultForLlm === 'string') return o.textResultForLlm;
  }
  try { return JSON.stringify(r); } catch { return String(r); }
}

function errorText(e: unknown): string {
  if (!e) return '';
  if (typeof e === 'string') return e;
  const m = (e as { message?: unknown }).message;
  return typeof m === 'string' ? m : resultText(e);
}

function tsOf(ev: any): number | undefined {
  const t = ev?.timestamp;
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'number') return t;
  if (typeof t === 'string') {
    const n = Date.parse(t);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Group a session's events into turns of items, oldest first.
 *
 *  `live` means the chat's last turn is still running, so its unfinished tool
 *  calls stay "running". Otherwise a call that never finished was cut off,
 *  by Stop or by a restart, and shows as stopped. */
export function eventsToTurns(events: readonly any[], opts: { live?: boolean } = {}): ChatItem[][] {
  const turns: ChatItem[][] = [];
  const tools = new Map<string, ToolItem>();
  let cur: ChatItem[] | null = null;
  const head = (): TurnItem | null => (cur ? cur[0] as TurnItem : null);
  const ensureTurn = (ts?: number): ChatItem[] => {
    if (!cur) {
      cur = [{ kind: 'turn', turn: turns.length, ...(ts !== undefined ? { ts } : {}) }];
      turns.push(cur);
    }
    return cur;
  };
  const settle = (list: ChatItem[] | null) => {
    if (!list) return;
    for (const it of list) if (it.kind === 'tool' && it.status === 'running') it.status = 'stopped';
  };

  for (const ev of events || []) {
    if (!ev || typeof ev !== 'object' || ev.ephemeral) continue;
    const d = ev.data || {};
    // Sub-agent chatter belongs to the tool call that started it.
    if (ev.agentId || d.parentToolCallId) continue;
    const ts = tsOf(ev);
    switch (ev.type) {
      case 'user.message': {
        const text = stripContext(typeof d.content === 'string' ? d.content : '');
        if (!text) break;
        settle(cur);
        cur = null;
        const list = ensureTurn(ts);
        list.push({ kind: 'user', turn: (list[0] as TurnItem).turn, text, ...(ts !== undefined ? { ts } : {}) });
        break;
      }
      case 'assistant.message': {
        const text = typeof d.content === 'string' ? d.content : '';
        if (!text.trim()) break;
        const list = ensureTurn(ts);
        list.push({ kind: 'assistant', turn: (list[0] as TurnItem).turn, text, ...(ts !== undefined ? { ts } : {}) });
        break;
      }
      case 'tool.execution_start': {
        const name = String(d.toolName || d.name || 'tool');
        if (HIDDEN_TOOLS.has(name)) break;
        const list = ensureTurn(ts);
        const id = String(d.toolCallId || `${name}-${list.length}`);
        const item: ToolItem = {
          kind: 'tool', turn: (list[0] as TurnItem).turn, id, name,
          args: shortArgs(d.arguments), status: 'running', ...(ts !== undefined ? { ts } : {}),
        };
        list.push(item);
        tools.set(id, item);
        break;
      }
      case 'tool.execution_complete': {
        const item = tools.get(String(d.toolCallId || ''));
        if (!item) break;
        const ok = d.success !== false && !d.error;
        item.status = ok ? 'ok' : 'error';
        const text = ok ? resultText(d.result) : (errorText(d.error) || resultText(d.result));
        if (text) item.result = clip(text, RESULT_CHARS);
        if (ts !== undefined && item.ts !== undefined) item.durationMs = Math.max(0, ts - item.ts);
        break;
      }
      case 'abort': {
        const h = head();
        if (h) { h.end = 'stopped'; settle(cur); }
        break;
      }
      case 'session.error': {
        const h = head();
        if (h) {
          h.end = 'error';
          const m = typeof d.message === 'string' ? d.message : '';
          if (m) h.error = clip(m, RESULT_CHARS);
        }
        break;
      }
    }
  }
  if (!opts.live) settle(cur);
  return turns;
}

function bytes(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v), 'utf8');
}

/** Make one turn fit in `budget` bytes: shorter results first, then none,
 *  then only its newest steps. */
function fitTurn(turn: ChatItem[], budget: number): ChatItem[] {
  if (bytes(turn) <= budget) return turn;
  const shorter = turn.map((it) => (it.kind === 'tool' && it.result ? { ...it, result: clip(it.result, 160) } : it));
  if (bytes(shorter) <= budget) return shorter;
  const bare = shorter.map((it) => {
    if (it.kind === 'tool' && it.result !== undefined) { const { result: _r, ...rest } = it; return rest as ToolItem; }
    if (it.kind === 'assistant') return { ...it, text: clip(it.text, 20_000) };
    return it;
  });
  if (bytes(bare) <= budget) return bare;
  // Keep the turn's head and the user's words, then the newest items that fit.
  const head = { ...(bare[0] as TurnItem) };
  const fixed: ChatItem[] = [head, ...bare.slice(1).filter((it) => it.kind === 'user')];
  let used = bytes(fixed);
  const kept: ChatItem[] = [];
  const rest = bare.slice(1).filter((it) => it.kind !== 'user');
  for (let i = rest.length - 1; i >= 0; i--) {
    const n = bytes(rest[i]) + 1;
    if (used + n > budget) break;
    used += n;
    kept.unshift(rest[i]);
  }
  head.clipped = (head.clipped || 0) + rest.length - kept.length;
  return [...fixed, ...kept];
}

/** The `limit` turns before `before` (default: the newest), within `maxBytes`.
 *  Drops whole turns from the old end first; a single turn that is still too
 *  big is trimmed by fitTurn. */
export function pageTurns(
  turns: readonly ChatItem[][],
  opts: { limit?: number; before?: number; maxBytes?: number } = {},
): ChatPage {
  const total = turns.length;
  const limit = Math.max(1, Math.min(MAX_PAGE_TURNS, Math.floor(Number(opts.limit) || PAGE_TURNS)));
  const maxBytes = opts.maxBytes || PAGE_BYTES;
  const before = opts.before;
  const end = before === undefined || before === null || !Number.isFinite(Number(before))
    ? total
    : Math.max(0, Math.min(total, Math.floor(Number(before))));
  let start = Math.max(0, end - limit);
  let page = turns.slice(start, end);
  let size = bytes(page);
  while (size > maxBytes && page.length > 1) {
    page = page.slice(1);
    start++;
    size = bytes(page);
  }
  if (size > maxBytes && page.length === 1) page = [fitTurn(page[0], maxBytes - 64)];
  return { items: page.flat(), start, end, total };
}

/** The pre-items reply, for side panels and DevTools panels that still ask
 *  for `messages`. Newest messages win when it has to be cut. */
export function legacyMessages(turns: readonly ChatItem[][], maxBytes = LEGACY_BYTES): LegacyMessage[] {
  const out: LegacyMessage[] = [];
  for (const turn of turns) {
    for (const it of turn) {
      if (it.kind === 'user') out.push({ role: 'user', text: it.text, ...(it.ts !== undefined ? { timestamp: it.ts } : {}) });
      else if (it.kind === 'assistant') out.push({ role: 'assistant', text: it.text, ...(it.ts !== undefined ? { timestamp: it.ts } : {}) });
      else if (it.kind === 'tool') {
        out.push({
          role: 'tool', name: it.name, ok: it.status !== 'error',
          ...(it.result ? { summary: clip(it.result, 120) } : {}),
          ...(it.ts !== undefined ? { timestamp: it.ts } : {}),
        });
      }
    }
  }
  let size = bytes(out);
  let drop = 0;
  while (size > maxBytes && drop < out.length - 1) {
    size -= bytes(out[drop]) + 1;
    drop++;
  }
  return drop ? out.slice(drop) : out;
}
