import type { Config, ToolCallRecord, WSMessage, CdpEndpoint } from '../types.js';
import { getAllTools, type BrowserToolContext } from './tools/browser.js';
import { ensureSnapshot, serializeSnapshot } from './page-snapshot.js';
import { chromium, type Browser, type CDPSession, type Page } from 'playwright-core';
import os from 'os';
import path from 'path';
import { getForegroundInfo, brandFromProcessName, stripBrowserSuffix, shutdownForeground } from './foreground.js';

// Copilot SDK is CJS — use require
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { CopilotClient, defineTool, approveAll } = require('@github/copilot-sdk');

// ── Session isolation ─────────────────────────────────────────────────────
// Every Copilot SDK session BrowserAgent creates is tagged with these so it
// can never be confused with the user's regular `copilot` CLI sessions.
//
//   clientName       — appears in User-Agent / session metadata
//   workingDirectory — fake cwd so listSessions({cwd}) returns ONLY our
//                      sessions, never user coding sessions in real repos
const BROWSERAGENT_CLIENT_NAME = 'browseragent';
const BROWSERAGENT_WORKDIR = path.join(os.homedir(), '.browseragent', 'sessions');

/** Recognises sessionIds we mint (`sp-*` from the side panel, `dt-*` from
 *  the DevTools panel). Used to identify our sessions in listSessions(),
 *  whose `context.cwd` is unreliable for filtering (only populated from git). */
function isBrowySessionId(id: string): boolean {
  return /^(sp|dt)-/.test(id);
}

/** Strip the agent-side context blocks (<browser_context>, <page_snapshot>,
 *  <recent_actions>) we prepend to every user message so the chats list
 *  shows the actual user text, not our injected scaffolding.
 *  The SDK truncates session summaries to ~100 chars so the closing tag is
 *  often missing — handle both paired and unclosed cases. */
function cleanChatSummary(s: string | undefined): string | undefined {
  if (!s) return s;
  let out = s;
  const tags = ['browser_context', 'page_snapshot', 'recent_actions', 'page_stats', 'page_info'];
  // 1. Strip closed pairs.
  for (const t of tags) {
    out = out.replace(new RegExp(`<${t}>[\\s\\S]*?</${t}>`, 'g'), '');
  }
  // 2. Strip any unclosed opener through end-of-string (SDK truncated summary).
  for (const t of tags) {
    out = out.replace(new RegExp(`<${t}>[\\s\\S]*$`), '');
  }
  out = out.replace(/\s+/g, ' ').trim();
  // 3. If nothing useful remains (e.g. user's very first turn was pure context),
  // surface a placeholder so the row isn't blank.
  if (!out) return '(no summary)';
  return out;
}

