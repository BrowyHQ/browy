# Browy Extension

The Chromium extension surface: what loads inside your browser. There are **two UIs** that talk to the same Node native-messaging host:

1. **Chat (side panel)**: pixel-mascot, day-to-day automation
2. **DevTools panel: console-style CLI**: power-user REPL

Both share session state, model selection, and chat history.

---

## Installation

### Step 1: install the extension

Add Browy from the [Chrome Web Store](https://chromewebstore.google.com/detail/iondecjdokngnlkfpipgolgkfegpmjca) (one click). This works on Chrome, Edge, and Brave.

### Step 2: install the native host

#### Windows
1. Run the PowerShell one-liner from the [main README](../README.md#quick-install) (or the `Browy-Setup-X.Y.Z.exe` installer).
2. The installer drops the host at `%LOCALAPPDATA%\Browy\app\` and registers the native-messaging manifest under `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.browy.host`.

#### macOS / Linux
1. Run the install script from the [main README](../README.md#quick-install). It drops the host at `~/.browy/app/` and writes the native-messaging manifest under `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` (macOS) or `~/.config/google-chrome/NativeMessagingHosts/` (Linux).

### First run: sign in
Browy uses your Copilot subscription. On first message it prompts a device-flow sign-in (one click, copy code, paste in browser, done). After that it just works.

> ![Sign-in screenshot: sidepanel-signin.png](../docs/screenshots/sidepanel-signin.png)

---

## Chat: side panel

The pixel-art mascot is your daily driver. Type → it acts.

> ![Sidepanel hero: sidepanel-hero.png](../docs/screenshots/sidepanel-hero.png)

### What's on screen

| Region | What it is |
|---|---|
| **BROWY badge + status hint** | Top-left mascot, current sub-mode (`// idle`, `// thinking`, `// offline`), connection status |
| **Tab strip** | The browser/profile we're attached to, count of open tabs, the focused tab's title + URL |
| **Message area** | Chat scrollback. User bubbles right, assistant bubbles left, tool steps collapse into a click-to-expand summary |
| **Composer** | Multiline input. Enter to send, Shift+Enter for newline. ⏵ to send, ⏹ to abort an in-flight turn |
| **Header buttons** | ➕ new chat · ☰ chat history · ⚙ settings (opens `options.html` in a new tab) |

### 1. Basic flow: talk to your tabs

> ![Basic flow: sidepanel-basic.png](../docs/screenshots/sidepanel-basic.png)

```
You: what is the headline of this page

Browy:
The headline reads: "The YC Startup Directory" on ycombinator.com/companies.
```

Browy uses your **focused tab** by default. Switch tabs and the next message picks up the new context, and the tab strip updates in real time.

### 2. Multi-tab tasks: it follows your focus

> ![Multi-tab: sidepanel-multitab.png](../docs/screenshots/sidepanel-multitab.png)

```
You: open hacker news and tell me the top 3 stories with comment counts

Browy:
[opens news.ycombinator.com in a new tab, snapshots the front page]
1. "Show HN: ..." — 142 comments
2. "Why X is broken" — 89 comments
3. "..."  — 67 comments
```

Browy decides between **using the active tab** vs **opening a new one** based on the request. If you say *"on this page..."* it stays put.

### 3. Form filling: the three-step pattern

The fastest, most reliable form pattern is `extract_form` → `fill_form` (one bulk call) → `submit_form`. Browy knows this.

```
You: sign me up for the newsletter on this page using my email me@example.com

Browy:
[extract_form] found 3 fields: email (required), name, marketing-opt-in (checkbox)
[fill_form]    filled email=me@example.com, name=(blank), marketing-opt-in=true
[submit_form]  url changed → /thanks. Subscribed.
```

> ![Form filling: sidepanel-forms.png](../docs/screenshots/sidepanel-forms.png)

### 4. Resuming old chats

Click ☰ to open the chat list. Each entry shows the first-message summary + when you last touched it. Click → resumes from the SDK transcript (full history reloaded, indices fresh).

> ![Chat list: sidepanel-chats.png](../docs/screenshots/sidepanel-chats.png)

### 5. Login walls and `await_user`

When Browy hits a sign-in flow it doesn't try to type your password. It pauses and asks you:

```
Browy: I hit a Google sign-in. Please log in in the tab I just opened, then say "go" to continue.
```

You sign in (your password manager helps), reply `go`, Browy resumes. **It never sees your credentials.** Once cookies are set, the next 100 turns just work.

> ![await_user prompt: sidepanel-awaituser.png](../docs/screenshots/sidepanel-awaituser.png)

### Settings (`options.html`)

> ![Settings page: options-page.png](../docs/screenshots/options-page.png)

- **Model**: pick any model your Copilot subscription exposes
- **Sign in / sign out**: re-trigger device-flow auth
- **Install Backend**: visible when the host is offline; one-click copy install commands for Win + Mac/Linux + GitHub Releases link
- **Build version**: for bug reports

---

## DevTools panel: console CLI

Open DevTools (F12 or Cmd-Opt-I) → click the **Browy** tab. You get a console-styled REPL right next to the inspector.

> ![DevTools panel: devtools-hero.png](../docs/screenshots/devtools-hero.png)

### Why use the DevTools panel over the sidepanel?

- You're already in DevTools debugging a page
- You want to mix Browy commands with hand-rolled `evaluate_js` snippets
- You prefer keyboard-only flows
- You want network-tab integration (planned)

### Slash commands

Type `/` in the prompt to see available commands.

| Command | Effect |
|---|---|
| `/new` | Start a fresh chat (same as ➕) |
| `/chats` | List recent chats. Click one to resume. |
| `/model` | Show / switch the active model |
| `/clear` | Clear scrollback (chat history is preserved) |
| `/signin` | Re-run Copilot device-flow auth |
| `/help` | Show all commands |

> ![Slash menu: devtools-slash.png](../docs/screenshots/devtools-slash.png)

### Inline `evaluate_js`

Prefix any line with `> ` to evaluate JS directly in the inspected page (top-level `await` works).

```
> document.querySelectorAll('a').length
142

> await fetch('/api/whoami').then(r => r.json())
{ user: "ritabrata", scopes: ["read", "write"] }
```

This is just a tool call wrapper. Browy still wraps with safety checks and prints the result inline.

### Network + console taps

```
You: show me the last 10 console errors on this page
Browy: [get_console_logs level=error limit=10]
  [3:42:01]  Uncaught TypeError: Cannot read property 'foo' of undefined  at app.js:1234
  [3:42:05]  Failed to load resource: net::ERR_CONNECTION_REFUSED  /api/heartbeat
  ...
```

```
You: what graphql queries does this page send when I scroll?
Browy: [scroll down] → [get_network_requests filter=/graphql]
  POST /graphql  feed.fetchPage(after: "...")  →  200  187ms
  POST /graphql  user.preloadProfiles(ids:[...])  →  200  92ms
```

> ![Network tap: devtools-network.png](../docs/screenshots/devtools-network.png)

### Switching models

```
> /model
Current: claude-sonnet-4.6
Available: claude-opus-4.7, claude-sonnet-4.6, gpt-5.5, gemini-2.5-pro, ...

> /model gpt-5.5
Switched to gpt-5.5.
```

---

## Worked examples

### Example: YC directory scrape

```
You: open https://www.ycombinator.com/companies?batch=Fall%202026 and list every company with location and one-line description as a markdown table

Browy:
[navigate]      → ycombinator.com/companies?batch=Fall%202026
[inspect_page]  3 companies visible, ~12 below the fold
[scroll down]
[inspect_page]  10 more visible
[scroll down]
[inspect_page]  end of list, 15 companies total
[extract_text + structured parse]

| Company   | Location       | Pitch                                        |
|-----------|----------------|----------------------------------------------|
| GodHands  | San Francisco  | Deterministic computer use infra for AI agents |
| ...       | ...            | ...                                          |
```

> ![YC scrape: example-yc.png](../docs/screenshots/example-yc.png)

### Example: GitHub PR review

```
You: review this PR (the one I have open) and flag risky changes

Browy:
[get_page_info] → github.com/owner/repo/pull/123 — "Refactor auth middleware"
[click "Files changed" tab]
[inspect_page] 8 files changed: middleware/auth.ts (+128/-42), tests/...
[extract_text on each diff]

Risky things I found:
1. middleware/auth.ts:67 — the cookie name changed from `session` to `sid`. If any
   other service writes cookies expecting `session`, those sessions will be invalid
   after deploy. Check the Go API repo.
2. The test file removes the "expired-token rejected" case but doesn't replace it.
3. The README still says `cookieName: "session"` in the example.
```

### Example: Gmail filter

```
You: in gmail, set up a filter that auto-archives everything from any
     no-reply@*.atlassian.net address

Browy:
[switch_tab] → mail.google.com (already open)
[click_index] settings gear  → "See all settings" → "Filters and Blocked Addresses" tab
[click "Create a new filter"]
[fill_form] from = "no-reply@*.atlassian.net"
[click "Create filter"]
[check] "Skip the Inbox (Archive it)"
[click "Create filter"]
✓ Done. Filter "Matches: from:(no-reply@*.atlassian.net)" is now archiving.
```

### Example: multi-tab signup

```
You: I'm on the StripeSignup page; my company info is on the about-us tab I have open.
     Use that to fill out the merchant signup.

Browy:
[switch_tab "about us"] → reads company name, address, EIN from the page
[switch_tab "stripe signup"] → extract_form → 17 fields
[fill_form] (one call, all 17 fields populated)
[verifies "Continue" enables]
✓ Form ready for you to review and submit.
```

---

## Architecture (high level)

```
┌──────────────────────┐
│   Chromium browser   │
│ ┌──────────────────┐ │      chrome.runtime.connectNative("com.browy.host")
│ │  sidepanel.js   ─┼─┼──┐
│ │  panel.js       ─┼─┼──┤
│ │  options.js     ─┼─┼──┤
│ └──────────────────┘ │  │
│ ┌──────────────────┐ │  │
│ │  background.js  ←┼─┼──┘  (single port, multiplexed by message id)
│ └──────────────────┘ │       
└──────────────────────┘
              │ stdio / native messaging (length-prefixed JSON)
              ▼
       ┌─────────────────────────────┐
       │  Node native host (dist/)   │
       │  ─────────────────────────  │
       │  • @github/copilot-sdk      │
       │  • CDP via chrome.debugger  │
       │  • tool registry            │
       │  • session storage          │
       └─────────────────────────────┘
```

Detailed deep-dive in [../src/README.md](../src/README.md).

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Side panel says **`offline`** | Native host not installed or not running | Open Settings → install commands shown there |
| `Specified native messaging host not found` in `chrome://extensions` errors | Extension ID mismatch with `allowed_origins` in the host manifest | Re-run installer; it auto-detects your extension ID |
| First message hangs forever | Sign-in not completed | Open Settings → click sign-in, complete device flow |
| `permission denied` after install on macOS | Quarantine bit on the host binary | `xattr -d com.apple.quarantine ~/.browy/app/native-host` |
| Mascot stays grey, never green | `chrome.debugger` permission not granted | Reload extension from `chrome://extensions` |

More: [../src/README.md#debugging](../src/README.md#debugging)
