// Browy Core Runner — transport-agnostic session manager.
//
// One Runner instance per process. Multiple Transports attach to it
// (WebSocket, native messaging stdio, in-process for tests). The Runner
// dispatches incoming ClientMessages to the underlying Agent and translates
// Agent events back into ServerMessages routed to the right transport.
//
// Phase A scope:
//   - Single shared Agent (existing playwright-driven one). Multi-Agent
//     (per-session BrowserToolContext) comes in Phase E.
//   - One in-flight chat at a time across all transports. Sufficient for
//     v0.3 since a user is one human pressing one Enter at a time.
//   - Capability negotiation is recorded but not yet enforced on tools
//     (that gates tool registry filtering, also Phase E).

import type { Agent } from './loop.js';
import { ExtensionContext } from './extension-context.js';
import type {
  Transport,
  ClientMessage,
  ServerMessage,
  Capability,
  SessionStart,
} from '../protocol.js';
import { PROTOCOL_VERSION } from '../protocol.js';
import type { WSMessage } from '../types.js';

interface SessionState {
  id: string;
  transport: Transport;
  capabilities: Set<Capability>;
  /** Set true while a chat is in flight; prevents overlapping requests. */
  inFlight: boolean;
  /** Phase E: present when session declared cdp.activeTab. */
  extContext?: ExtensionContext;
}

export interface RunnerOptions {
  serverVersion: string;
  /** Probe + sign-in handlers — kept transport-agnostic so any frontend can
   *  trigger them. Implementations live in cli.ts (own credential store
   *  knowledge) for now. */
  authProbe?: () => 'ready' | 'unauth' | 'unknown';
  authSignin?: () => boolean;
}

export class Runner {
  private agent: Agent;
  private opts: RunnerOptions;

  /** sessionId → SessionState. Survives only as long as the transport. */
  private sessions = new Map<string, SessionState>();

  /** Transport.id → set of session ids hosted on it (for cleanup). */
  private transportSessions = new Map<string, Set<string>>();

  /** The session currently driving the Agent. Used to route activity
   *  events back to the originator. */
  private activeSessionId: string | null = null;

  /** Latched Copilot SDK readiness, replayed to clients that attach late. */
  private sdkReady: { ok: boolean; detail?: string } | null = null;

  constructor(agent: Agent, opts: RunnerOptions) {
    this.agent = agent;
    this.opts = opts;

    // Subscribe to agent activity ONCE. Route every event to the active
    // session (chat-scoped events) AND broadcast to all sessions
    // (status/tabs/models — UI-wide concerns).
    this.agent.setActivityCallback((wsMsg) => this.onAgentEvent(wsMsg));
  }

  // ── Transport lifecycle ─────────────────────────────────────────────────

  attach(transport: Transport): void {
    this.transportSessions.set(transport.id, new Set());

    transport.onMessage((msg) => {
      this.handleClientMessage(transport, msg).catch((err) => {
        const sid = (msg as any).sessionId;
        if (sid) {
          transport.send({
            type: 'chat.error',
            sessionId: sid,
            message: err instanceof Error ? err.message : String(err),
            code: 'internal',
          });
        }
      });
    });

    transport.onClose(() => {
      const ids = this.transportSessions.get(transport.id);
      if (ids) {
        for (const id of ids) {
          this.sessions.get(id)?.extContext?.dispose('transport closed');
          this.sessions.delete(id);
        }
        this.transportSessions.delete(transport.id);
      }
      if (this.activeSessionId && !this.sessions.has(this.activeSessionId)) {
        this.activeSessionId = null;
      }
    });
  }

  // ── Inbound dispatch ─────────────────────────────────────────────────────