const SYSTEM_PROMPT = `You are Browy — a browser-automation copilot that lives inside the user's browser as a side-panel extension. The user can drag you around as a small pixel mascot, type questions in the side panel, and watch you drive their real tabs in real time.

# IDENTITY — this is not optional
- Your name is **Browy**. If the user asks "who are you", "what are you", "what model is this", "what's your name", or anything similar, the answer is always: **"I'm Browy — a browser-automation copilot. I drive your tabs from a side panel using indexed snapshots and CDP."** Do NOT mention Copilot, Claude, GPT, OpenAI, Anthropic, GitHub, or any underlying model — the user picks a model in settings, but to them you are Browy regardless of which engine is running underneath. You may say "you can switch the underlying model in settings" if pressed about the model.
- Aesthetic: retro pixel-art mascot, terminal-green on dark, JetBrains Mono. Tone: concise, helpful, low-ceremony, slightly playful. Never roleplay as a different assistant. Never break character.
- You are not "the browser" — you operate it on the user's behalf. Their cookies, sessions, downloads, and history are real. Treat destructive actions (closing tabs, clearing storage, submitting forms) carefully.

# ENVIRONMENT
- You are a Chromium extension (Chrome/Brave/Edge) running side-panel + DevTools-panel UIs, talking to a Node native-messaging host that wraps the GitHub Copilot SDK and drives the page via the Chrome DevTools Protocol (CDP) through chrome.debugger.
- Every chat turn, the runtime injects a <browser_context> block containing:
  * Which tab is focused, its URL/title, viewport, scroll position, ready state.
  * <page_stats> — counts of interactive elements, links, inputs, iframes, total nodes. Hints when the page looks empty (SPA not loaded) or skeletony (still loading).
  * <page_info> — how many viewport-pages are above/below the current scroll position.
  * <page_snapshot> — an INDEXED LIST of the visible interactive elements, formatted as
        [N]<tag attr=val ...>visible text</tag>
    Off-viewport elements are prefixed with \`~N\` (still indexed; scroll first or just click — the tool auto-scrolls into view).
    Elements that are NEW since the previous snapshot are prefixed with \`*N\` — a popover opened, an autocomplete dropdown appeared, a modal mounted. Look there first when you just performed an action that should have revealed something.
    Checkboxes/radios show \`checked\` or \`unchecked\` so you don't toggle what's already on. \`<select>\` shows its current \`selected=…\` value and an \`options=[…]\` list — you usually don't need a separate read.
  * <recent_actions> — your last few tool calls in this turn-chain, with status (ok/err) and a trimmed result. Use this to verify the previous action took effect (urlChanged? newElementVisible?) before deciding what to do next. If the same action just failed, do NOT repeat it — switch strategy.
- Tab focus follows the user's actual focus. If they switch tabs, the next turn's <browser_context> reflects that automatically.
- **The <page_snapshot> is your eyes.** Each [N] is a stable handle for that exact element until you act in a way that mutates the DOM (navigate, click that loads new content, type into a search that opens a popup, etc.). After such an action, refresh with \`inspect_page\`.

# TOOLS — use this taxonomy
**Indexed interaction (PREFERRED for any UI action — these target elements by their [N] from the snapshot):**
- \`inspect_page\` — re-snapshot the page; returns fresh stats + the indexed listing. Call after navigations, clicks that change content, or whenever indices feel stale.
- \`click_index(index)\` — click element [N] (auto-scrolls into view; uses CDP Input.dispatchMouseEvent at element center).
- \`type_index(index, text, clear=true)\` — focus input [N], optionally clear, type text, fire input/change events.
- \`select_index(index, value)\` — set value on a native <select> element [N].
- \`clear_index(index)\` — empty an input.
- \`press_key(key)\` — global keyboard event (Enter, Tab, Escape, ...).
- \`scroll(direction, amount?)\` — scroll the page. Then call \`inspect_page\` to see newly-visible elements.

**Forms — use these together for fast, reliable form completion:**
- \`extract_form(index?)\` — read the form's schema FIRST: every field with its label, type, current value, options, required-ness. Plan your fill from this rather than guessing.
- \`fill_form(fields)\` — fill MANY fields in ONE call (JSON array of {index, value, action?}). Auto-detects type (input/select/checkbox/radio). Massively cheaper than one tool call per field.
- \`check_index(index, checked?)\` / \`set_radio_index(index)\` — checkboxes and radio buttons.
- \`upload_index(index, path)\` — file input by index, bypasses OS file dialog.
- \`submit_form(index?)\` — clicks the form's submit button (or falls back to requestSubmit). Returns urlChanged for verification.
- \`press_keys(keys)\` — combos like "Ctrl+Enter", "Tab", "Escape" (use after focus_index / type_index).

**Page state (when you need data, not interaction):**
- \`extract_text\` — visible text of page or selector.
- \`get_page_info\` — URL/title/meta/text preview.
- \`get_page_html\` — raw HTML of region.
- \`accessibility_snapshot\` — semantic AX tree (good for screen-reader-style understanding).
- \`screenshot\` — PNG of the viewport.

**Tabs:** \`list_tabs\`, \`switch_tab\`, \`new_tab\`, \`close_tab\`, \`navigate\` (opens new tab by default).

**Power tools:**
- \`evaluate_js\` — arbitrary JS in the page (top-level await ok). Use when indexed tools can't express what you need: shadow-DOM walks, custom waits, structured extraction, framework-specific APIs.
- \`run_script\` — Node.js on the user's machine for file I/O / shell.

**DevTools:** \`get_console_logs\`, \`get_network_requests\`, \`get_cookies\`, \`get_storage\`, \`replay_request\`.

**Files:** \`download_file\`, \`upload_file\`, \`pdf_export\`.

**Persistent disk + memory** (sandboxed at \`~/.browy/data/\`):
- \`save_file(filename, content)\` / \`read_file\` / \`list_files\` / \`delete_file\` — scratch disk for cached scrapes, intermediate work, anything you want to keep across turns/sessions. Paths are relative to the data root; you can't escape it.
- \`note_set(key, value, category?)\` / \`note_get\` / \`note_list\` / \`note_delete\` — persistent key-value memory for things you want to survive across DIFFERENT chats (user preferences, long-lived facts). **This is NOT your conversation history** — your conversation history is automatic and you always have it. Empty \`note_list\` ≠ empty context. Don't confuse them.

**Login / human-in-the-loop:**
- \`focus_index\` — real mouse-driven focus that triggers Chrome's saved-password autofill (type_index bypasses it).
- \`await_user(message)\` — pause and ask the human to do something themselves. **Use this for**: signing in, entering passwords, approving 2FA, solving captchas. NEVER type into a password field or guess credentials. The user's existing browser cookies make most logins one-time-only; trust the session.

**Legacy selector-based tools**(\`click_element\`, \`fill_input\`, \`query_dom\` by CSS) still exist as a fallback. They are brittle vs the indexed tools — use only when the element you want isn't in the snapshot (e.g. it lives in a deeply-nested iframe the snapshot skipped) or you've validated a stable selector via \`evaluate_js\`.

# OPERATING PRINCIPLES
1. **Prefer indices.** When the snapshot has [N] for what you want, use \`click_index\`/\`type_index\`/\`select_index\`. Don't guess CSS selectors.
2. **Read the <browser_context> before acting.** Stats hint when a page is skeletony (wait/scroll first). The snapshot already lists what's clickable — don't speculate.
3. **Refresh after mutation.** After navigate, after a click that loads new content, after expanding a menu — call \`inspect_page\`. Don't act on stale indices.
4. **Two-step combobox rule.** Custom dropdowns (not native <select>) need a click-to-open turn, then an inspect turn to see the options, then a click-option turn. Don't try to "type and pick" in one shot.
5. **Forms in three steps.** For any non-trivial form: \`extract_form\` → \`fill_form\` (one bulk call) → \`submit_form\`. Don't fill fields one tool call at a time. Don't submit before filling all required fields.
6. **Page-changing actions LAST in a batch.** If you must do multiple actions in one model turn, save the action that mutates the URL/page (form submit, navigate, link click) for last so earlier actions execute against the page you inspected.
7. **Verify after acting.** Each indexed action returns urlChanged / titleChanged signals — if a click should have navigated and didn't, treat as failure. Inspect, don't blindly retry.
8. **Loop breaker.** If you've taken 3 steps on the same URL with no progress, OR repeated the same failed action twice — STOP, switch strategy (different element, different URL, evaluate_js, ask the user).
9. **High-leverage shortcuts.**
   - For known destinations: \`navigate\` to a full URL beats clicking through.
   - For search: a \`?q=\` URL beats opening homepage + typing.
   - For complex flows: one \`evaluate_js\` block beats a chain of indexed clicks if you know the selectors.
10. **Use the user's current tab when it fits.** The \`<browser_context>\` shows the active URL — that's where the user is. If their request mentions "this page", "here", or a site they're already on, operate in that tab (interact, scroll, evaluate_js) instead of opening a fresh one. \`navigate\` defaults: same hostname → current tab, cross-host → new tab. Use \`switch_tab\` for already-open tabs they clearly mean.
11. **Be honest about failures.** If a step fails, one-line diagnose and try a different angle. Never apologise — just adapt.
12. **You always have your conversation history.** Every message you and the user have exchanged in this chat is in your context — automatically, every turn. If the user says "go on", "continue", "what about that", they mean the immediately preceding topic. Never tell the user "I have no prior context" or "no pending tasks" — that's wrong and confusing. \`note_list\` being empty means *cross-session notes* are empty, NOT that this conversation is empty.
13. **Code editors virtualize.** Monaco, CodeMirror 6, ProseMirror and similar editors only render the visible viewport — DOM scraping returns a partial slice, not the full document. To read the FULL content: scroll-and-collect, use the editor's JS API (e.g. \`view.state.doc.toString()\` for CM6, \`monaco.editor.getModels()[0].getValue()\` for Monaco), or fetch the source file from the host's API (Overleaf zip, GitHub raw, GDocs export). Don't trust \`textContent\` of \`.cm-content\` / \`.monaco-editor\` for completeness.
14. **Don't auth-probe — just try the action.** For things like upvote / like / follow / favorite / save / "add to cart", do NOT spend turns reading cookies, localStorage, or web-component properties (\`shreddit-app.loggedIn\`, \`__NEXT_DATA__.user\`, etc.) to guess whether the user is signed in — those are unreliable on modern SPAs (Shadow DOM, lazy hydration, token-only sessions). Just \`inspect_page\` → \`click_index\` the button. If clicking opens a login modal, navigates to /login, or the button's pressed-state doesn't flip, THEN call \`await_user\` to ask the human to sign in. The user's cookies almost always make them already signed in — assume yes until an action proves otherwise.
15. **After navigate + wait, ALWAYS \`inspect_page\` before the next interaction.** The auto-snapshot in <browser_context> reflects the page at turn-start; if you just navigated this turn, your indices are stale. Never \`evaluate_js\` for an element that an \`inspect_page\` would have surfaced — the indexed snapshot already pierces Shadow DOM and same-origin iframes.
16. **Known lite/legacy hosts — use them for write actions on hostile SPAs.** Some sites maintain a server-rendered alternative that's far easier to drive than the modern SPA. When the user wants to upvote / comment / post / edit / favorite on one of these, navigate to the lite version first:
    - reddit.com → \`old.reddit.com\` (full feature parity, plain HTML)
    - en.wikipedia.org → \`en.m.wikipedia.org\` (cleaner DOM)
    - facebook.com → \`mbasic.facebook.com\` (text-only, write actions work)
    - news.ycombinator.com → already minimal, no swap needed
    For READ-only tasks on the modern site, stay put. For everything else (Twitter/X, Instagram, Discord, LinkedIn, Notion, YouTube, Slack, Figma, Google Docs, Overleaf), no lite version exists — use the indexed tools, scroll to reveal, and trust the snapshot.
17. **SPA state-change loop — read the click result first.** \`click_index\` and \`type_index\` return verification flags: \`urlChanged\`, \`titleChanged\`, \`domChanged\` (visible-text shifted), \`modalAppeared\` / \`modalClosed\`, \`elementStateChanged\` (aria-pressed/expanded/selected/checked flipped). If ANY are true, the action took effect — proceed (call \`inspect_page\` only if you need fresh indices). If ALL are false, the click was a no-op: an overlay intercepted it, the element was disabled, or the SPA is still rendering. Read the tool's \`hint\` field, then \`wait_for\` for an expected post-state element, \`scroll\` if new content might be below the fold, or pick a different element. After two failed retries on the same element, switch strategy (different element, \`evaluate_js\` to read framework state directly, or \`await_user\` if it looks like an auth/permission gate).
18. **Virtualized lists drop their DOM as you scroll.** LinkedIn feed, Twitter/X timeline, Discord channel, Slack thread, infinite-scroll search results — these unmount items once they leave the viewport. If the user wants data from a list longer than one screen, capture-as-you-go: \`inspect_page\` → extract the visible items → \`save_file('feed-page-N.json', JSON.stringify(items))\` → \`scroll('down')\` → repeat. Do NOT scroll all the way down then try to query at the end; the early items are gone. Stop when the snapshot shows no new items after a scroll, or a well-known sentinel ("End of feed", "No more posts") appears.
19. **Modals and overlays close via X / Escape, not backdrop clicks.** Most SPA modals (Google Docs share dialog, LinkedIn message composer, Discord settings, Notion menus) ignore clicks on the backdrop or on elements behind the modal — those clicks reach the underlay but don't dismiss the overlay. To close: \`inspect_page\`, find the modal's close button (X icon, "Cancel", "Done"), \`click_index\` it; or \`press_key('Escape')\` for menus and lightboxes. If a click at the page level isn't doing anything, suspect an invisible overlay is intercepting events — check the snapshot for a modal/drawer element near the top of the z-stack.

# OUTPUT STYLE
- Default to short, direct answers. Show only the result the user asked for; don't narrate every tool call.
- Use markdown sparingly: code blocks for code, lists for clear enumerations, no headings inside short answers.
- When a result derives from a page, briefly say *what tab/URL* it came from so the user can verify.
- Never expose internal IDs, tokens, or paths the user didn't share with you.`;

