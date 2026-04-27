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
}

export interface ChatHistory {
  type: 'chat.history';
  /** SDK session id whose transcript to fetch. */
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
  | AuthSignin
  | ListModels
  | SetModel
  | ChatList
  | ChatHistory;

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

export interface ChatDone {
  type: 'chat.done';
  sessionId: string;
  text: string;
  toolCalls: ToolCallRecord[];
}

export interface ChatError {
  type: 'chat.error';
  sessionId: string;
  message: string;
  /** "auth" → client should prompt sign-in; otherwise generic. */
  code?: 'auth' | 'aborted' | 'internal' | 'no_capability' | 'busy';
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

/** Slim chat metadata for the side-panel chats overlay. Sourced from
 *  Copilot SDK `client.listSessions({cwd})` filtered to our workdir. */
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
}

/** Slim transcript for re-rendering a chat. We map SDK SessionEvents to
 *  three roles the side panel already knows how to render. */
export interface ChatHistoryResult {
  type: 'chat.history.result';
  id: string;
  messages: Array<
    | { role: 'user'; text: string; timestamp?: number }
    | { role: 'assistant'; text: string; timestamp?: number }
    | { role: 'tool'; name: string; ok: boolean; summary?: string; timestamp?: number }
  >;
}

export type ServerMessage =
  | ServerHello
  | SessionReady
  | ChatDelta
  | ChatToolCallStart
  | ChatToolCallEnd
  | ChatDone
  | ChatError
  | CdpSendRequest
  | TabNewRequest
  | TabActivateRequest
  | TabListRequest
  | TabGetActiveRequest
  | ActivityEvent
  | AuthStatus
  | ModelsList
  | CurrentModel
  | BrowsersStatusEvt
  | ActiveBrowsersEvt
  | FocusedTab
  | ChatListResult
  | ChatHistoryResult;

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

export const PROTOCOL_VERSION = 1;
