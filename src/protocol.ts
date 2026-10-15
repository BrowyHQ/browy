// BrowyProtocol — the canonical message envelope between Browy Core and any
// frontend (browser extension side panel, DevTools panel REPL, terminal CLI,
// future VS Code, etc).
//
// Design goals:
//   - Transport agnostic. Same JSON shape over WebSocket, native messaging
//     stdio, or test in-process channels.
//   - Multi-session. One transport may host many concurrent sessions
//     (e.g. side panel + DevTools panel sharing one native-host port).
//   - Capability-driven tools. Clients declare what they can do at session
//     start; Core only offers tools the client can fulfill.
//
// Naming convention: <namespace>.<verb>. Lowercase, dot-separated.

import type { ToolCallRecord, ModelOption, BrowserStatus, ActiveBrowser } from './types.js';
import type { ChatItem } from './agent/chat-items.js';

// ── Capabilities ───────────────────────────────────────────────────────────
//
// A capability is something the *client* can do for the agent. Examples:
//   cdp.activeTab    — client can run CDP commands on the currently-focused
//                      browser tab and stream events back.
//   cdp.allTabs      — client can enumerate / target arbitrary tabs.
//   console.tap      — client streams console.* events from inspected pages
//                      (DevTools panel only).
//   network.tap      — client streams Network panel events.
//   fs.read          — client can read local files (terminal CLI; future).
//   shell.exec       — client can run shell commands (terminal CLI; future).
//   notify.popup     — client can show OS notifications.
//
// Future capabilities go here; tools are gated on the corresponding string.
export type Capability =
  | 'cdp.activeTab'
  | 'cdp.allTabs'
  | 'console.tap'
  | 'network.tap'
  | 'fs.read'
  | 'shell.exec'
  | 'notify.popup';

// ── Client → Server ────────────────────────────────────────────────────────

export interface ClientHello {
  type: 'hello';
  /** Free-form client identifier for logs/telemetry, e.g. "extension-sidepanel". */
  client: string;
  /** Protocol version. Server responds with what it supports. */
  protocol: number;
}

export interface SessionStart {
  type: 'session.start';
  /** Caller-chosen id; opaque to server. Server echoes in every reply. */
  sessionId: string;
  capabilities: Capability[];
  /** Optional override; falls back to server-config default. */
  model?: string;
  /** Optional client-side hint: the browser tab this session is bound to.
   *  Currently consumed by the extension service-worker (not the native
   *  host) so per-session cdp.send calls target the panel's inspected tab
   *  instead of whatever tab is foregrounded. */
  inspectedTabId?: number;
  /** Optional client-side hint: the browser window a side panel lives in.
   *  Like inspectedTabId it is consumed by the extension service worker, so
   *  each window's Browy works on that window's tabs. */
  windowId?: number;
  /** Per-user tool blocklist. Names listed here are removed from the
   *  Copilot SDK's `availableTools` for THIS session. The extension
   *  Settings page persists toggles in chrome.storage and forwards the
   *  disabled subset on every session.start so user preferences survive
   *  reloads. Tool names not in the host's registry are ignored. */
  disabledTools?: string[];
  /** Per-user opt-in for Copilot SDK host tools (read_file, write_file,
   *  bash, grep, glob, web_fetch). These are OFF by default — they give
   *  the agent shell + filesystem access on the host machine, which a
   *  malicious page could potentially abuse via prompt injection. The
   *  extension Settings page surfaces them under "advanced (host tools)"
   *  with explicit warnings. Names listed here are added to the strict
   *  `availableTools` allowlist for this session. */
  enabledHostTools?: string[];
}

export interface SessionEnd {
  type: 'session.end';
  sessionId: string;
}

export interface ChatSend {
  type: 'chat.send';
  sessionId: string;
  text: string;
}

export interface ChatCancel {
  type: 'chat.cancel';
  sessionId: string;
}

export interface HistoryClear {
  type: 'history.clear';
  sessionId: string;
}

/** Client-fulfilled tool result. Sent in response to a server `tool.call`
 *  whose tool name maps to a client capability (e.g. cdp.send). */