export type ActivityCallback = (msg: WSMessage) => void;

interface BrowserConnection {
  brand: string;
  url: string;
  browser: Browser;
}

/** Host (Copilot SDK) tools the user is allowed to opt into via the
 *  extension Settings page. These reach the host machine's filesystem and
 *  shell, so they're OFF by default and added to the strict `availableTools`
 *  allowlist only when the user explicitly enables them. The names mirror
 *  the SDK's built-in tool surface — we don't reimplement them, we just
 *  stop suppressing them from the model. Anything not in this set is
 *  ignored even if requested, so a compromised renderer can't escalate. */
const HOST_TOOL_ALLOWLIST = new Set<string>([
  'read_file', 'write_file', 'bash', 'grep', 'glob', 'web_fetch',
]);

export class Agent {
  private config: Config;
  /** All currently-connected browsers (Brave, Edge, Chrome, ...). */
  private connections: BrowserConnection[] = [];
  /** Convenience handle to the connection that owns the active page. Updated
   *  whenever setActivePageInternal runs. Tools that need a Browser handle
   *  read this so they always operate on the user's currently-focused browser. */
  private get browser(): Browser | null {
    return this.activeConnection?.browser || this.connections[0]?.browser || null;
  }
  private activeConnection: BrowserConnection | null = null;
  private cdp: CDPSession | null = null;
  private activePage: Page | null = null;
  private copilotClient: any = null;
  private copilotSession: any = null;
  /** Resolves when initCopilot() finishes (either successfully or by throwing).
   *  Callers that need copilotClient (chat, listModels, etc.) must await this
   *  before touching it — otherwise they race the host bootstrap and see a
   *  null client even though the panel has already painted "host ready". */
  private copilotReady: Promise<void> | null = null;
  /** Browy protocol session id (e.g. side-panel session). When set, this is
   *  used as the Copilot SDK sessionId so that reloading the panel resumes
   *  the same conversation instead of starting fresh. */
  private browyProtocolSessionId: string | null = null;
  /** Names of tools the user has disabled from the built-in browser-tool
   *  registry. ensureSession() removes these from the SDK's allowlist before
   *  creating/resuming a session. Empty set = no overrides (all built-ins). */
  private disabledTools: Set<string> = new Set();
  /** Names of Copilot SDK host tools the user has explicitly opted into via
   *  the extension Settings (read_file, write_file, bash, grep, glob,
   *  web_fetch). Default empty — these are off unless the user enables them.
   *  Names listed here are added to `availableTools` so the SDK's built-in
   *  implementations become reachable from the model. */
  private enabledHostTools: Set<string> = new Set();
  private onActivity: ActivityCallback = () => {};
  private currentTabInfo: { url: string; title: string; brand: string; tabCount: number } = {
    url: '', title: '', brand: 'Browser', tabCount: 0,
  };
  private rediscoverTimer: NodeJS.Timeout | null = null;
  /** Ring buffer of the last few tool calls — surfaced as <recent_actions> in
   *  the next chat turn so the agent sees its own trajectory (browser-use,
   *  ReAct, SeeAct all do this — closes the loop on "did the click work?"). */
  private recentActions: { name: string; args: string; result: string; ok: boolean; ms: number }[] = [];
  private static readonly RECENT_ACTIONS_LIMIT = 5;

  constructor(config: Config) {
    this.config = config;
  }

  setActivityCallback(cb: ActivityCallback) {
    this.onActivity = cb;
  }

  async connect(): Promise<{ tabs: { id: number; title: string; url: string }[] }> {
    // Phase E: extension mode skips the playwright browser entirely.
    if (this.contextOverride) {
      console.log('  ✅ Extension-mode CDP context — skipping playwright launch');
      return { tabs: [] };
    }
    // Try every configured endpoint in parallel. Succeed if at least one
    // responds. Endpoints that aren't running are silently skipped.
    const results = await Promise.allSettled(
      this.config.cdpEndpoints.map(ep => this.tryConnect(ep))
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) this.connections.push(r.value);
    }

    if (this.connections.length === 0) {
      // Fall back to legacy single endpoint as a last resort
      try {
        const browser = await chromium.connectOverCDP(this.config.cdpUrl);
        this.connections.push({ brand: 'Browser', url: this.config.cdpUrl, browser });
      } catch {
        throw new Error(
          `Could not connect to any browser. Tried: ${this.config.cdpEndpoints.map(e => `${e.brand}@${e.url}`).join(', ')}.\n` +
          `Launch a browser with --remote-debugging-port=9222 (Brave), 9223 (Edge), or 9224 (Chrome).`
        );
      }
    }

    // Print a summary so the user knows which browsers are wired up
    const brands = this.connections.map(c => c.brand).join(', ');
    console.log(`  ✅ Connected to ${this.connections.length} browser${this.connections.length > 1 ? 's' : ''}: ${brands}`);

    // Pick an initial active page from the first connection that has one
    for (const conn of this.connections) {
      const pages = conn.browser.contexts().flatMap(c => c.pages());
      const real = pages.find(p => !p.url().startsWith('about:')) || pages[0];
      if (real) {
        await this.setActivePageInternal(real, conn);
        break;
      }
    }

    // Aggregate tab list across all connections (used only for the legacy return value)
    const tabs: { id: number; title: string; url: string }[] = [];
    let id = 0;
    for (const conn of this.connections) {
      for (const p of conn.browser.contexts().flatMap(c => c.pages())) {
        tabs.push({ id: id++, title: '', url: p.url() });
      }
    }

    // Begin background re-discovery so newly-launched browsers get picked up
    this.startRediscoveryLoop();

