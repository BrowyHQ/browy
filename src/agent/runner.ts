// Browy Core Runner — transport-agnostic session manager.
//
// One Runner instance per process. Multiple Transports attach to it
// (WebSocket, native messaging stdio, in-process for tests). The Runner
// dispatches incoming ClientMessages to the underlying Agent and translates
// Agent events back into ServerMessages routed to the right transport.
//
// Browser turns reserve their target tabs. Independent turns can use separate
// Copilot workers; clients without a concrete browser target still serialize.

import type { Agent } from './loop.js';
import { ExtensionContext } from './extension-context.js';
import { WakeWatch } from './wake-watch.js';
import type {
  Transport,
  ClientMessage,
  ServerMessage,
  Capability,
  BrowserPolicy,
  SessionStart,
  InterruptReason,
} from '../protocol.js';
import { PROTOCOL_VERSION } from '../protocol.js';
import type { WSMessage } from '../types.js';

/** What the panel says when a turn is cut short. The text goes in chat.done,
 *  so panels from before these notes existed show it too. */
export const INTERRUPT_NOTES: Record<InterruptReason, string> = {
  sleep: 'Your computer went to sleep during this task, so I stopped it. The chat is saved. Say continue to pick up where it left off.',
  copilot: 'Copilot quit unexpectedly, so this task stopped. The chat is saved. Send a message to carry on.',
};
const SLEPT_IN_LINE_NOTE = "Your computer went to sleep before this task started, so it didn't run. Send it again when you're ready.";

/** The turn's text with the note after it, in italics like the Stop note. */
function withNote(text: string, note: string): string {
  return `${text ? `${text}\n\n` : ''}_${note}_`;
}

interface SessionState {
  id: string;
  transport: Transport;
  capabilities: Set<Capability>;
  policy: BrowserPolicy;
  inspectedTabId?: number;
  turn?: CurrentTurn;
  worker?: Agent;
  ready?: Promise<void>;
}

interface CurrentTurn {
  session: SessionState;
  text: string;
  policy: BrowserPolicy;
  context?: ExtensionContext;
  target?: number;
  tabs: Set<number>;
  phase: 'targeting' | 'waiting' | 'starting' | 'running';
  queued?: boolean;
  stopping?: boolean;
  interrupted?: InterruptReason;
}

export interface RunnerOptions {
  serverVersion: string;
  /** Probe + sign-in handlers — kept transport-agnostic so any frontend can
   *  trigger them. Implementations live in cli.ts (own credential store
   *  knowledge) for now. */
  authProbe?: () => 'ready' | 'unauth' | 'unknown';
  authSignin?: () => boolean;
  /** How long a turn may hold the panel after Stop before the runner frees
   *  it anyway. Default 3 s; tests shorten it. */
  stopGraceMs?: number;
  /** Notices sleeps. Default: a 5 s timer that calls more than 30 s a
   *  sleep. Tests pass their own, or false for none. */
  wakeWatch?: WakeWatch | false;
}

export class Runner {
  private agent: Agent;
  private opts: RunnerOptions;

  /** sessionId → SessionState. Survives only as long as the transport. */
  private sessions = new Map<string, SessionState>();

  /** Transport.id → set of session ids hosted on it (for cleanup). */
  private transportSessions = new Map<string, Set<string>>();

  private primaryOwner?: SessionState;
  private primaryReady?: Promise<void>;
  private retiring = new Map<string, Promise<void>>();
  private deleting = new Set<string>();
  private running = new Set<CurrentTurn>();
  private waiting: CurrentTurn[] = [];
  private closing = false;
  private wake?: WakeWatch;

  /** Latched Copilot SDK readiness, replayed to clients that attach late. */
  private sdkReady: { ok: boolean; detail?: string } | null = null;

  constructor(agent: Agent, opts: RunnerOptions) {
    this.agent = agent;
    this.opts = opts;

    agent.setActivityCallback((msg) => this.onAgentEvent(msg));

    if (opts.wakeWatch !== false) {
      const wake = opts.wakeWatch ?? new WakeWatch().start();
      this.wake = wake;
      wake.onWake((gapMs) => this.onWake(gapMs));
      this.agent.setWakeWatch?.(wake);
    }
  }

  // ── Transport lifecycle ─────────────────────────────────────────────────

