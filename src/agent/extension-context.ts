// Phase E: BrowserToolContext over the BrowyProtocol.
//
// On the host side, when a session declares the cdp.activeTab capability,
// we build a BrowserToolContext whose .cdp.send / .cdp.on / .browser /
// .getPages / .setActivePage all turn into protocol messages routed back to
// the extension's background service worker (which fulfils them via
// chrome.debugger / chrome.tabs).
//
// Tools never need to know which mode they're in — the duck-typed surface is
// identical to the playwright-backed BrowserToolContext.

import type { Transport, ServerMessage, ToolResult, CdpEventFromClient, CdpDetached, TabInfo, NativeBrowserAction } from '../protocol.js';
import type { BrowserToolContext } from './tools/browser.js';

/** `tabId` is set for CDP calls that name their tab, so a detach can fail them. */
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string; tabId?: number };

/** What the model is told when Chrome takes the debugger off a tab. The
 *  extension sends its own wording since 0.1.14 (keep the two in step with
 *  extension/background.js); this covers older extensions, whose calls fail
 *  with Chrome's bare "Detached while handling command.". */
export function detachMessage(reason: string, tabGone = false): string {
  if (reason === 'canceled_by_user') {
    return "You clicked Cancel on Chrome's debugging bar, so Browy lost this tab. Ask me to try again and I'll reattach.";
  }
  if (tabGone) return "This tab was closed, so it's gone. Use list_tabs to pick another tab, or new_tab to open one.";
  if (reason === 'target_closed') {
    return "This tab went to a page Browy can't work on, like a chrome:// page, so Browy lost it. Go back to a normal web page, or pick another tab with list_tabs.";
  }
  if (reason === 'replaced_with_devtools') {
    return 'Chrome DevTools took over this tab, so Browy lost it. Close DevTools on that tab and ask me to try again.';
  }
  return 'Browy lost its connection to this tab. It reattaches on the next step, so try again.';
}

/** Chrome's own wording for a lost tab, as older extensions pass it on. */
function friendlyBrowserError(error: string): string {
  if (/^Detached while handling command/i.test(error)) return detachMessage('unknown');
  if (/^No tab with given id/i.test(error)) return detachMessage('target_closed', true);
  return error;
}

/** How long a call to the extension may go unanswered. Until 0.1.11 there was
 *  no limit: a tab that was frozen, discarded or blocked by a dialog left
 *  chrome.debugger without a reply, the tool call never returned, and the
 *  whole turn sat there until the five-minute watchdog gave up. */
const CDP_TIMEOUT_MS = 60_000;
const TAB_TIMEOUT_MS = 15_000;

interface ExtTabState {
  tabId: number;
  url: string;
  title: string;
}

/**
 * One ExtensionContext per turn. Holds the pending-call map and the
 * "active tab" for that session. Routed messages from the runner are
 * delivered via handleToolResult / handleCdpEvent.
 */
export class ExtensionContext {
  private pending = new Map<string, Pending>();
  /** method → set of subscribers. */
  private cdpListeners = new Map<string, Set<(params: unknown) => void>>();
  /** Which tab `cdp.send` targets. Null = "active tab" (resolved by SW). */
  private activeTabId: number | null = null;
  /** Cache of last-known tab list — populated by getPages-shaped callers. */
  private knownTabs = new Map<number, ExtTabState>();
  /** Detaches the model hasn't heard about yet, by tab. The next call to the
   *  tab fails with the reason once instead of quietly reattaching; a call
   *  after that reattaches. Cleared when a turn starts. */
  private notices = new Map<number, { message: string; tabGone: boolean }>();
  private callSeq = 0;
  private closed: string | null = null;

  constructor(
    private sessionId: string,
    private transport: Transport,
    /** Test hook: shortens every call deadline. */
    private timeoutOverrideMs?: number,
    private nativeIO = false,
    private claimTab?: (tabId: number) => void,
  ) {}

  // ── Inbound from runner ─────────────────────────────────────────────────