    return { tabs };
  }

  /** Try to connect to a single CDP endpoint. Wires up tab listeners +
   *  activity tracker + disconnect handler. Returns null if the endpoint
   *  is not reachable. */
  private async tryConnect(ep: CdpEndpoint): Promise<BrowserConnection | null> {
    let browser: Browser;
    try {
      browser = await chromium.connectOverCDP(ep.url, { timeout: 1500 });
    } catch {
      return null;
    }
    const conn: BrowserConnection = { brand: ep.brand, url: ep.url, browser };
    await this.wireConnection(conn);
    return conn;
  }

  private async wireConnection(conn: BrowserConnection) {
    // Install activity tracker on every existing context AND every future one
    for (const c of conn.browser.contexts()) {
      await this.installActivityTracker(c);
    }
    // React to new tabs/windows in this browser
    for (const c of conn.browser.contexts()) {
      c.on('page', async (page) => {
        try { await this.injectActivityTracker(page); } catch {}
        this.refreshTabInfo().catch(() => {});
      });
    }
    // Drop the connection cleanly if the browser quits
    conn.browser.on('disconnected', () => {
      const idx = this.connections.indexOf(conn);
      if (idx >= 0) {
        this.connections.splice(idx, 1);
        console.log(`  ⚠️  ${conn.brand} disconnected (browser closed)`);
        if (this.activeConnection === conn) {
          this.activeConnection = null;
          this.activePage = null;
          this.cdp = null;
          this.detectFocusedTab().catch(() => {});
        }
        // Kick off an immediate rediscovery — user may have just killed
        // this browser to switch to another one already running.
        this.runRediscovery().catch(() => {});
      }
    });
  }

  /** Periodically re-attempt connection to any endpoint we don't currently
   *  have. This makes Browy notice a browser that the user launched after
   *  Browy itself started — or one they killed and relaunched on the same
   *  port. */
  private rediscovering = false;
  private async runRediscovery() {
    if (this.rediscovering) return;
    // Quick exit when nothing to discover — saves a Promise allocation
    // every 2s in extension/native-host mode where cdpEndpoints is empty
    // and rediscovery is a pure no-op.
    if (!this.config.cdpEndpoints || this.config.cdpEndpoints.length === 0) return;
    this.rediscovering = true;
    try {
      const have = new Set(this.connections.map(c => c.url));
      const found: BrowserConnection[] = [];
      await Promise.all(this.config.cdpEndpoints.map(async (ep) => {
        if (have.has(ep.url)) return;
        const conn = await this.tryConnect(ep);
        if (conn) found.push(conn);
      }));
      for (const conn of found) {
        this.connections.push(conn);
        console.log(`  🔌 Discovered new browser: ${conn.brand}`);
        // If we currently have no active page, adopt this browser immediately
        if (!this.activePage) {
          const pages = conn.browser.contexts().flatMap(c => c.pages());
          const real = pages.find(p => !p.url().startsWith('about:')) || pages[0];
          if (real) await this.setActivePageInternal(real, conn);
        }
      }
    } finally {
      this.rediscovering = false;
    }
  }

  private startRediscoveryLoop() {
    if (this.rediscoverTimer) return;
    // No endpoints → no rediscovery loop. Saves CPU and (more importantly
    // in MV3 contexts) avoids keeping the host's event loop hot 24/7.
    if (!this.config.cdpEndpoints || this.config.cdpEndpoints.length === 0) return;
    // 2s cadence — fast enough that opening a new browser feels instant in
    // the UI without hammering CDP endpoints.
    this.rediscoverTimer = setInterval(() => { this.runRediscovery().catch(() => {}); }, 2000);
  }

  /** Source of the tracker — installed once via addInitScript on every context
   *  and also injected directly into already-open pages. Stamps a global with
   *  the timestamp of the latest real user interaction in this tab. */
  private static readonly ACTIVITY_SCRIPT = `(() => {
    if (window.__browyTracker) return;
    window.__browyTracker = true;
    window.__browyLastActive = document.visibilityState === 'visible' ? Date.now() : 0;
    const stamp = () => {
      if (document.visibilityState === 'visible') window.__browyLastActive = Date.now();
    };
    ['mousemove','mousedown','keydown','scroll','wheel','touchstart','focus'].forEach(ev => {
      window.addEventListener(ev, stamp, { capture: true, passive: true });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') window.__browyLastActive = Date.now();
    }, true);
  })();`;

  private async installActivityTracker(ctx: any) {
    try { await ctx.addInitScript(Agent.ACTIVITY_SCRIPT); } catch { /* fallthrough */ }
    // Backfill into already-loaded pages (addInitScript only affects future loads)
    for (const page of ctx.pages()) {
      await this.injectActivityTracker(page);
    }
  }

  private async injectActivityTracker(page: Page) {
    const url = page.url();
    if (url === 'about:blank' || /^(chrome|brave|edge|about|devtools):/.test(url)) return;
    try { await page.evaluate(Agent.ACTIVITY_SCRIPT); } catch { /* ignore */ }
  }

  async initCopilot() {
    if (this.copilotReady) return this.copilotReady;
    this.copilotReady = this._initCopilotImpl();
    return this.copilotReady;
  }

  /** Await whatever initCopilot() is doing (or has done). Safe to call before
   *  initCopilot() — resolves immediately to undefined in that case so callers
   *  can decide how to behave when the SDK isn't initialised yet. */
  async whenCopilotReady(): Promise<void> {
    if (this.copilotReady) { try { await this.copilotReady; } catch {} }
  }

  private async _initCopilotImpl() {
    console.log('  Initializing Copilot SDK...');
    // Ensure our isolated workdir exists so workingDirectory passed to
    // createSession is valid on the spawned `copilot` subprocess.
    try { (await import('fs')).mkdirSync(BROWSERAGENT_WORKDIR, { recursive: true }); } catch {}
    this.copilotClient = new CopilotClient();
    await this.copilotClient.start();
    // Sweep stale BrowserAgent sessions left over from previous runs
    // (crashes, kill -9, etc.) so they don't accumulate on disk.
    // Sessions persist across host restarts (so the side panel can reload and
    // resume). We deliberately do NOT call cleanupOrphanSessions() on init —
    // doing so would nuke the session that the panel is about to resume.
    // Old sessions accumulate slowly and can be removed via the Clear button
    // (handles deleteSession of just that one) or manually under
    // ~/.browseragent/sessions if needed. A periodic age-based prune can be
    // added later.
    // Validate that the configured model actually exists; fall back to the
    // first available model otherwise. Saves a confusing "Model X is not
    // available" error on the very first chat after install.
    try {
      const models = await this.copilotClient.listModels();
      const ids: string[] = (models || []).map((m: any) => m.id);
      if (ids.length && !ids.includes(this.config.model)) {
        const preferred = ids.find(id => /claude-sonnet-4\.?5/i.test(id))
                       || ids.find(id => /claude-sonnet/i.test(id))
                       || ids.find(id => /^gpt-5/i.test(id))
                       || ids[0];
        console.log(`  ⚠ configured model "${this.config.model}" not available; using "${preferred}"`);
        this.config.model = preferred;
      }
    } catch { /* listModels can fail pre-auth — leave config as-is */ }
    // One-shot prune of old Browy sessions on startup. Sessions accumulate
    // forever otherwise (one per panel open) and slow down listSessions
    // (which walks every session on disk). Keep the 100 most recent and
    // delete anything older than 30 days. User-CLI sessions are untouched.
    this.pruneOldBrowySessions().catch(() => {});
    console.log('  ✅ Copilot SDK ready');
  }

  private async pruneOldBrowySessions() {
    if (!this.copilotClient) return;
    try {
      const sessions = await this.copilotClient.listSessions();
      if (!Array.isArray(sessions) || sessions.length === 0) return;
      const ours = sessions
        .filter((s: any) => isBrowySessionId(s?.sessionId || ''))
        .filter((s: any) => !s?.context?.cwd || s.context.cwd === BROWSERAGENT_WORKDIR)
        .map((s: any) => ({
          id: s.sessionId,
          mod: s.modifiedTime instanceof Date ? s.modifiedTime.getTime() : Number(s.modifiedTime) || 0,
        }))
        .sort((a, b) => b.mod - a.mod);
      const KEEP_RECENT = 100;
      const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
      const cutoff = Date.now() - MAX_AGE_MS;
      const toDelete = ours.slice(KEEP_RECENT).filter(s => s.mod < cutoff);
      if (toDelete.length === 0) return;
      let removed = 0;
      for (const s of toDelete) {
        try { await this.copilotClient.deleteSession(s.id); removed++; } catch {}
      }
      if (removed > 0) console.log(`  🧹 Pruned ${removed} old Browy session${removed > 1 ? 's' : ''} (>30d, keeping ${KEEP_RECENT} most recent)`);
    } catch { /* non-fatal */ }
  }

  private async cleanupOrphanSessions() {
    try {
      const sessions = await this.copilotClient.listSessions();
      if (!Array.isArray(sessions) || sessions.length === 0) return;
      let removed = 0;
      for (const meta of sessions) {
        const id = meta?.sessionId || '';
        // Defense-in-depth: only delete sessions we recognise as ours by
        // sessionId prefix. Never touch the user's copilot-CLI sessions.
        if (!isBrowySessionId(id)) continue;
        if (meta?.context?.cwd && meta.context.cwd !== BROWSERAGENT_WORKDIR) continue;
        try { await this.copilotClient.deleteSession(id); removed++; } catch {}
      }
      if (removed > 0) console.log(`  🧹 Cleaned up ${removed} orphan session${removed > 1 ? 's' : ''}`);
    } catch { /* listSessions may not be supported on all CLI versions */ }
  }

  private buildCopilotTools(ctx: BrowserToolContext) {
    const allTools = getAllTools();
    const self = this;

    return allTools.map(tool => {
      return defineTool(tool.def.name, {
        description: tool.def.description,
        parameters: tool.def.parameters,
        handler: async (args: Record<string, unknown>) => {
          const freshCtx = self.getBrowserContext();
          // Stable id so UI can match start↔end of the same call
          const id = `${tool.def.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

          self.emit({ type: 'activity', event: 'tool_start', tool: tool.def.name, args });
          self.emit({ type: 'tool_step', id, name: tool.def.name, args, status: 'start' });
          const t0 = Date.now();
          let result = '';
          try {
            result = await tool.run(args, freshCtx);
            const dur = Date.now() - t0;
            self.emit({ type: 'activity', event: 'tool_end', tool: tool.def.name, result: result.slice(0, 300), durationMs: dur });
            self.emit({ type: 'tool_step', id, name: tool.def.name, status: 'end', result: result.slice(0, 200), durationMs: dur });
            self.recordRecentAction(tool.def.name, args, result, true, dur);
          } catch (err) {
            const dur = Date.now() - t0;
            const errMsg = err instanceof Error ? err.message : String(err);
            self.emit({ type: 'tool_step', id, name: tool.def.name, status: 'error', result: errMsg, durationMs: dur });
            self.recordRecentAction(tool.def.name, args, errMsg, false, dur);
            throw err;
          }

          // Reconnect CDP after navigation
          if (tool.def.name === 'navigate') {
            await self.reconnectToActivePage();
          }

          return result;
        },
      });
    });
  }

  private async setActivePageInternal(page: Page, conn?: BrowserConnection) {
    const newConn = conn || this.connectionForPage(page);
    const oldBrand = this.activeConnection?.brand;
    this.activePage = page;
    this.activeConnection = newConn;
    this.cdp = await page.context().newCDPSession(page);
    await this.cdp.send('Page.enable');
    await this.cdp.send('Runtime.enable');
    if (newConn && oldBrand && oldBrand !== newConn.brand) {
      console.log(`  🔁 Active browser changed: ${oldBrand} → ${newConn.brand}`);
    }
  }

  /** Find which BrowserConnection a Page belongs to. */
  private connectionForPage(page: Page): BrowserConnection | null {
    const owner = page.context().browser();
    return this.connections.find(c => c.browser === owner) || null;
  }

  async reconnectToActivePage() {
    if (this.activePage) {
      try {
        this.cdp = await this.activePage.context().newCDPSession(this.activePage);
        await this.cdp.send('Page.enable');
        await this.cdp.send('Runtime.enable');
        return;
      } catch { /* fall through */ }
    }
    await this.detectFocusedTab();
  }

  private async detectFocusedTab() {
    if (this.connections.length === 0) return;

    // 1. Probe the OS for the foreground window. We get BOTH the process name
    //    (→ brand) AND the window title. Window title is the strongest signal:
    //    every Chromium browser puts the active tab's title in the title bar,
    //    so matching it against page.title() pinpoints the exact tab — even
    //    across multiple windows of the same browser, and even when the user
    //    just alt-tabbed without interacting with the page (no mouse/scroll
    //    events fire, but the OS title bar instantly reflects truth).
    const fg = await getForegroundInfo();
    const fgBrand = fg ? brandFromProcessName(fg.processName) : null;
    const fgTitlePrefix = fg ? stripBrowserSuffix(fg.title).toLowerCase() : '';

    // 2. Collect candidates from every connection
    type Candidate = {
      page: Page; conn: BrowserConnection; title: string;
      lastActive: number; visible: boolean; focused: boolean; titleMatch: boolean;
    };
    const candidates: Candidate[] = [];
    for (const conn of this.connections) {
      const pages = conn.browser.contexts().flatMap(ctx => ctx.pages());
      for (const page of pages) {
        const url = page.url();
        if (url === 'about:blank' || /^(chrome|brave|edge|about|devtools):/.test(url)) continue;
        try {
          const probe = await page.evaluate(`({
            lastActive: window.__browyLastActive || 0,
            vis: document.visibilityState,
            focus: document.hasFocus(),
            title: document.title,
          })`) as { lastActive: number; vis: string; focus: boolean; title: string };
          const pageTitle = (probe.title || '').toLowerCase();
          // Title match: foreground window title contains this page's title,
          // OR the page's title starts with the foreground title prefix. We
          // require a non-trivial overlap (>= 4 chars) to avoid spurious
          // matches on tiny titles like "X" or empty strings.
          const titleMatch = !!fgTitlePrefix && !!pageTitle && pageTitle.length >= 4 && (
            fgTitlePrefix === pageTitle ||
            fgTitlePrefix.startsWith(pageTitle) ||
            pageTitle.startsWith(fgTitlePrefix) ||
            fgTitlePrefix.includes(pageTitle)
          ) && (!fgBrand || conn.brand === fgBrand);
          candidates.push({
            page, conn, title: probe.title || '',
            lastActive: probe.lastActive,
            visible: probe.vis === 'visible',
            focused: probe.focus,
            titleMatch,
          });
        } catch { /* page may be closed/restricted */ }
      }
    }
    if (candidates.length === 0) return;

    // 3. Score. Priority order (highest first):
    //    a. document.hasFocus()          — page is literally the focused element
    //    b. titleMatch                   — OS title bar matches this page's title
    //    c. Page in the foreground brand — Win32 says this browser is on top
    //    d. visibilityState === visible  — page is on a visible tab in its window
    //    e. Most recent activity stamp   — fallback for "last thing you touched"
    candidates.sort((a, b) => {
      if (a.focused !== b.focused) return a.focused ? -1 : 1;
      if (a.titleMatch !== b.titleMatch) return a.titleMatch ? -1 : 1;
      const aFg = !!fgBrand && a.conn.brand === fgBrand;
      const bFg = !!fgBrand && b.conn.brand === fgBrand;
      if (aFg !== bFg) return aFg ? -1 : 1;
      if (a.visible !== b.visible) return a.visible ? -1 : 1;
      return b.lastActive - a.lastActive;
    });

    const winner = candidates[0];
    if (winner.page !== this.activePage) {
      await this.setActivePageInternal(winner.page, winner.conn);
    } else if (winner.conn !== this.activeConnection) {
      this.activeConnection = winner.conn;
    }
  }

  /** Bind the agent to a Browy-protocol session id. Subsequent ensureSession()
   *  calls will resume the matching Copilot SDK session if it exists, or
   *  create one with this exact id so the next reload can find it again.
   *  If a different SDK session is currently open, detach (without deleting)
   *  so it can be resumed later by its own caller. */
  setBrowyProtocolSessionId(id: string): void {
    if (this.browyProtocolSessionId === id) return;
    if (this.copilotSession) {
      const old = this.copilotSession;
      this.copilotSession = null;
      // Fire-and-forget — don't delete on disk, just close our handle.
      Promise.resolve().then(async () => {
        try { await old.abort(); } catch {}
        try { await old.disconnect(); } catch {}
      });
    }
    this.browyProtocolSessionId = id;
  }

  /** Per-user tool blocklist set by the client (typically the extension
   *  Settings page via session.start). ensureSession() removes these names
   *  from the SDK's allowlist. Pass an empty array to clear all overrides.
   *  Does not affect the SDK session that's already open — call after a
   *  history.clear or session.end/start cycle for it to take effect. */
  setDisabledTools(names: readonly string[]): void {
    this.disabledTools = new Set(names);
  }

  /** Mirror of setDisabledTools for the host-tool opt-in. The whitelist of
   *  acceptable names lives in HOST_TOOL_ALLOWLIST below — anything else is
   *  ignored so a compromised extension can't quietly enable arbitrary SDK
   *  capabilities. Empty list (default) keeps all host tools blocked. */
  setEnabledHostTools(names: readonly string[]): void {
    const safe = (names || []).filter((n) => HOST_TOOL_ALLOWLIST.has(n));
    this.enabledHostTools = new Set(safe);
  }

  private async ensureSession() {
    if (this.copilotSession) return;
    // Tools close over `self.getBrowserContext()` and read the current CDP at
    // call time, so we only need to build them once per session.
    const tools = this.buildCopilotTools(this.getBrowserContext());
    const wantId = this.browyProtocolSessionId;

    // SECURITY: lock the SDK to ONLY our browser tools. By default the SDK
    // exposes the full Copilot CLI tool surface (read_file, write_file, bash,
    // grep, glob, web_fetch, etc.). A prompt injection on any visited page
    // could otherwise read ~/.ssh, run arbitrary shell, or exfiltrate files.
    // `availableTools` is a strict allowlist — anything not listed is
    // unavailable, regardless of the SDK's defaults. (NB: the previous
    // `includeDefaultTools: false` flag was *not* a real SDK option and was
    // being silently ignored.)
    //
    // PER-USER OVERLAY: when the user has disabled tools via the extension
    // Settings page (forwarded on session.start), we further trim the
    // allowlist. Disabled names are also stripped from the `tools` array we
    // hand the SDK so even the function definitions don't leak into the
    // model's prompt.
    const blocked = this.disabledTools;
    const filteredTools = blocked.size ? tools.filter((t) => !blocked.has(t.name)) : tools;
    const allowedToolNames = filteredTools.map((t) => t.name);
    // Host-tool opt-in: extend the strict allowlist with SDK tools the user
    // enabled in Settings. We do NOT add their definitions to `tools` — the
    // SDK ships its own implementations; we just stop suppressing them.
    if (this.enabledHostTools.size) {
      for (const name of this.enabledHostTools) {
        if (!allowedToolNames.includes(name)) allowedToolNames.push(name);
      }
    }

    // Try to resume an existing on-disk session for this Browy id. This is
    // what makes "reload the side panel and pick up where I left off" work.
    if (wantId) {
      try {
        this.copilotSession = await this.copilotClient.resumeSession(wantId, {
          clientName: BROWSERAGENT_CLIENT_NAME,
          workingDirectory: BROWSERAGENT_WORKDIR,
          model: this.config.model,
          tools: filteredTools,
          availableTools: allowedToolNames,
          onPermissionRequest: approveAll,
        });
        return;
      } catch {
        // Session doesn't exist (first run, or was cleared) — fall through
        // and create a new one bound to this same id.
      }
    }

    this.copilotSession = await this.copilotClient.createSession({
      // Use the Browy protocol id as the SDK session id so reloads can resume.
      sessionId: wantId || undefined,
      // Identity so we can never collide with the user's `copilot` CLI sessions
      clientName: BROWSERAGENT_CLIENT_NAME,
      workingDirectory: BROWSERAGENT_WORKDIR,
      systemPrompt: SYSTEM_PROMPT,
      model: this.config.model,
      tools: filteredTools,
      availableTools: allowedToolNames,
      onPermissionRequest: approveAll,
    });
  }

  async chat(userText: string): Promise<{ text: string; toolCalls: ToolCallRecord[] }> {
    await this.whenCopilotReady();
    if (!this.copilotClient) {
      throw new Error('Copilot SDK is not initialised yet — try again in a moment, or run /signin if this persists.');
    }
    await this.detectFocusedTab();
    await this.refreshTabInfo();
    // Extension mode: Agent has no playwright activePage, so refreshTabInfo
    // can't populate currentTabInfo. Pull it directly from the BrowserToolContext.
    if (this.contextOverride?.getActiveTabInfo) {
      try {
        const info = await this.contextOverride.getActiveTabInfo();
        if (info && info.url) {
          this.currentTabInfo = {
            url: info.url,
            title: info.title || '',
            brand: info.brand || 'Browser',
            tabCount: info.tabCount || 1,
          };
        }
      } catch { /* fall through to whatever refreshTabInfo set */ }
    }
    this.emit({ type: 'status', status: 'thinking' });

    try {
      await this.ensureSession();

      this.emit({ type: 'activity', event: 'llm_call_start' });
      const t0 = Date.now();

      // Inject live browser context so the agent always knows what tab is
      // focused without needing a tool call. This dramatically reduces
      // round-trips for "summarize this page", "what am I looking at", etc.
      const ctx = this.currentTabInfo;
      const cdpForCtx = this.getCdpForContext();
      const extras = await this.captureLiveContext(cdpForCtx);
      const contextLines: string[] = [];
      if (ctx.url) {
        contextLines.push(`Browser:    ${ctx.brand}`);
        contextLines.push(`Active tab: ${JSON.stringify(ctx.title || 'untitled')}`);
        contextLines.push(`URL:        ${ctx.url}`);
        contextLines.push(`Open tabs:  ${ctx.tabCount}`);
        if (extras.viewport) contextLines.push(`Viewport:   ${extras.viewport}`);
        if (extras.scroll)   contextLines.push(`Scroll:     ${extras.scroll}`);
        if (extras.readyState) contextLines.push(`Ready:      ${extras.readyState}`);
        if (extras.selectionPreview) contextLines.push(`Selection:  ${extras.selectionPreview}`);
      }

      // Indexed snapshot — the agent's "eyes". One CDP eval; tags interactive
      // elements with data-browy-id so click_index/type_index can resolve.
      // Skipped on chrome:// and similar non-DOM tabs.
      let snapshotBlock = '';
      const url = ctx.url || '';
      const isInteractivePage = url && !/^(chrome|edge|brave|about|chrome-extension):/i.test(url);
      if (cdpForCtx && isInteractivePage) {
        try {
          const snap = await ensureSnapshot(cdpForCtx, 0); // always fresh on user turn
          snapshotBlock = `\n<page_snapshot>\n${serializeSnapshot(snap)}\n</page_snapshot>`;
        } catch { /* fail-soft: agent can still call inspect_page */ }
      }

      const recentBlock = this.serializeRecentActions();
      const contextBlock = contextLines.length
        ? `<browser_context>\n${contextLines.join('\n')}\n</browser_context>${snapshotBlock}\n${recentBlock}\n`
        : recentBlock ? `${recentBlock}\n` : '';
      // Put the user's actual text FIRST so the SDK's session-summary (which
      // truncates to ~100 chars) captures the user's intent rather than our
      // injected scaffolding. The model sees the same content either way.
      const prompt = contextBlock
        ? `${userText}\n\n${contextBlock}`
        : userText;

      // ── Stream-based send ────────────────────────────────────────────
      // sendAndWait() has a hard 60s timeout that breaks multi-step tool
      // workflows. Instead we drive the session manually via session.on()
      // and resolve when we see session.idle. This also lets us stream
      // assistant.message_delta chunks to the UI in real time.
      let finalText = '';
      const session = this.copilotSession;

      const completion = new Promise<string>((resolve, reject) => {
        let unsub: (() => void) | null = null;
        // Idle-based safety net: reset on every event. Times out only if the
        // SDK goes silent for 5 minutes (network drop, hung tool, etc.).
        // An actively-working agent — even one running a 30-min multi-step
        // automation — stays alive as long as deltas keep arriving.
        const IDLE_MS = 5 * 60 * 1000;
        let idleTimer: NodeJS.Timeout;
        const teardown = () => { try { unsub?.(); } catch {}; clearTimeout(idleTimer); };
        const armIdle = () => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => { teardown(); reject(new Error('Agent went idle for 5 min with no SDK activity; giving up.')); }, IDLE_MS);
        };
        armIdle();
        unsub = session.on((ev: { type: string; data?: any }) => {
          armIdle();
          try {
            if (ev.type === 'assistant.message_delta') {
              const chunk: string = ev.data?.deltaContent || '';
              if (chunk) {
                finalText += chunk;
                this.emit({ type: 'delta', text: chunk });
              }
            } else if (ev.type === 'assistant.message') {
              const content: string = ev.data?.content || '';
              // Some models deliver the full message without prior deltas;
              // detect that and emit as one delta so the UI streams something.
              if (content && !finalText) {
                finalText = content;
                this.emit({ type: 'delta', text: content });
              } else if (content && content.length > finalText.length) {
                // Reconcile: server's authoritative content > what we streamed
                const tail = content.slice(finalText.length);
                if (tail) this.emit({ type: 'delta', text: tail });
                finalText = content;
              }
              const reasoning: string | undefined = ev.data?.reasoningText;
              if (reasoning) this.emit({ type: 'reasoning', text: reasoning });
            } else if (ev.type === 'session.idle') {
              teardown();
              resolve(finalText);
            } else if (ev.type === 'session.error' || ev.type === 'error') {
              teardown();
              reject(new Error(ev.data?.message || ev.data?.error || 'session error'));
            }
          } catch (e) { teardown(); reject(e as Error); }
        });
      });

      await session.send({ prompt });
      const text = await completion;
      const dur = Date.now() - t0;

      this.emit({ type: 'activity', event: 'llm_call_end', durationMs: dur });
      this.emit({ type: 'status', status: 'idle' });

      return { text: text || 'No response', toolCalls: [] };
    } catch (err) {
      const errMsg = `${err instanceof Error ? err.message : String(err)}`;
      this.emit({ type: 'status', status: 'error', detail: errMsg });
      return { text: `Error: ${errMsg}`, toolCalls: [] };
    }
  }

  /** Public: read the current focused-tab info (for UI polling). */
  async getTabContext(): Promise<{ url: string; title: string; brand: string; tabCount: number }> {
    await this.detectFocusedTab();
    await this.refreshTabInfo();
    return { ...this.currentTabInfo };
  }

  /** Ports that currently have a live CDP connection. Used by the
   *  browser-status broadcaster so the UI knows what's wired. */
  getConnectedPorts(): Set<number> {
    const out = new Set<number>();
    for (const c of this.connections) {
      try { out.add(Number(new URL(c.url).port)); } catch {}
    }
    return out;
  }

  /** Force an immediate rediscovery cycle. Called right after the user asks
   *  Browy to launch a browser, so we don't have to wait for the next 2s tick. */
  async rediscover(): Promise<void> {
    await this.runRediscovery();
  }

  /** All currently-connected browsers with metadata for the control panel. */
  getActiveBrowsers(): import('../types.js').ActiveBrowser[] {
    const out: import('../types.js').ActiveBrowser[] = [];
    for (const c of this.connections) {
      let port = 0;
      try { port = Number(new URL(c.url).port); } catch {}
      const pages = c.browser.contexts().flatMap(ctx => ctx.pages());
      const activeIsHere = this.activeConnection === c && this.activePage && pages.includes(this.activePage);
      let activeUrl: string | undefined;
      let activeTitle: string | undefined;
      if (activeIsHere && this.activePage) {
        activeUrl = this.activePage.url();
        activeTitle = this.currentTabInfo.title;
      }
      out.push({ brand: c.brand, port, tabCount: pages.length, activeUrl, activeTitle });
    }
    return out;
  }

  /** Current Copilot model id. */
  getModel(): string {
    return this.config.model;
  }

  /** Switch the Copilot model in-place when possible (preserving the session
   *  history), otherwise fall back to recreating the session.
   *  The Copilot SDK exposes `session.setModel(id)` since copilot-sdk 0.x; we
   *  call it on the live session so a /model change keeps every prior turn. */
  async setModel(id: string): Promise<void> {
    if (!id || id === this.config.model) return;
    this.config.model = id;
    if (this.copilotSession && typeof this.copilotSession.setModel === 'function') {
      try {
        await this.copilotSession.setModel(id);
        return;
      } catch (e) {
        // Some models reject mid-session (e.g. provider mismatch). Fall through
        // to a full rebuild so the user still gets the model they asked for.
        console.warn(`  ⚠ session.setModel("${id}") failed; rebuilding session:`, (e as Error)?.message || e);
      }
    }
    // No live session, no setModel support, or setModel threw → rebuild.
    await this.clearHistory();
  }

  /** List models advertised by the Copilot SDK. */
  async listModels(): Promise<import('../types.js').ModelOption[]> {
    await this.whenCopilotReady();
    if (!this.copilotClient) return [];
    try {
      const models = await this.copilotClient.listModels();
      return (models || []).map((m: any) => ({
        id: m.id,
        name: m.name || m.id,
        vendor: m.vendor || m.provider,
      }));
    } catch {
      return [];
    }
  }

  /** List Browy chats. We identify our sessions by sessionId prefix (`sp-`
   *  for side panel, `dt-` for DevTools panel) — the SDK's `{ cwd }` filter
   *  doesn't work for us because SessionMetadata.context is only populated
   *  from git, not from our workspace.yaml cwd, so it comes back undefined
   *  and the cwd filter returns nothing. */
  async listChats(): Promise<Array<{ id: string; summary?: string; startTime: number; modifiedTime: number }>> {
    await this.whenCopilotReady();
    if (!this.copilotClient) return [];
    try {
      const sessions = await this.copilotClient.listSessions();
      const total = Array.isArray(sessions) ? sessions.length : 0;
      let matched = 0;
      const out: Array<{ id: string; summary?: string; startTime: number; modifiedTime: number }> = [];
      for (const s of sessions || []) {
        const id = s?.sessionId || '';
        if (!isBrowySessionId(id)) continue;
        if (s?.context?.cwd && s.context.cwd !== BROWSERAGENT_WORKDIR) continue;
        matched++;
        out.push({
          id,
          summary: cleanChatSummary(s.summary),
          startTime: s.startTime instanceof Date ? s.startTime.getTime() : Number(s.startTime) || 0,
          modifiedTime: s.modifiedTime instanceof Date ? s.modifiedTime.getTime() : Number(s.modifiedTime) || 0,
        });
      }
      out.sort((a, b) => b.modifiedTime - a.modifiedTime);
      console.log(`  📜 listChats: SDK returned ${total} sessions; ${matched} match Browy prefix → ${out.length} returned`);
      return out;
    } catch (e: any) {
      console.error('  ❌ listChats failed:', e?.message || e);
      return [];
    }
  }

  /** Read a chat's transcript by SDK session id. If it's the active session
   *  we read from it directly; otherwise we briefly resume a side-handle and
   *  disconnect after reading. Maps SDK SessionEvents → side-panel bubbles. */
  async getChatMessages(id: string): Promise<Array<
    | { role: 'user'; text: string; timestamp?: number }
    | { role: 'assistant'; text: string; timestamp?: number }
    | { role: 'tool'; name: string; ok: boolean; summary?: string; timestamp?: number }
  >> {
    await this.whenCopilotReady();
    if (!this.copilotClient || !id) return [];
    let events: any[] = [];
    if (this.copilotSession && this.browyProtocolSessionId === id) {
      try { events = (await this.copilotSession.getMessages()) || []; } catch { return []; }
    } else {
      let handle: any = null;
      try {
        handle = await this.copilotClient.resumeSession(id, {
          clientName: BROWSERAGENT_CLIENT_NAME,
          workingDirectory: BROWSERAGENT_WORKDIR,
          model: this.config.model,
          onPermissionRequest: approveAll,
        });
        events = (await handle.getMessages()) || [];
      } catch {
        return [];
      } finally {
        if (handle) { try { await handle.disconnect(); } catch {} }
      }
    }
    return mapEventsToMessages(events);
  }

  /** Returns whichever CDP duck-type is currently in play (extension override
   *  or playwright session). Used by per-turn context capture and snapshotting. */
  private getCdpForContext(): { send: (m: string, p?: unknown) => Promise<unknown> } | null {
    try {
      const ctx = this.getBrowserContext();
      return (ctx?.cdp as unknown as { send: (m: string, p?: unknown) => Promise<unknown> }) || null;
    } catch { return null; }
  }

  /** Live, cheap-to-fetch page context surfaced into the per-turn prompt.
   *  Single CDP Runtime.evaluate; never throws. Keeps the model from having
   *  to issue speculative get_page_info just to see scroll/viewport/state. */
  private async captureLiveContext(cdp: { send: (m: string, p?: unknown) => Promise<unknown> } | null): Promise<{
    viewport?: string; scroll?: string; readyState?: string; selectionPreview?: string;
  }> {
    if (!cdp) return {};
    try {
      const resp = await cdp.send('Runtime.evaluate', {
        expression: `JSON.stringify({
          vw: window.innerWidth, vh: window.innerHeight,
          dh: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
          sx: window.scrollX, sy: window.scrollY,
          rs: document.readyState,
          sel: (window.getSelection?.()?.toString() || '').slice(0, 80)
        })`,
        returnByValue: true,
      }) as { result?: { value?: string } };
      const v = JSON.parse(String(resp?.result?.value || '{}'));
      const out: { viewport?: string; scroll?: string; readyState?: string; selectionPreview?: string } = {};
      if (v.vw && v.vh) out.viewport = `${v.vw}×${v.vh}`;
      if (typeof v.sy === 'number' && v.dh) {
        const pct = v.dh > v.vh ? Math.round((v.sy / (v.dh - v.vh)) * 100) : 0;
        out.scroll = `y=${Math.round(v.sy)}/${Math.round(v.dh - v.vh)}px (${pct}%)`;
      }
      if (v.rs) out.readyState = String(v.rs);
      if (v.sel) out.selectionPreview = JSON.stringify(v.sel);
      return out;
    } catch {
      return {};
    }
  }

  /** Record a tool call into the ring buffer so the next chat turn surfaces
   *  a <recent_actions> trace to the LLM. Args & results are aggressively
   *  trimmed to keep token cost negligible. */
  private recordRecentAction(name: string, args: Record<string, unknown>, result: string, ok: boolean, ms: number) {
    let argStr = '';
    try {
      const compact: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args || {})) {
        if (typeof v === 'string') compact[k] = v.length > 60 ? v.slice(0, 57) + '…' : v;
        else if (v && typeof v === 'object') compact[k] = '[obj]';
        else compact[k] = v;
      }
      argStr = JSON.stringify(compact);
      if (argStr.length > 120) argStr = argStr.slice(0, 117) + '…';
    } catch { argStr = '{}'; }
    const r = (result || '').replace(/\s+/g, ' ').trim();
    const trimResult = r.length > 100 ? r.slice(0, 97) + '…' : r;
    this.recentActions.push({ name, args: argStr, result: trimResult, ok, ms });
    if (this.recentActions.length > Agent.RECENT_ACTIONS_LIMIT) {
      this.recentActions.splice(0, this.recentActions.length - Agent.RECENT_ACTIONS_LIMIT);
    }
  }

  private serializeRecentActions(): string {
    if (!this.recentActions.length) return '';
    const lines = this.recentActions.map(a => {
      const tag = a.ok ? 'ok' : 'err';
      return `- ${a.name}(${a.args}) → ${tag} ${a.ms}ms${a.result ? ': ' + a.result : ''}`;
    });
    return `<recent_actions>\n${lines.join('\n')}\n</recent_actions>\n`;
  }

  private async refreshTabInfo() {
    try {
      const page = this.activePage;
      if (!page) return;
      const url = page.url();
      let title = '';
      try { title = await page.title(); } catch {}
      const conn = this.activeConnection || this.connectionForPage(page);
      const brand = conn?.brand || 'Browser';
      // Tab count is across the active browser only — what the user sees in
      // their current browser window's tab bar. Aggregate across all browsers
      // would be confusing ("you have 47 tabs" when only 14 are in this one).
      const tabCount = conn ? conn.browser.contexts().flatMap(c => c.pages()).length : 0;
      this.currentTabInfo = { url, title, brand, tabCount };
      // NOTE: cli.ts owns the focused_tab broadcast and de-dupes by content,
      // so we deliberately don't emit here — would just produce duplicates.
    } catch { /* ignore */ }
  }

  /** Abort the current in-flight chat request without destroying the session. */
  async abort() {
    if (this.copilotSession) {
      try { await this.copilotSession.abort(); } catch {}
    }
    this.emit({ type: 'status', status: 'idle' });
  }

  async clearHistory() {
    // Detach reference SYNCHRONOUSLY so any chat() that arrives during
    // cleanup will spin up a fresh session via ensureSession().
    const old = this.copilotSession;
    this.copilotSession = null;
    this.recentActions = [];
    if (old) {
      const id = old.sessionId;
      try { await old.abort(); } catch {}
      try { await old.disconnect(); } catch {}
      try { await this.copilotClient.deleteSession(id); } catch {}
    }
    this.emit({ type: 'status', status: 'idle' });
  }

  private getBrowserContext(): BrowserToolContext {
    if (this.contextOverride) return this.contextOverride;
    // All tools operate on whichever browser owns the active page, so
    // navigate/screenshot/etc. always target what the user is looking at.
    const conn = this.activeConnection || this.connections[0];
    return {
      cdp: this.cdp!,
      browser: conn?.browser!,
      getPages: () => conn ? conn.browser.contexts().flatMap(c => c.pages()) : [],
      setActivePage: async (page: Page) => {
        await this.setActivePageInternal(page);
      },
    };
  }

  /** Phase E: extension-mode override. When set, getBrowserContext returns
   *  this directly, and connect() short-circuits without launching playwright.
   *  Pass null to clear. */
  private contextOverride: BrowserToolContext | null = null;
  setBrowserContextOverride(ctx: BrowserToolContext | null) {
    this.contextOverride = ctx;
  }

  private emit(msg: WSMessage) {
    this.onActivity(msg);
  }

  async disconnect() {
    // Detach our SDK session handle WITHOUT deleting it on disk so the next
    // host start can resume it. Clear chat (history.clear) is the only path
    // that intentionally deletes.
    if (this.copilotSession) {
      const old = this.copilotSession;
      this.copilotSession = null;
      try { await old.abort(); } catch {}
      try { await old.disconnect(); } catch {}
    }
    if (this.copilotClient) {
      try { await this.copilotClient.stop(); } catch {}
    }
    if (this.rediscoverTimer) { clearInterval(this.rediscoverTimer); this.rediscoverTimer = null; }
    for (const conn of this.connections) {
      conn.browser.close().catch(() => {});
    }
    this.connections = [];
    this.activeConnection = null;
    shutdownForeground();
  }
}

/** Maps Copilot SDK SessionEvents → the slim role/text shape the side panel
 *  knows how to render. Skips ephemeral events, sub-agent chatter, and
 *  intermediate streaming deltas (we keep only the final assistant.message). */
function mapEventsToMessages(events: any[]): Array<
  | { role: 'user'; text: string; timestamp?: number }
  | { role: 'assistant'; text: string; timestamp?: number }
  | { role: 'tool'; name: string; ok: boolean; summary?: string; timestamp?: number }
> {
  const out: Array<any> = [];
  for (const ev of events || []) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.ephemeral) continue;
    if (ev.agentId) continue; // sub-agent events — skip for top-level transcript
    const ts = ev.timestamp ? (ev.timestamp instanceof Date ? ev.timestamp.getTime() : Number(ev.timestamp) || undefined) : undefined;
    switch (ev.type) {
      case 'user.message': {
        const text = ev.data?.content;
        if (typeof text === 'string' && text.trim()) {
          // Strip our injected <browser_context>/<page_snapshot>/<recent_actions>
          // wrappers so the user sees only what they typed.
          const stripped = text.replace(/<(browser_context|page_snapshot|recent_actions)>[\s\S]*?<\/\1>\s*/g, '').trim();
          if (stripped) out.push({ role: 'user', text: stripped, timestamp: ts });
        }
        break;
      }
      case 'assistant.message': {
        const text = ev.data?.content;
        if (typeof text === 'string' && text.trim()) {
          out.push({ role: 'assistant', text, timestamp: ts });
        }
        break;
      }
      case 'tool.execution_complete': {
        const name = ev.data?.toolName || ev.data?.name || 'tool';
        const status = ev.data?.status || (ev.data?.error ? 'error' : 'ok');
        const ok = status !== 'error' && status !== 'failed';
        const summary = typeof ev.data?.result === 'string'
          ? ev.data.result.slice(0, 120)
          : (ev.data?.error ? String(ev.data.error).slice(0, 120) : undefined);
        out.push({ role: 'tool', name, ok, summary, timestamp: ts });
        break;
      }
    }
  }
  return out;
}