  private async handleClientMessage(transport: Transport, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case 'hello':
        transport.send({
          type: 'hello.ack',
          protocol: PROTOCOL_VERSION,
          serverVersion: this.opts.serverVersion,
        });
        return;

      case 'session.start':
        return this.onSessionStart(transport, msg);

      case 'session.end': {
        const s = this.sessions.get(msg.sessionId);
        s?.extContext?.dispose('session.end');
        this.sessions.delete(msg.sessionId);
        this.transportSessions.get(transport.id)?.delete(msg.sessionId);
        if (this.activeSessionId === msg.sessionId) this.activeSessionId = null;
        return;
      }

      case 'chat.send':
        return this.onChatSend(msg.sessionId, msg.text);

      case 'chat.cancel': {
        // Only honor cancel from the session that's actually driving the
        // agent. Otherwise one panel could abort another panel's stream.
        if (this.activeSessionId && this.activeSessionId === (msg as any).sessionId) {
          await this.agent.abort();
        }
        return;
      }

      case 'history.clear': {
        // Refuse if another session has a chat in flight — clearing rebinds
        // the agent's session id, which would abort their stream mid-flight.
        const callerSid = (msg as any).sessionId;
        if (this.activeSessionId && this.activeSessionId !== callerSid) {
          const s = this.sessions.get(callerSid);
          s?.transport.send({
            type: 'chat.error', sessionId: callerSid, code: 'busy',
            message: 'agent is busy on another session — try again in a moment',
          });
          return;
        }
        if (callerSid) {
          this.agent.setBrowyProtocolSessionId(callerSid);
        }
        await this.agent.clearHistory();
        return;
      }

      case 'auth.signin': {
        if (this.opts.authSignin) {
          const opened = this.opts.authSignin();          // Re-probe AFTER opening the terminal. If the user was already
          // signed in (common — the button is reachable even when banner is
          // momentarily wrong) we must NOT flip state to unauth, otherwise
          // we'd plant a permanent false banner with no poller to clear it.
          const state = this.opts.authProbe ? this.opts.authProbe() : 'unknown';
          if (state === 'ready') {
            this.broadcast({ type: 'auth.status', state: 'ready' });
          } else {
            this.broadcast({
              type: 'auth.status',
              state: opened ? 'unauth' : 'unknown',
              detail: opened
                ? 'complete sign-in in the terminal window. status will update automatically.'
                : 'could not open a terminal — run `copilot` from any shell to sign in.',
            });
          }
        }
        return;
      }

      case 'models.list': {
        const models = await this.agent.listModels();
        transport.send({ type: 'models.list', models });
        return;
      }

      case 'models.set':
        await this.agent.setModel(msg.id);
        this.broadcast({ type: 'models.current', id: this.agent.getModel() });
        return;

      case 'chat.list': {
        const chats = await this.agent.listChats();
        transport.send({ type: 'chat.list.result', chats });
        return;
      }

      case 'chat.history': {
        const messages = await this.agent.getChatMessages(msg.id);
        transport.send({ type: 'chat.history.result', id: msg.id, messages });
        return;
      }

      case 'chat.delete': {
        // Refuse only while the agent is mid-turn on the chat being deleted —
        // deleting a different, idle chat is always safe.
        if (this.activeSessionId && this.activeSessionId === msg.id) {
          transport.send({ type: 'chat.delete.result', id: msg.id, ok: false });
          return;
        }
        const ok = await this.agent.deleteChat(msg.id);
        transport.send({ type: 'chat.delete.result', id: msg.id, ok });
        return;
      }

      case 'tool.result': {
        const s = this.sessions.get((msg as any).sessionId);
        s?.extContext?.handleToolResult(msg);
        return;
      }
      case 'cdp.event': {
        const s = this.sessions.get((msg as any).sessionId);
        s?.extContext?.handleCdpEvent(msg);
        return;
      }
    }
  }

  private async onSessionStart(transport: Transport, msg: SessionStart): Promise<void> {
    const state: SessionState = {
      id: msg.sessionId,
      transport,
      capabilities: new Set(msg.capabilities),
      inFlight: false,
    };

    // Phase E: if the client can drive an active tab via CDP, build the
    // extension context. Tools will be routed through it on chat.send.
    if (state.capabilities.has('cdp.activeTab')) {
      state.extContext = new ExtensionContext(msg.sessionId, transport);
    }

    this.sessions.set(msg.sessionId, state);
    this.transportSessions.get(transport.id)?.add(msg.sessionId);

    // Apply user's per-tool toggles BEFORE the next ensureSession() runs.
    // Empty list = no overrides; presence of names means user has disabled
    // them via the extension Settings page.
    if (msg.disabledTools !== undefined) {
      this.agent.setDisabledTools(msg.disabledTools);
    }
    if (msg.enabledHostTools !== undefined) {
      this.agent.setEnabledHostTools(msg.enabledHostTools);
    }

    transport.send({
      type: 'session.ready',
      sessionId: msg.sessionId,
      model: this.agent.getModel(),
      capabilities: Array.from(state.capabilities),
    });

    // Push initial state so the new client renders without waiting for a tick.
    this.pushInitialState(transport);
  }

  private pushInitialState(transport: Transport): void {
    if (this.opts.authProbe) {
      transport.send({ type: 'auth.status', state: this.opts.authProbe() });
    }
    // Replay latched SDK readiness so a panel attaching after boot doesn't
    // sit waiting for an event that already fired.
    if (this.sdkReady) {
      transport.send({ type: 'sdk.ready', ok: this.sdkReady.ok, detail: this.sdkReady.detail });
    }
    transport.send({ type: 'models.current', id: this.agent.getModel() });
    // Only fetch models once the SDK is actually up. Before that listModels()
    // either returns [] or resolves at the same moment as the post-init
    // broadcast, which produced two identical models.list payloads on every
    // cold start.
    if (!this.sdkReady) return;
    this.agent.listModels().then((models) => {
      try { transport.send({ type: 'models.list', models }); } catch {}
    }).catch(() => {});
  }

  private async onChatSend(sessionId: string, text: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.inFlight) {
      session.transport.send({
        type: 'chat.error', sessionId, code: 'aborted',
        message: 'another chat is already in flight on this session',
      });
      return;
    }
    // Single-Agent serialization: refuse if any OTHER session is currently
    // driving the agent. Without this, calling agent.chat() from B while A
    // is mid-stream would (a) re-bind the SDK session id mid-run and abort
    // A's stream, and (b) misroute A's deltas to B because activeSessionId
    // would have flipped.
    if (this.activeSessionId && this.activeSessionId !== sessionId) {
      session.transport.send({
        type: 'chat.error', sessionId, code: 'busy',
        message: 'agent is busy on another panel — try again in a moment',
      });
      return;
    }
    session.inFlight = true;
    this.activeSessionId = sessionId;
    // Bind the agent's Copilot SDK session to this protocol id so reloads
    // resume the same on-disk conversation.
    this.agent.setBrowyProtocolSessionId(sessionId);
    // Phase E: swap the agent's tool context to this session's. Single-Agent
    // shared across sessions is fine for v0.3 because we serialize chats.
    if (session.extContext) {
      this.agent.setBrowserContextOverride(session.extContext.build());
    } else {
      this.agent.setBrowserContextOverride(null);
    }
    try {
      const { text: response, toolCalls } = await this.agent.chat(text);
      session.transport.send({ type: 'chat.done', sessionId, text: response, toolCalls });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      const code = looksLikeAuthError(m) ? 'auth' : 'internal';
      session.transport.send({ type: 'chat.error', sessionId, message: m, code });
      if (code === 'auth') {
        this.broadcast({
          type: 'auth.status', state: 'unauth',
          detail: 'github copilot needs sign-in.',
        });
      }
    } finally {
      session.inFlight = false;
      if (this.activeSessionId === sessionId) this.activeSessionId = null;
    }
  }

  // ── Outbound: translate Agent activity → BrowyProtocol ──────────────────

  private onAgentEvent(ws: WSMessage): void {
    const translated = translateWsToProtocol(ws, this.activeSessionId);
    if (!translated) return;
    if ('sessionId' in translated && translated.sessionId) {
      // Session-scoped: route to originating session only.
      const session = this.sessions.get(translated.sessionId as string);
      session?.transport.send(translated as ServerMessage);
    } else {
      // Broadcast: tab / model / browser status events go to all sessions.
      this.broadcast(translated as ServerMessage);
    }
  }

  /** Broadcast to every attached session. Used for global state events. */
  broadcast(msg: ServerMessage): void {
    const seen = new Set<string>();
    for (const s of this.sessions.values()) {
      if (seen.has(s.transport.id)) continue;
      seen.add(s.transport.id);
      try { s.transport.send(msg); } catch {}
    }
  }

  /** Notify all sessions of an auth state change (used by external probes). */
  notifyAuth(state: 'ready' | 'unauth' | 'unknown', detail?: string): void {
    this.broadcast({ type: 'auth.status', state, detail });
  }

  /** Record + broadcast Copilot SDK readiness. Kept as state (not just an
   *  event) so a panel that attaches AFTER the SDK finished booting still
   *  learns about it via pushInitialState instead of waiting forever. */
  markSdkReady(ok: boolean, detail?: string): void {
    this.sdkReady = { ok, detail };
    this.broadcast({ type: 'sdk.ready', ok, detail });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function looksLikeAuthError(m: string): boolean {
  // Tight regex: must look like an actual authentication failure, not just
  // any error string that happens to contain the words "sign in". Earlier
  // we matched /sign\s*in/i which converted many unrelated errors (e.g. a
  // tool result mentioning a sign-in button) into spurious auth banners.
  return /\b(?:401|403)\b|unauthori[sz]ed|forbidden|not.*(?:logged|signed).*in|missing.*(?:token|credential)|auth(?:entication)?\s*(?:required|failed|expired)|please\s+(?:log|sign)\s*in/i.test(m);
}

/**
 * Translate a legacy WSMessage emitted by Agent into the new BrowyProtocol.
 * Returns null when the event has no protocol equivalent (yet).
 *
 * For session-scoped events we attach the currently-active sessionId.
 * Broadcast events leave sessionId empty so the runner fans them out.
 */
function translateWsToProtocol(
  ws: WSMessage,
  activeSessionId: string | null,
): ServerMessage | null {
  switch (ws.type) {
    case 'delta':
      return activeSessionId
        ? { type: 'chat.delta', sessionId: activeSessionId, text: ws.text }
        : null;

    case 'reasoning':
      return activeSessionId
        ? {
            type: 'event.activity',
            sessionId: activeSessionId,
            event: 'reasoning',
            text: ws.text,
          }
        : null;

    case 'tool_step':
      if (!activeSessionId) return null;
      if (ws.status === 'start') {
        return {
          type: 'chat.tool_call',
          sessionId: activeSessionId,
          callId: ws.id,
          tool: ws.name,
          args: ws.args || {},
        };
      }
      return {
        type: 'chat.tool_result',
        sessionId: activeSessionId,
        callId: ws.id,
        ok: ws.status === 'end',
        summary: ws.result,
        durationMs: ws.durationMs,
      };

    case 'activity':
      return activeSessionId
        ? {
            type: 'event.activity',
            sessionId: activeSessionId,
            event: ws.event,
            tool: ws.tool,
            args: ws.args,
            durationMs: ws.durationMs,
            inputCount: ws.inputCount,
          }
        : null;

    case 'status':
      return activeSessionId
        ? {
            type: 'event.activity',
            sessionId: activeSessionId,
            event: `status.${ws.status}`,
            text: ws.detail,
          }
        : null;

    // ── Broadcast (no sessionId — runner fans out to all attached sessions) ──
    case 'focused_tab':
      return {
        type: 'tab.focused',
        url: ws.url, title: ws.title, brand: ws.brand, tabCount: ws.tabCount,
      };

    case 'browsers_status':
      return { type: 'browsers.status', browsers: ws.browsers };

    case 'active_browsers':
      return { type: 'browsers.active', active: ws.active };

    case 'models_list':
      return { type: 'models.list', models: ws.models };

    case 'current_model':
      return { type: 'models.current', id: ws.id };

    case 'copilot_status':
      return { type: 'auth.status', state: ws.state, detail: ws.detail };

    case 'response':
      // Agent's "final response" event. chat.done is emitted explicitly by
      // the runner once agent.chat() resolves, so we suppress this to avoid
      // double-emit. Kept here as a sentinel comment for future debuggers.
      return null;

    default:
      return null;
  }
}