  handleToolResult(msg: ToolResult): boolean {
    const p = this.pending.get(msg.callId);
    if (!p) return false;
    this.pending.delete(msg.callId);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(friendlyBrowserError(msg.error || 'tool failed')));
    return true;
  }

  handleCdpEvent(msg: CdpEventFromClient): void {
    if (this.closed || ((this.claimTab || msg.tabId != null) && msg.tabId !== this.activeTabId)) return;
    const subs = this.cdpListeners.get(msg.method);
    if (!subs) return;
    for (const cb of subs) {
      try { cb(msg.params); } catch { /* never let a listener crash routing */ }
    }
  }

  /** Chrome took the debugger off a tab. Calls still waiting on it fail with
   *  the reason now. If none was waiting, the model hasn't been told, so the
   *  next call to that tab carries the news. */
  handleDetached(msg: CdpDetached): void {
    const tabId = Number(msg.tabId);
    if (!Number.isFinite(tabId)) return;
    const tabGone = !!msg.tabGone;
    const message = msg.message || detachMessage(msg.reason, tabGone);
    let told = Number(msg.failed) || 0;
    for (const [callId, p] of this.pending) {
      if (p.tabId !== tabId) continue;
      this.pending.delete(callId);
      p.reject(new Error(message));
      told++;
    }
    if (told === 0) {
      this.notices.set(tabId, { message, tabGone });
    } else if (tabGone) {
      this.forgetTab(tabId);
    }
  }

  /** A new turn: what happened to tabs before it is old news. */
  beginTurn(tabId?: number): void {
    this.notices.clear();
    // Resolve the current tab on first use, even if guidelines ruled out
    // taking the usual automatic snapshot at the start of this turn.
    this.activeTabId = tabId ?? null;
  }

  async startingTab(): Promise<number> {
    const t = await this.sendAndWait<TabInfo | null>({
      type: 'tab.getActive', sessionId: this.sessionId, callId: this.nextCallId('tab'),
    }, 'tab.getActive');
    if (!t || !Number.isSafeInteger(t.tabId) || t.tabId < 0) throw new Error('No target tab for this chat.');
    return t.tabId;
  }

  private checkTab(id: number) {
    if (this.closed) throw new Error(this.closed);
    this.claimTab?.(id);
  }

  private forgetTab(tabId: number): void {
    this.knownTabs.delete(tabId);
    if (this.activeTabId === tabId && !this.claimTab) this.activeTabId = null;
  }

  /** Reject every in-flight call, e.g. when the user presses Stop. */
  cancelPending(reason: string): void {
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
  }

  /** Reject every in-flight call. Called when the session/transport closes. */
  dispose(reason = 'session closed'): void {
    this.closed = reason;
    this.cancelPending(reason);
    this.cdpListeners.clear();
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private nextCallId(prefix: string): string {
    return `${prefix}-${this.instanceId}-${++this.callSeq}`;
  }

  private readonly instanceId = crypto.randomUUID();

  private sendAndWait<T = unknown>(envelope: Extract<ServerMessage, { callId: string }>, method: string, timeoutMs = TAB_TIMEOUT_MS, tabId?: number): Promise<T> {
    if (this.closed) return Promise.reject(new Error(this.closed));
    const callId = envelope.callId;
    const limit = this.timeoutOverrideMs ?? timeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(callId)) return;
        reject(new Error(`${method} got no answer from the browser in ${Math.round(limit / 1000)}s. `
          + 'The tab may be frozen, discarded or showing a dialog. Switching to it or reloading it usually helps.'));
      }, limit);
      this.pending.set(callId, {
        resolve: (v) => { clearTimeout(timer); resolve(v as T); },
        reject: (e) => { clearTimeout(timer); reject(e); },
        method,
        tabId,
      });
      try {
        this.transport.send(envelope);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(callId);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  // ── BrowserToolContext surface ──────────────────────────────────────────

  /** Returns a duck-typed BrowserToolContext. */
  build(pinnedTabId?: number): BrowserToolContext {
    const self = this;

    const cdp = {
      send: async (method: string, params?: unknown) => {
        const target = pinnedTabId ?? self.activeTabId ?? (self.claimTab ? await self.startingTab() : null);
        if (target !== null) self.checkTab(target);
        const notice = target != null ? self.notices.get(target) : undefined;
        if (notice) {
          self.notices.delete(target!);
          if (notice.tabGone) self.forgetTab(target!);
          throw new Error(notice.message);
        }
        const callId = self.nextCallId('cdp');
        const envelope = {
          type: 'cdp.send' as const,
          sessionId: self.sessionId,
          callId,
          tabId: target ?? undefined,
          method,
          params: params ?? {},
          ...(self.nativeIO ? { observePrompts: true } : {}),
        };
        // Runtime.evaluate can carry its own deadline; wait a little longer
        // than that so the page's own timeout error is the one reported.
        const own = Number((params as { timeout?: unknown } | undefined)?.timeout);
        const limit = Number.isFinite(own) && own > 0 ? Math.max(CDP_TIMEOUT_MS, own + 15_000) : CDP_TIMEOUT_MS;
        const wrapped = await self.sendAndWait<{ tabId: number; result: unknown }>(envelope, method, limit, target ?? undefined);
        if (self.claimTab && wrapped?.tabId !== target) throw new Error('The browser answered for a different tab. Its result was discarded.');
        // Remember whichever tab the SW actually used so subsequent calls pin
        // to the same tab (avoids races if the user switches tabs mid-flow).
        if (pinnedTabId === undefined && self.activeTabId === target && wrapped && typeof wrapped.tabId === 'number') {
          self.activeTabId = wrapped.tabId;
        }
        return wrapped?.result;
      },
      on: (event: string, cb: (params: unknown) => void) => {
        let subs = self.cdpListeners.get(event);
        if (!subs) { subs = new Set(); self.cdpListeners.set(event, subs); }
        subs.add(cb);
        return cdp;
      },
      off: (event: string, cb: (params: unknown) => void) => {
        const subs = self.cdpListeners.get(event);
        if (subs) subs.delete(cb);
        return cdp;
      },
    };

    const makePage = (info: ExtTabState) => ({
      _tabId: info.tabId,
      url: () => info.url,
      title: async () => info.title,
      goto: async (url: string) => {
        await self.activate(info.tabId);
        await self.build(info.tabId).cdp.send('Page.navigate', { url });
        return null;
      },
      bringToFront: async () => { await self.activate(info.tabId); },
      close: async () => {
        self.checkTab(info.tabId);
        const callId = self.nextCallId('tab');
        // Short deadline: extensions before 0.1.11 don't know tab.close and
        // never answer it.
        const next = await self.sendAndWait<TabInfo | null>(
          { type: 'tab.close', sessionId: self.sessionId, callId, tabId: info.tabId } as any,
          'tab.close',
          10_000,
        );
        self.knownTabs.delete(info.tabId);
        if (self.activeTabId === info.tabId) {
          self.activeTabId = next?.tabId ?? (self.claimTab ? info.tabId : null);
        }
      },
    });

    return {
      cdp: cdp as unknown as BrowserToolContext['cdp'],
      pinTarget: async () => {
        let id = pinnedTabId ?? self.activeTabId;
        if (id == null) {
          id = await self.startingTab();
          if (self.activeTabId == null) self.activeTabId = id;
        }
        self.checkTab(id);
        return self.build(id);
      },
      ...(this.nativeIO ? {
        nativeAction: async (action: NativeBrowserAction) => {
          const tabId = pinnedTabId ?? self.activeTabId ?? (self.claimTab ? await self.startingTab() : undefined);
          if (tabId !== undefined) self.checkTab(tabId);
          return self.sendAndWait({
            type: 'browser.native', sessionId: self.sessionId, callId: self.nextCallId('native'), tabId, action,
          }, action.kind, TAB_TIMEOUT_MS, tabId);
        },
      } : {}),
      browser: {
        contexts: () => [{
          newPage: async () => {
            const callId = self.nextCallId('tab');
            const info = await self.sendAndWait<TabInfo>(
              { type: 'tab.new', sessionId: self.sessionId, callId } as any,
              'tab.new',
            );
            const state: ExtTabState = { tabId: info.tabId, url: info.url, title: info.title };
            self.checkTab(info.tabId);
            self.knownTabs.set(info.tabId, state);
            self.activeTabId = info.tabId;
            return makePage(state) as any;
          },
        }],
      } as unknown as BrowserToolContext['browser'],
      listTabs: async () => {
        const tabs = await self.refreshTabs();
        const indices = new Map(tabs.map((t, i) => [t.tabId, i]));
        return tabs.map((t, index) => ({ index, title: t.title, url: t.url, windowId: t.windowId,
          activeInWindow: t.active, targeted: t.tabId === self.activeTabId,
          openerIndex: t.openerTabId === undefined ? undefined : indices.get(t.openerTabId) }));
      },
      getPages: () => {
        return Array.from(self.knownTabs.values()).map((info) => makePage(info)) as any;
      },
      getActivePageIndex: () => (self.activeTabId == null ? -1 : Array.from(self.knownTabs.keys()).indexOf(self.activeTabId)),
      setActivePage: async (page: any, background) => {
        if (page && typeof page._tabId === 'number') {
          if (background) {
            self.checkTab(page._tabId);
            self.activeTabId = page._tabId;
          }
          else await self.activate(page._tabId);
        }
      },
      getActiveTabInfo: async () => {
        if (self.claimTab) {
          const id = pinnedTabId ?? self.activeTabId ?? await self.startingTab();
          self.checkTab(id);
          const all = await self.refreshTabs();
          const tab = all.find((t) => t.tabId === id);
          if (!tab) throw new Error(detachMessage('target_closed', true));
          return { url: tab.url, title: tab.title, tabCount: all.length, brand: 'Browser' };
        }
        const callId = self.nextCallId('tab');
        try {
          const t = await self.sendAndWait<TabInfo | null>(
            { type: 'tab.getActive', sessionId: self.sessionId, callId } as any,
            'tab.getActive',
          );
          if (!t) return null;
          // Pin subsequent CDP calls to this tab so we don't race the user.
          if (typeof (t as any).tabId === 'number') self.activeTabId = (t as any).tabId;
          // Also fetch the full list to update tabCount cheaply.
          let tabCount = 1;
          try {
            const callId2 = self.nextCallId('tab');
            const tabs = await self.sendAndWait<TabInfo[]>(
              { type: 'tab.list', sessionId: self.sessionId, callId: callId2 } as any,
              'tab.list',
            );
            tabCount = Array.isArray(tabs) ? tabs.length : 1;
            // Refresh known-tab cache in passing.
            self.knownTabs.clear();
            for (const x of tabs) {
              self.knownTabs.set(x.tabId, { tabId: x.tabId, url: x.url, title: x.title });
            }
          } catch { /* tab.list optional */ }
          // Brand: derive from URL since the SW doesn't know.
          const url = (t as any).url || '';
          let brand = 'Browser';
          try {
            const h = new URL(url).hostname;
            if (/google\./i.test(h)) brand = 'Google';
          } catch {}
          return { url, title: (t as any).title || '', tabCount, brand };
        } catch {
          return null;
        }
      },
    };
  }

  /** Refresh the known-tab cache by asking the SW. Useful before tools that
   *  enumerate tabs (list_tabs / switch_tab). */
  async refreshTabs(): Promise<TabInfo[]> {
    const callId = this.nextCallId('tab');
    const tabs = await this.sendAndWait<TabInfo[]>(
      { type: 'tab.list', sessionId: this.sessionId, callId } as any,
      'tab.list',
    );
    this.knownTabs.clear();
    for (const t of tabs) {
      this.knownTabs.set(t.tabId, { tabId: t.tabId, url: t.url, title: t.title });
    }
    return tabs;
  }

  private async activate(tabId: number): Promise<void> {
    this.checkTab(tabId);
    const callId = this.nextCallId('tab');
    await this.sendAndWait<TabInfo>(
      { type: 'tab.activate', sessionId: this.sessionId, callId, tabId } as any,
      'tab.activate',
    );
    this.activeTabId = tabId;
  }
}