  attach(transport: Transport): void {
    this.transportSessions.set(transport.id, new Set());

    transport.onMessage((msg) => {
      this.handleClientMessage(transport, msg).catch((err) => {
        const sid = 'sessionId' in msg && msg.sessionId;
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
        this.transportSessions.delete(transport.id);
        for (const id of ids) this.closeSession(id, 'transport closed');
      }
    });
  }

  /** Forget a session whose panel has gone. If it was mid-turn, stop the
   *  turn: nobody can see it any more, and its browser calls would be routed
   *  to a context that no longer exists. */
  private closeSession(id: string, reason: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    this.transportSessions.get(s.transport.id)?.delete(id);
    const turn = s.turn;
    if (turn) turn.context?.dispose(reason);
    this.retireWorker(s, !!turn && this.running.has(turn));
    if (turn) this.release(turn);
  }

  private retireWorker(s: SessionState, discard = false): void {
    const worker = s.worker;
    if (!worker) return;
    s.worker = undefined;
    s.ready = undefined;
    worker.setActivityCallback(() => {});
    const primary = worker === this.agent;
    if (primary) this.primaryOwner = undefined;
    if (primary && this.closing) return; // shutdown owns the prewarmed client
    const cleanup = primary && !discard ? worker.detachChat() : worker.disconnect();
    const done = cleanup
      .finally(() => { if (this.retiring.get(s.id) === done) this.retiring.delete(s.id); });
    done.catch((e) => console.warn(`Could not close worker for ${s.id}:`, e));
    this.retiring.set(s.id, done);
    if (primary && discard) {
      // The old call might still return. Never lend its Agent to a new turn.
      this.agent = worker.createSessionWorker();
      this.agent.setActivityCallback((msg) => this.onAgentEvent(msg));
      this.primaryReady = this.agent.initCopilot();
      this.primaryReady.catch((e) => console.warn('Replacement Copilot worker failed to start:', e));
    } else if (primary) {
      this.primaryReady = done;
    }
  }

  private assignWorker(s: SessionState): Agent {
    if (s.worker) return s.worker;
    const owner = this.primaryOwner;
    if (!owner?.turn || !this.running.has(owner.turn)) {
      if (owner) this.retireWorker(owner);
      this.primaryOwner = s;
      s.worker = this.agent;
      s.ready = this.primaryReady;
    } else {
      s.worker = this.agent.createSessionWorker();
      s.ready = s.worker.initCopilot();
    }
    const worker = s.worker;
    worker.setActivityCallback((msg) => {
      if (s.worker === worker) this.onAgentEvent(msg, s);
    });
    return worker;
  }

  private release(turn: CurrentTurn): void {
    turn.context?.dispose('This turn has ended. No further browser actions.');
    turn.session.turn = undefined;
    this.waiting = this.waiting.filter((w) => w !== turn);
    this.running.delete(turn);
    this.drain();
  }

  private conflicts(turn: CurrentTurn, other: CurrentTurn, tab = turn.target): boolean {
    return tab === undefined || other.target === undefined ||
      (other.session.transport === turn.session.transport && (other.target === tab || other.tabs.has(tab)));
  }

  private drain(): void {
    if (this.closing) return;
    for (const turn of [...this.waiting]) {
      if (turn.phase !== 'waiting' || !this.transportSessions.has(turn.session.transport.id)) continue;
      const ahead = this.waiting.slice(0, this.waiting.indexOf(turn));
      const position = 1 + ahead.filter((other) => this.conflicts(turn, other)).length;
      if (position > 1 || [...this.running].some((other) => this.conflicts(turn, other))) {
        if (!turn.queued) turn.session.transport.send({ type: 'chat.queued', sessionId: turn.session.id,
          position, tabId: turn.target });
        turn.queued = true;
        continue;
      }
      this.waiting.splice(this.waiting.indexOf(turn), 1);
      this.running.add(turn);
      if (turn.target !== undefined) turn.tabs.add(turn.target);
      turn.phase = 'starting';
      void this.runTurn(turn);
    }
  }

  private claimTab(turn: CurrentTurn, tabId: number): void {
    if (!this.running.has(turn) || turn.stopping) throw new Error('This turn has stopped.');
    if ([...this.running].some((other) => other !== turn && this.conflicts(turn, other, tabId))) {
      throw new Error('Another Browy chat is using this tab. No action was taken. Pick a different tab or try after that chat finishes.');
    }
    turn.tabs.add(tabId);
  }

  private stopTurn(turn: CurrentTurn, reason?: InterruptReason): void {
    if (turn.stopping) return;
    turn.stopping = true;
    turn.interrupted = reason;
    turn.context?.dispose(reason ? INTERRUPT_NOTES[reason] : 'Stopped by the user.');
    const s = turn.session;
    const finish = () => {
      if (s.turn !== turn) return;
      const note = reason === 'sleep' && turn.phase !== 'running' ? SLEPT_IN_LINE_NOTE : reason && INTERRUPT_NOTES[reason];
      s.transport.send({ type: 'event.activity', sessionId: s.id, event: 'status.idle' });
      s.transport.send({ type: 'chat.done', sessionId: s.id, text: note ? withNote('', note) : '',
        toolCalls: [], stopped: true, ...(reason ? { interrupted: reason } : {}) });
      if (this.running.has(turn)) this.retireWorker(s, true);
      this.release(turn);
    };
    if (turn.phase !== 'running' || !s.worker) { finish(); return; }
    const stopping = reason ? s.worker.interrupt(reason) : s.worker.abort();
    stopping.catch((e) => console.warn(`Could not stop ${s.id}:`, e));
    setTimeout(finish, this.opts.stopGraceMs ?? 3000).unref();
  }

  /** The computer slept (or this process was frozen) for `gapMs`. Whatever
   *  was running stops, and nothing waiting starts by itself: a task left
   *  mid-way may have been submitting or sending something, and repeating
   *  that unasked could do it twice. */
  private onWake(gapMs: number): void {
    console.log(`  💤 ${Math.round(gapMs / 1000)} s went by without this process running: the computer slept or the process was paused`);
    for (const turn of [...this.waiting.splice(0), ...this.running]) this.stopTurn(turn, 'sleep');
    // Network connections rarely survive a sleep. Check the one to Copilot
    // now rather than on the next message.
    for (const worker of new Set([this.agent, ...[...this.sessions.values()].flatMap((s) => s.worker ? [s.worker] : [])])) {
      void worker.checkCopilot?.().catch((e) => console.warn('Copilot wake check failed:', e));
    }
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    this.wake?.stop();
    for (const id of this.sessions.keys()) this.closeSession(id, 'Host shutting down.');
    try { await Promise.all(this.retiring.values()); }
    finally { await this.agent.disconnect(); }
  }

  // ── Inbound dispatch ─────────────────────────────────────────────────────

  private async handleClientMessage(transport: Transport, msg: ClientMessage): Promise<void> {
    const owner = 'sessionId' in msg && msg.sessionId ? this.sessions.get(msg.sessionId) : undefined;
    if (owner && owner.transport !== transport) {
      transport.send({ type: 'chat.error', sessionId: owner.id, code: 'busy', message: 'This chat is open on another connection.' });
      return;
    }
    switch (msg.type) {
      case 'hello':
        transport.send({
          type: 'hello.ack',
          protocol: PROTOCOL_VERSION,
          serverVersion: this.opts.serverVersion,
          browserPolicy: true,
          parallelChats: true,
        });
        return;

      case 'session.start':
        return this.onSessionStart(transport, msg);

      case 'session.end': {
        this.closeSession(msg.sessionId, 'session.end');
        return;
      }

      case 'chat.send':
        return this.onChatSend(msg.sessionId, msg.text, transport, msg.policy, msg.tabId);

      case 'chat.cancel': {
        if (owner?.turn) this.stopTurn(owner.turn);
        return;
      }

      case 'history.clear': {
        if (owner && !await this.deleteIdleChat(owner.id)) {
          transport.send({ type: 'chat.error', sessionId: owner.id, code: owner.turn ? 'busy' : 'internal',
            message: owner.turn ? 'Stop this chat before clearing it.' : 'Could not clear this chat.' });
        }
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

      case 'models.set': {
        try {
          await this.agent.setModel(msg.id);
          this.broadcast({ type: 'models.current', id: this.agent.getModel() });
        } catch (e) {
          const current = this.agent.getModel();
          transport.send({ type: 'models.error', sessionId: msg.sessionId, id: msg.id, current,
            message: e instanceof Error ? e.message : String(e) });
          // Older pickers optimistically displayed the requested model.
          if (!msg.sessionId) transport.send({ type: 'models.current', id: current });
        }
        return;
      }

      case 'chat.list': {
        const route = this.replyRoute(msg);
        try {
          if (msg.progressive) {
            const chats = await this.agent.listChats((fast) => {
              transport.send({ type: 'chat.list.result', chats: fast, complete: false, ...route });
            });
            transport.send({ type: 'chat.list.result', chats, complete: true, ...route });
          } else {
            const chats = await this.agent.listChats();
            transport.send({ type: 'chat.list.result', chats, ...route });
          }
        } catch (e) {
          transport.send({ type: 'chat.list.result', chats: [], complete: true, error: e instanceof Error ? e.message : String(e), ...route });
        }
        return;
      }

      case 'chat.history': {
        const route = this.replyRoute(msg);
        try {
          await this.retiring.get(msg.id);
          const worker = this.sessions.get(msg.id)?.worker ?? this.agent;
          if (msg.items) {
            const page = await worker.getHistory(msg.id, { limit: msg.limit, before: msg.before });
            transport.send({ type: 'chat.history.result', id: msg.id, ...page, ...route });
          } else {
            const messages = await worker.getChatMessages(msg.id);
            transport.send({ type: 'chat.history.result', id: msg.id, messages, ...route });
          }
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          transport.send({ type: 'chat.history.result', id: msg.id, ...(msg.items ? { items: [] } : { messages: [] }), error, ...route });
        }
        return;
      }

      case 'chat.delete': {
        const ok = await this.deleteIdleChat(msg.id);
        transport.send({ type: 'chat.delete.result', id: msg.id, ok });
        return;
      }

      case 'tool.result': {
        owner?.turn?.context?.handleToolResult(msg);
        return;
      }
      case 'cdp.event': {
        owner?.turn?.context?.handleCdpEvent(msg);
        return;
      }
      case 'cdp.detached': {
        console.log(`  ⚠ chat ${msg.sessionId}: the debugger came off tab ${msg.tabId} (${msg.reason}${msg.tabGone ? ', tab closed' : ''})`);
        owner?.turn?.context?.handleDetached(msg);
        return;
      }
    }
  }

  private async deleteIdleChat(id: string): Promise<boolean> {
    if (this.sessions.get(id)?.turn || this.deleting.has(id)) return false;
    this.deleting.add(id);
    try {
      await this.retiring.get(id);
      return await (this.sessions.get(id)?.worker ?? this.agent).deleteChat(id);
    } finally { this.deleting.delete(id); }
  }

  /** Where a chat.list / chat.history reply goes. A 0.1.14 side panel names
   *  its own session, so the reply reaches that panel alone; anything else
   *  is broadcast to every panel, as before, and the request id lets a panel
   *  pick out its own replies. A session this host doesn't know (already
   *  ended) is not used for routing, or the reply would be dropped. */
  private replyRoute(msg: { reqId?: unknown; sessionId?: unknown }): { reqId?: string; sessionId?: string } {
    const route: { reqId?: string; sessionId?: string } = {};
    if (typeof msg.reqId === 'string' && msg.reqId) route.reqId = msg.reqId.slice(0, 64);
    if (typeof msg.sessionId === 'string' && this.sessions.has(msg.sessionId)) route.sessionId = msg.sessionId;
    return route;
  }

  private async onSessionStart(transport: Transport, msg: SessionStart): Promise<void> {
    const state: SessionState = this.sessions.get(msg.sessionId) ?? {
      id: msg.sessionId,
      transport,
      capabilities: new Set(msg.capabilities),
      policy: { guidelines: '', disabledTools: msg.disabledTools ?? [], enabledHostTools: msg.enabledHostTools ?? [] },
      inspectedTabId: msg.inspectedTabId,
    };

    this.sessions.set(msg.sessionId, state);
    this.transportSessions.get(transport.id)?.add(msg.sessionId);

    transport.send({
      type: 'session.ready',
      sessionId: msg.sessionId,
      model: this.agent.getModel(),
      capabilities: Array.from(state.capabilities),
      parallelChats: true,
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

  private async onChatSend(sessionId: string, text: string, transport: Transport, settings?: BrowserPolicy, tabId?: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      // Until 0.1.13 this dropped the message without a word, and the panel
      // waited forever. Say so; the side panel registers again and resends.
      console.log(`  ▶ chat ${sessionId}: no such session on this host, so the panel is told to reconnect`);
      transport.send({
        type: 'chat.error', sessionId, code: 'no_session',
        message: "Browy's backend lost track of this chat. Reconnect and send the message again.",
      });
      return;
    }
    const policy = settings ?? session.policy;
    if (typeof policy.guidelines !== 'string' || policy.guidelines.length > 4000 ||
        ![policy.disabledTools, policy.enabledHostTools].every((v) => Array.isArray(v) && v.every((n) => typeof n === 'string'))) {
      session.transport.send({ type: 'chat.error', sessionId, message: 'Invalid browser settings. No actions taken.' });
      return;
    }
    if (session.turn || this.deleting.has(sessionId)) {
      session.transport.send({
        type: 'chat.error', sessionId, code: session.turn ? 'busy' : 'internal',
        message: this.deleting.has(sessionId) ? 'This chat is being cleared.' : 'This chat already has a message running or queued.',
      });
      return;
    }
    const turn: CurrentTurn = { session, text, policy, tabs: new Set(), phase: 'targeting' };
    session.turn = turn;
    this.waiting.push(turn);
    try {
      if (session.capabilities.has('cdp.activeTab')) {
        turn.context = new ExtensionContext(sessionId, transport, undefined, session.capabilities.has('browser.nativeIO'),
          (id) => this.claimTab(turn, id));
        turn.target = session.inspectedTabId ?? tabId ?? await turn.context.startingTab();
        if (!Number.isSafeInteger(turn.target) || turn.target < 0) throw new Error('No target tab for this chat.');
      }
      if (session.turn !== turn) return;
      turn.phase = 'waiting';
      this.drain();
    } catch (err) {
      if (session.turn !== turn) return;
      transport.send({ type: 'chat.error', sessionId, message: err instanceof Error ? err.message : String(err) });
      this.release(turn);
    }
  }

  private async runTurn(turn: CurrentTurn): Promise<void> {
    const { session, policy } = turn;
    const sessionId = session.id;
    const t0 = Date.now();
    try {
      await this.retiring.get(sessionId);
      if (session.turn !== turn) return;
      const worker = this.assignWorker(session);
      await session.ready;
      if (session.turn !== turn) return;
      const model = this.agent.getModel();
      if (worker !== this.agent && worker.getModel() !== model) await worker.setModel(model, false);
      if (session.turn !== turn) return;
      worker.setBrowyProtocolSessionId(sessionId);
      turn.context?.beginTurn(turn.target);
      worker.setBrowserContextOverride(turn.context?.build() ?? null);
      worker.setDisabledTools(policy.disabledTools);
      worker.setEnabledHostTools(policy.enabledHostTools);
      turn.phase = 'running';
      console.log(`  ▶ chat ${sessionId}: started${turn.target === undefined ? '' : ` on tab ${turn.target}`}`);
      const result = await worker.chat(turn.text, policy.guidelines.trim());
      if (session.turn !== turn) return;
      const interrupted = result.interrupted ?? turn.interrupted;
      const stopped = interrupted || result.stopped || turn.stopping;
      session.transport.send({ type: 'chat.done', sessionId, toolCalls: result.toolCalls,
        text: interrupted ? withNote(result.text, INTERRUPT_NOTES[interrupted]) : result.text,
        ...(stopped ? { stopped: true } : {}), ...(interrupted ? { interrupted } : {}) });
    } catch (err) {
      if (session.turn !== turn) return;
      const m = err instanceof Error ? err.message : String(err);
      if (turn.phase === 'starting' && session.worker === this.agent) this.retireWorker(session, true);
      const code = looksLikeAuthError(m) ? 'auth' : 'internal';
      session.transport.send({ type: 'chat.error', sessionId, message: m, code });
      if (code === 'auth') {
        this.broadcast({
          type: 'auth.status', state: 'unauth',
          detail: 'github copilot needs sign-in.',
        });
      }
    } finally {
      if (session.turn === turn) {
        console.log(`  ■ chat ${sessionId}: ended after ${Math.round((Date.now() - t0) / 1000)} s`);
        if (session.worker !== this.agent || turn.stopping) this.retireWorker(session);
        this.release(turn);
      }
    }
  }

  // ── Outbound: translate Agent activity → BrowyProtocol ──────────────────

  private onAgentEvent(ws: WSMessage, owner?: SessionState): void {
    const translated = translateWsToProtocol(ws, owner?.turn?.phase === 'running' ? owner.id : null);
    if (!translated) return;
    if (owner && translated.type === 'host.status') {
      owner.transport.send({ ...translated, sessionId: owner.id });
      return;
    }
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

    case 'host_status':
      return { type: 'host.status', state: ws.state, ...(ws.detail ? { detail: ws.detail } : {}), ...(ws.cause ? { cause: ws.cause } : {}) };

    case 'response':
      // Agent's "final response" event. chat.done is emitted explicitly by
      // the runner once agent.chat() resolves, so we suppress this to avoid
      // double-emit. Kept here as a sentinel comment for future debuggers.
      return null;

    default:
      return null;
  }
}
