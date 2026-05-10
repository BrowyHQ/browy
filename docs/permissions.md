# Browy Extension Permissions

Browy is a browser-automation agent. The side panel runs a chat UI; a
companion native messaging host (a small Node.js process you install
separately) runs the GitHub Copilot CLI as the LLM backend and returns
tool calls that the extension executes against your browser.

This document explains why each permission in `extension/manifest.json`
is required. The same text (lightly edited) is the basis for the Chrome
Web Store listing's permission justification.

## `permissions`

| Permission | Why Browy needs it |
|---|---|
| **`sidePanel`** | Browy's primary UI is the side panel (chat, history, settings). Required to register `sidepanel.html`. |
| **`debugger`** | The agent uses the Chrome DevTools Protocol (via `chrome.debugger.attach`) to take page snapshots, click/type by accessibility index, evaluate JavaScript in the page, capture network/console events, and take screenshots. This is what makes Browy able to "see" and "act on" pages reliably without brittle CSS selectors. **You will see Chrome's standard yellow "Browy started debugging this browser" banner whenever a session is active** — this is non-removable by design. Browy attaches only to tabs you direct it at, and you can detach at any time. |
| **`tabs`** | Read tab titles/URLs to populate the agent's context (`list_tabs`, `switch_tab`), open new tabs (`new_tab`, `navigate`), and route the agent to the correct tab when you ask it to operate on "this page". |
| **`activeTab`** | Used in addition to `tabs` so the side panel can identify the currently focused tab without prompting on every action. |
| **`scripting`** | Inject content scripts when the agent needs to evaluate JS in the page context (e.g. `evaluate_js` tool) or when extracting structured data the snapshot can't express. |
| **`storage`** | Persist chat history, user settings (model, reasoning effort, theme), and last-used tab. All storage is local (`chrome.storage.local`); nothing is uploaded. |
| **`nativeMessaging`** | Connect to the locally-installed Browy native host (`com.browy.host`), which runs the GitHub Copilot CLI on your machine. All LLM traffic flows through your own Copilot subscription, not a Browy server. |
| **`notifications`** | Surface "host disconnected", "sign-in required", and other actionable status messages outside the side panel so you don't miss them while working in another tab. |
| **`downloads`** | Save artifacts the agent produces (e.g. exported scrapes, generated files) to your Downloads folder via `chrome.downloads.download`. |
| **`alarms`** | Periodic keep-alive pings for the background service worker (Chrome aggressively suspends MV3 service workers; alarms keep the native messaging port responsive without spinning a busy loop). |

## `host_permissions`

| Permission | Why Browy needs it |
|---|---|
| **`<all_urls>`** | Browy is a *general-purpose* browser agent — you might ask it to operate on any site you can visit. Restricting host permissions to a fixed list would prevent Browy from working on the next site you ask about. Browy only attaches the debugger to tabs **you explicitly target via the side panel**; it does not crawl, scrape, or interact with pages in the background. |

## Scope

- The agent only acts when you send a message in the side panel; nothing
  runs in the background.
- Page content the agent reads is sent to **GitHub Copilot** (your
  subscription) via the locally-installed Copilot CLI, exactly as if you
  were using `gh copilot` from a terminal.
- The native host runs every model call through a strict tool allowlist
  (`src/agent/loop.ts`, look for `availableTools`). Browser-driving
  tools are on by default and can each be turned off in Settings → Tools;
  host-touching tools (`bash`, `read_file`, `write_file`, `grep`,
  `glob`, `web_fetch`) are off by default and only enabled if you opt
  in per-tool.

## Data handling summary

| Data | Where it goes |
|---|---|
| Page snapshots, screenshots, DOM extracts, console/network logs | Sent to GitHub Copilot via the local CLI to inform the next agent step. |
| Chat history | `chrome.storage.local` on your machine. |
| Settings | `chrome.storage.local`. |
| Native host log | `~/.browy/host/host.log`, rotated at 5 MB. |