export interface ToolResult {
  type: 'tool.result';
  sessionId: string;
  callId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Client-streamed CDP event from its end (e.g. extension forwarding
 *  chrome.debugger.onEvent). Server routes to whichever session listens. */
export interface CdpEventFromClient {
  type: 'cdp.event';
  sessionId: string;
  /** Optional tab id; when omitted, "active tab" is assumed. */
  tabId?: string | number;
  method: string;
  params: unknown;
}

/** The extension lost chrome.debugger on a tab: the tab closed, the user
 *  clicked Cancel on Chrome's debugging bar, DevTools took over, or similar.
 *  Calls the extension was still running on the tab have already been
 *  answered with `message`; `failed` counts this session's. Hosts before
 *  0.1.14 ignore it. */
export interface CdpDetached {
  type: 'cdp.detached';
  sessionId: string;
  tabId: number;
  /** chrome.debugger.onDetach's reason (target_closed, canceled_by_user,
   *  replaced_with_devtools, ...), or 'unknown' when Chrome gave none. */
  reason: string;
  /** The tab itself is gone, not just the debugger. */
  tabGone?: boolean;
  /** What the model is told. */
  message?: string;
  failed?: number;
}

export interface AuthSignin {
  type: 'auth.signin';
}

export interface ListModels {
  type: 'models.list';
}

export interface SetModel {
  type: 'models.set';
  id: string;
}

export interface ChatList {
  type: 'chat.list';
  /** Echoed in every reply, so a panel can tell its replies from replies to
   *  other panels (they all receive unrouted ones). 0.1.14+. */
  reqId?: string;
  /** The asking panel's own session: replies are routed to that panel only.
   *  0.1.14+; without it the reply goes to every panel, as before. */
  sessionId?: string;
  /** Reply twice: at once with the chats found by id (`complete: false`),
   *  then with every chat once the full scan is in (`complete: true`).
   *  Without it the host replies once, with the full list. 0.1.14+. */
  progressive?: boolean;
}

export interface ChatHistory {
  type: 'chat.history';
  /** SDK session id whose transcript to fetch. */
  id: string;
  /** Reply with a page of `items` (ChatItem, agent/chat-items.ts) instead of
   *  the whole transcript as `messages`. 0.1.14+. */
  items?: boolean;
  /** With `items`: turns per page, newest first (default 10, at most 50). */
  limit?: number;
  /** With `items`: the page ends before this turn (a previous reply's `start`). */
  before?: number;
  /** Echoed in the reply, as for chat.list. 0.1.14+. */
  reqId?: string;
  /** Route the reply to this panel only, as for chat.list. 0.1.14+. */
  sessionId?: string;
}

/** Delete one chat by SDK session id, regardless of whether it is the chat
 *  currently loaded. Distinct from `history.clear`, which only ever acts on
 *  the caller's own active session. */
export interface ChatDelete {
  type: 'chat.delete';
  id: string;
}

export type ClientMessage =
  | ClientHello
  | SessionStart
  | SessionEnd
  | ChatSend
  | ChatCancel
  | HistoryClear
  | ToolResult
  | CdpEventFromClient
  | CdpDetached
  | AuthSignin
  | ListModels
  | SetModel
  | ChatList
  | ChatHistory
  | ChatDelete;

// ── Server → Client ────────────────────────────────────────────────────────

export interface ServerHello {
  type: 'hello.ack';
  protocol: number;
  /** Server-side build info; useful for "you need to upgrade" hints. */
  serverVersion: string;
}

export interface SessionReady {
  type: 'session.ready';
  sessionId: string;
  model: string;
  /** Echoed back so client can confirm what was accepted. */
  capabilities: Capability[];
}

export interface ChatDelta {
  type: 'chat.delta';
  sessionId: string;
  text: string;
}

export interface ChatToolCallStart {
  type: 'chat.tool_call';
  sessionId: string;
  callId: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface ChatToolCallEnd {
  type: 'chat.tool_result';
  sessionId: string;
  callId: string;
  ok: boolean;
  /** One-line summary for UI; full result kept server-side. */
  summary?: string;
  durationMs?: number;
}

/** Why a turn ended early without the user pressing Stop: the computer went
 *  to sleep, or the Copilot runtime quit. */
export type InterruptReason = 'sleep' | 'copilot';

export interface ChatDone {
  type: 'chat.done';
  sessionId: string;
  text: string;
  toolCalls: ToolCallRecord[];
  /** The user pressed Stop; `text` is what the agent had said by then. */
  stopped?: boolean;
  /** Set with `stopped` when the turn was cut short for this reason. `text`
   *  then ends with a note saying so, which older panels show as is. */
  interrupted?: InterruptReason;
}

/** One agent serves every panel. A chat sent while another panel's chat is
 *  running waits in line and starts as soon as that one ends. */
export interface ChatQueued {
  type: 'chat.queued';
  sessionId: string;
  /** 1 means it runs next. */
  position: number;
}

export interface ChatError {
  type: 'chat.error';
  sessionId: string;
  message: string;
  /** "auth" → client should prompt sign-in; "no_session" → the host has no
   *  record of this session id, so the client should send session.start
   *  again; otherwise generic. */
  code?: 'auth' | 'aborted' | 'internal' | 'no_capability' | 'busy' | 'no_session';
}

/** Server asks client to perform a CDP command on the user's browser. */
export interface CdpSendRequest {
  type: 'cdp.send';
  sessionId: string;
  callId: string;
  tabId?: string | number;
  method: string;
  params: unknown;
}

/** Server asks client to open a new tab. Reply via tool.result. */
export interface TabNewRequest {
  type: 'tab.new';
  sessionId: string;
  callId: string;
  url?: string;
  active?: boolean;
}

export interface TabActivateRequest {
  type: 'tab.activate';
  sessionId: string;
  callId: string;
  tabId: number;
}

/** Close a tab. The reply is the tab now active in that window, or null. */
export interface TabCloseRequest {
  type: 'tab.close';
  sessionId: string;
  callId: string;
  tabId: number;
}

export interface TabListRequest {
  type: 'tab.list';
  sessionId: string;
  callId: string;
}

export interface TabGetActiveRequest {
  type: 'tab.getActive';
  sessionId: string;
  callId: string;
}

/** Lightweight tab descriptor exchanged between SW and native host. */
export interface TabInfo {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
  windowId?: number;
}

/** Mascot/UI activity hint. Maps to existing pose/reaction system. */
export interface ActivityEvent {
  type: 'event.activity';
  sessionId: string;
  /** llm_call_start | llm_call_end | tool_start | tool_end | reasoning */
  event: string;
  tool?: string;
  args?: Record<string, unknown>;
  durationMs?: number;
  inputCount?: number;
  text?: string;
}

export interface AuthStatus {
  type: 'auth.status';
  state: 'ready' | 'unauth' | 'unknown';
  detail?: string;
}

/** Broadcast once the Copilot SDK has finished booting. `session.ready` only
 *  means the host process is answering — the SDK subprocess takes several
 *  seconds more, and until it lands `chat.list` / `models.list` return empty.
 *  Clients use this to re-issue those requests instead of rendering an
 *  empty-looking result as though the user genuinely had no history. */
export interface SdkReady {
  type: 'sdk.ready';
  ok: boolean;
  detail?: string;
}

/** Broadcast while the Copilot runtime is being restarted after it quit, and
 *  once it is back. Panels show it as a status line; older ones ignore it.
 *  `cause: 'stall'` means Copilot stopped answering rather than quit. */
export interface HostStatus {
  type: 'host.status';
  state: 'copilot_restarting' | 'copilot_ready' | 'copilot_failed';
  detail?: string;
  cause?: 'stall';
}

export interface ModelsList {
  type: 'models.list';
  models: ModelOption[];
}

export interface CurrentModel {
  type: 'models.current';
  id: string;
}

export interface BrowsersStatusEvt {
  type: 'browsers.status';
  browsers: BrowserStatus[];
}

export interface ActiveBrowsersEvt {
  type: 'browsers.active';
  active: ActiveBrowser[];
}

export interface FocusedTab {
  type: 'tab.focused';
  url: string;
  title: string;
  brand: string;
  tabCount: number;
}

/** Slim chat metadata for the side-panel chats overlay. Sourced from the
 *  Copilot SDK's session list, filtered to Browy's chats (Agent.listChats). */
export interface ChatListResult {
  type: 'chat.list.result';
  chats: Array<{
    id: string;
    summary?: string;
    /** ms since epoch */
    startTime: number;
    /** ms since epoch — newest activity */
    modifiedTime: number;
  }>;
  /** From the request. */
  reqId?: string;
  /** From the request, when the host knows that session; routes the reply. */
  sessionId?: string;
  /** Progressive requests only: false on the quick first reply, true on the
   *  full one that follows. */
  complete?: boolean;
  /** Listing failed; `chats` is empty and the panel keeps what it had. */
  error?: string;
}

/** A chat's transcript. With `items` requested: one page of ChatItems for
 *  turns [start, end) of `total`, oldest first. Otherwise the whole
 *  transcript as `messages`, the three roles panels before 0.1.14 render. */
export interface ChatHistoryResult {
  type: 'chat.history.result';
  id: string;
  messages?: Array<
    | { role: 'user'; text: string; timestamp?: number }
    | { role: 'assistant'; text: string; timestamp?: number }
    | { role: 'tool'; name: string; ok: boolean; summary?: string; timestamp?: number }
  >;
  items?: ChatItem[];
  start?: number;
  end?: number;
  total?: number;
  /** The session has no event log: it never ran a turn, or it is older than
   *  events.jsonl. */
  missing?: boolean;
  /** Reading failed. */
  error?: string;
  reqId?: string;
  sessionId?: string;
}

/** Ack for `chat.delete`, so the UI only removes the row once the session is
 *  actually gone from disk instead of optimistically hiding it. */
export interface ChatDeleteResult {
  type: 'chat.delete.result';
  id: string;
  ok: boolean;
}

export type ServerMessage =
  | ServerHello
  | SessionReady
  | ChatDelta
  | ChatToolCallStart
  | ChatToolCallEnd
  | ChatDone
  | ChatQueued
  | ChatError
  | CdpSendRequest
  | TabNewRequest
  | TabActivateRequest
  | TabCloseRequest
  | TabListRequest
  | TabGetActiveRequest
  | ActivityEvent
  | AuthStatus
  | SdkReady
  | HostStatus
  | ModelsList
  | CurrentModel
  | BrowsersStatusEvt
  | ActiveBrowsersEvt
  | FocusedTab
  | ChatListResult
  | ChatHistoryResult
  | ChatDeleteResult;

// ── Transport interface ────────────────────────────────────────────────────
//
// Every transport (ws, stdio native-msg, in-process) implements this. The
// Runner only sees Transport — it has no knowledge of WebSockets, stdio
// framing, or extension internals.
export interface Transport {
  /** Stable id for logs ("ws#abc", "native-host", etc). */
  readonly id: string;
  /** Push a server-side message to this transport's peer. */
  send(msg: ServerMessage): void;
  /** Subscribe to incoming client messages. */
  onMessage(cb: (msg: ClientMessage) => void): void;
  /** Subscribe to disconnect. */
  onClose(cb: () => void): void;
  /** Close the underlying connection (best effort). */
  close(): void;
}

/**
 * Wire-protocol version, sent in `hello.ack`. Bump it whenever the extension
 * starts relying on a message an older host doesn't speak: the extension
 * compares it against its own MIN_HOST_PROTOCOL and asks the user to update.
 *
 * The Chrome Web Store auto-updates the extension; nothing updates the host.
 * A newer extension talking to an older host is therefore the normal state
 * after every release, not an edge case.
 *
 *   1 — baseline, every host up to and including 0.1.6. `sdk.ready` (0.1.5)
 *       and `chat.delete` (0.1.6) shipped without a bump, so a protocol-1 host
 *       may or may not speak them, and all of them report serverVersion "0.3.0".
 *   2 — 0.1.7: guarantees `sdk.ready` and `chat.delete`, and serverVersion is
 *       the real package version.
 *
 * 0.1.14 added `cdp.detached` (extension to host), `host.status` and
 * `chat.done.interrupted` (host to extension) without a bump: each side works
 * as before when the other doesn't send them, so nothing relies on them.
 * 0.1.14 added optional fields to `chat.list` and `chat.history` (reqId,
 * sessionId, progressive, items/limit/before) and their replies, without a
 * bump: an older host ignores them and answers the old way, which the side
 * panel still renders, and an older panel never sends them.
 */
export const PROTOCOL_VERSION = 2;
