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

import type { Transport, ServerMessage, ToolResult, CdpEventFromClient, TabInfo } from '../protocol.js';
import type { BrowserToolContext } from './tools/browser.js';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string };

interface ExtTabState {
  tabId: number;
  url: string;
  title: string;
}

/**
 * One ExtensionContext per session. Holds the pending-call map and the
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
  private callSeq = 0;

  constructor(
    private sessionId: string,
    private transport: Transport,
  ) {}

  // ── Inbound from runner ─────────────────────────────────────────────────

  handleToolResult(msg: ToolResult): boolean {
    const p = this.pending.get(msg.callId);
    if (!p) return false;
    this.pending.delete(msg.callId);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || 'tool failed'));
    return true;
  }

  handleCdpEvent(msg: CdpEventFromClient): void {
    const subs = this.cdpListeners.get(msg.method);
    if (!subs) return;
    for (const cb of subs) {
      try { cb(msg.params); } catch { /* never let a listener crash routing */ }
    }
  }

  /** Reject every in-flight call. Called when the session/transport closes. */
  dispose(reason = 'session closed'): void {
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
    this.cdpListeners.clear();
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private nextCallId(prefix: string): string {
    return `${prefix}-${++this.callSeq}-${Date.now().toString(36)}`;
  }

  private sendAndWait<T = unknown>(envelope: Omit<ServerMessage, never>, method: string): Promise<T> {
    const callId = (envelope as any).callId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(callId, {
        resolve: (v) => resolve(v as T),
        reject,
        method,
      });
      try {
        this.transport.send(envelope as ServerMessage);
      } catch (e) {
        this.pending.delete(callId);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  // ── BrowserToolContext surface ──────────────────────────────────────────

  /** Returns a duck-typed BrowserToolContext. */
  build(): BrowserToolContext {
    const self = this;

    const cdp = {
      send: async (method: string, params?: unknown) => {
        const callId = self.nextCallId('cdp');
        const envelope = {
          type: 'cdp.send' as const,
          sessionId: self.sessionId,
          callId,
          tabId: self.activeTabId ?? undefined,
          method,
          params: params ?? {},
        };
        const wrapped = await self.sendAndWait<{ tabId: number; result: unknown }>(envelope, method);
        // Remember whichever tab the SW actually used so subsequent calls pin
        // to the same tab (avoids races if the user switches tabs mid-flow).
        if (wrapped && typeof wrapped.tabId === 'number') self.activeTabId = wrapped.tabId;
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
        await cdp.send('Page.navigate', { url });
        return null;
      },
      bringToFront: async () => { await self.activate(info.tabId); },
      close: async () => {
        // Best-effort tab close via runtime; extension doesn't currently
        // expose a tab.close protocol message — closing is rare in tools
        // and easily added later.
      },
    });

    return {
      cdp: cdp as unknown as BrowserToolContext['cdp'],
      browser: {
        contexts: () => [{
          newPage: async () => {
            const callId = self.nextCallId('tab');
            const info = await self.sendAndWait<TabInfo>(
              { type: 'tab.new', sessionId: self.sessionId, callId } as any,
              'tab.new',
            );
            const state: ExtTabState = { tabId: info.tabId, url: info.url, title: info.title };
            self.knownTabs.set(info.tabId, state);
            self.activeTabId = info.tabId;
            return makePage(state) as any;
          },
        }],
      } as unknown as BrowserToolContext['browser'],
      getPages: () => {
        // Tools call getPages() synchronously, so we return whatever is in
        // our cache. Callers that need a fresh list should chain a manual
        // tab.list call (added in Phase F if a tool actually needs it).
        return Array.from(self.knownTabs.values()).map((info) => makePage(info)) as any;
      },
      setActivePage: async (page: any) => {
        if (page && typeof page._tabId === 'number') {
          await self.activate(page._tabId);
        }
      },
      getActiveTabInfo: async () => {
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
  async refreshTabs(): Promise<ExtTabState[]> {
    const callId = this.nextCallId('tab');
    const tabs = await this.sendAndWait<TabInfo[]>(
      { type: 'tab.list', sessionId: this.sessionId, callId } as any,
      'tab.list',
    );
    this.knownTabs.clear();
    for (const t of tabs) {
      this.knownTabs.set(t.tabId, { tabId: t.tabId, url: t.url, title: t.title });
      if (t.active) this.activeTabId = t.tabId;
    }
    return Array.from(this.knownTabs.values());
  }

  private async activate(tabId: number): Promise<void> {
    const callId = this.nextCallId('tab');
    await this.sendAndWait<TabInfo>(
      { type: 'tab.activate', sessionId: this.sessionId, callId, tabId } as any,
      'tab.activate',
    );
    this.activeTabId = tabId;
  }
}
