# Browy

[English](README.md) | [简体中文](README.zh-CN.md)

**The browser agent that runs on the AI subscription you already pay for.** A Chromium extension for Chrome, Edge, and Brave that drives your real, logged-in tabs through chat. Side panel for day-to-day work, DevTools panel CLI for power users. No API key and no second bill: it runs on your existing GitHub Copilot subscription.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-early%20access-blueviolet)](#status)
[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-live-brightgreen)](https://chromewebstore.google.com/detail/iondecjdokngnlkfpipgolgkfegpmjca)
[![Docs](https://img.shields.io/badge/docs-browyhq.github.io-blue)](https://browyhq.github.io/)

<p align="center">
  <img src="docs/screenshots/browy-demo.gif" alt="Browy in action: side panel, DevTools CLI, form filling, network inspection" width="640" />
</p>

> ⚠️ **Early access (v0.1.x).** Browy is in preview. APIs, tools, and on-disk schemas may change between minor releases. Breaking changes are documented in [CHANGELOG.md](CHANGELOG.md).

---

## Table of contents

- [What Browy is](#what-browy-is)
- [Quick install](#quick-install)
- [What gets installed](#what-gets-installed)
- [Two ways to talk to Browy](#two-ways-to-talk-to-browy)
- [Worked examples](#worked-examples)
- [How Browy is different](#how-browy-is-different)
- [Browy vs alternatives](#browy-vs-alternatives)
- [Project layout](#project-layout)
- [Status](#status)
- [Responsible AI](#responsible-ai)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

---

## What Browy is

Browy is a browser AI agent. You install it as a Chromium extension; it adds two UI surfaces (a side panel chat and a DevTools panel CLI) that talk to a small Node native-messaging host running on your machine. The host wraps the [GitHub Copilot SDK](https://www.npmjs.com/package/@github/copilot-sdk), so every model call uses your existing Copilot subscription, no extra API keys.

The agent drives the active tab through the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) via `chrome.debugger`. It reads pages off the accessibility tree (the same tree screen readers use), clicks and types by index, captures network and console activity, and runs JavaScript when the structured tools are not enough.

**Browy is a productivity tool for a single human operator, not a way to run unattended automation against other people's services.** You point it at a tab; it reads and acts on that tab; you see every action stream back into the chat. There is no Browy server in the loop and no inbox that other people can flood by talking to it.

Think Claude Code or Aider, but in your browser. An open-source alternative to Browser-Use and Skyvern.

---

## Quick install

### Step 1: install the extension

[**Add Browy from the Chrome Web Store**](https://chromewebstore.google.com/detail/iondecjdokngnlkfpipgolgkfegpmjca) (one click). The same listing covers Chrome, Edge, and Brave.

**✓ Validate:** Pin the toolbar icon. Click it. The side panel should open and show a "host disconnected" banner. That is expected until Step 2.

### Step 2: install the native host

**Windows** (bundles Node, ~130 MB):

```powershell
irm https://github.com/BrowyHQ/browy/releases/latest/download/install.ps1 | iex
```

**macOS / Linux**:

```bash
curl -fsSL https://github.com/BrowyHQ/browy/releases/latest/download/install.sh | bash
```

**✓ Validate:** Re-open the side panel. The host banner should be gone. If not, run `browy --version` (Windows: `& "$env:LOCALAPPDATA\Browy\app\browy.exe" --version`) to confirm the binary is on disk.

### Step 3: sign in to Copilot

Click **Sign in to GitHub Copilot** in the side panel. A terminal window opens with a device-flow link. Paste the code in your browser, authorise, the terminal closes itself.

**✓ Validate:** Send "what is the headline of this page" against any tab. You should see a `snapshot` tool call followed by a streamed reply.

That's it. Try [your first chat](https://browyhq.github.io/first-chat/) for five concrete examples.

> **From mainland China?** GitHub Releases and `api.githubcopilot.com` are both reachable but slow. See the [China setup guide](https://browyhq.github.io/china-setup/) for the `BROWY_RELEASE_URL` mirror pattern and a latency note.

---

## What gets installed

The installer is conservative; everything below survives reboots and updates in place.

| Path | Contents |
|---|---|
| `%LOCALAPPDATA%\Browy\app\` (Windows) | Native messaging host binary, bundled Node, helpers |
| `~/.browy/app/` (macOS / Linux) | Same |
| `~/.browy/data/files/` | Sandboxed scratch disk for the `save_file` / `read_file` agent tools |
| `~/.browy/data/notes.json` | Persistent key-value memory across chats |
| `~/.browseragent/native-host.log` | Single rotating 5 MB diagnostic log (one rotated copy kept as `.1`) |
| Native messaging manifest | Registered with Chrome, Edge, and Brave so the extension can talk to the host |
| Chrome extension storage | Chat history, model selection, theme; never leaves the local profile |

Nothing in this list leaves your machine. Page content the agent reads goes to GitHub Copilot, exactly as if you ran `gh copilot` from a terminal. Full data-handling summary at [browyhq.github.io/privacy/](https://browyhq.github.io/privacy/).

---

## Two ways to talk to Browy

| Surface | When to use it |
|---|---|
| **[Side Panel chat](extension/README.md#chat-side-panel)** | Day-to-day tab automation, scraping, form filling, multi-tab tasks. Open with the toolbar icon or the keyboard shortcut. Persistent history per browser profile. |
| **[DevTools panel CLI](extension/README.md#devtools-panel-console-cli)** | Power-user REPL next to the inspector. Slash commands (`/help`, `/model`, `/clear`, `/login`, `/js`), keyboard shortcuts, per-tab agent sessions. |

Both surfaces share session state, model selection, and chat history. The DevTools CLI exists for keyboard-driven workflows; the side panel exists for everything else.

---

## Worked examples

Real tasks Browy handles well. Each links to the full transcript and a screenshot.

- **[Scrape the YC startup directory by batch](extension/README.md#example-yc-directory-scrape)**: *"List all Fall 2026 YC companies with their location and one-line pitch."*
- **[Review a GitHub PR](extension/README.md#example-github-pr-review)**: *"Summarise the changes in this PR and flag anything that looks risky."*
- **[Set up a Gmail filter](extension/README.md#example-gmail-filter)**: *"Auto-archive everything from no-reply@\*.atlassian.net."*
- **[Fill a sign-up form across multiple tabs](extension/README.md#example-multi-tab-signup)**: multi-step, multi-tab, stops before submit.

For a guided walkthrough with screenshots, see [Your first chat](https://browyhq.github.io/first-chat/).

---

## How Browy is different

- **Runs against your real browser profile.** Not a headless puppet. Your cookies, your extensions, your password manager, your existing logins. Most "first, log in to X" steps disappear.
- **Indexed accessibility-tree snapshot.** Every turn, Browy gives the model a numbered list of every visible interactive element (`[12]<button>Submit</button>`). The agent clicks by index. No brittle CSS selectors, no XPath guesswork.
- **DevTools-aware.** Network requests, console logs, cookies, storage, and `evaluate_js` are first-class tools. Great for debugging the app you are building, not just operating apps that are already running.
- **Bring your own model.** Pick from any frontier model your Copilot subscription exposes (Claude, GPT, Gemini, Llama, Codex). Switch with `/model` in the DevTools CLI or in Settings.
- **One subscription, no surprise bills.** Browy is built on the GitHub Copilot SDK. There is no Browy meter. Whatever Copilot costs you, that is what Browy costs you.
- **Open source, Apache-2.0.** Audit the host. Audit the extension. Pin a known-good build. The agent loop is in one file ([`src/agent/loop.ts`](src/agent/loop.ts)) and the tool registry is in another ([`src/agent/tools/browser.ts`](src/agent/tools/browser.ts)).

---

## Browy vs alternatives

| | **Browy** | [Browser-Use](https://github.com/browser-use/browser-use) | [Skyvern](https://github.com/Skyvern-AI/skyvern) | [Aider](https://github.com/Aider-AI/aider) |
|---|---|---|---|---|
| Open source | ✅ Apache-2.0 | ✅ MIT | ✅ AGPL | ✅ Apache-2.0 |
| Runs locally | ✅ | ✅ (Python) | ❌ Cloud | ✅ |
| Uses your real browser profile | ✅ | ❌ Fresh sandbox | ❌ Cloud | n/a (terminal) |
| Browser extension UI | ✅ Side panel + DevTools | ❌ | ❌ | ❌ |
| Native DevTools panel | ✅ | ❌ | ❌ | ❌ |
| Frontier-model choice | ✅ Claude, GPT, Gemini, Llama (via Copilot) | Per-token API | Per-task | Per-token API |
| Headless CLI mode | ✅ `browy run` | ✅ | ✅ | ✅ |
| Billing model | Your existing Copilot subscription | Per-token API | Per-task | Per-token API |

---

## Project layout

```
browy/
├── extension/             ← Chromium extension (side panel + DevTools panel + options)
│   └── README.md          ← Side panel and DevTools CLI feature docs
├── src/                   ← Node native-messaging host (TypeScript)
│   ├── agent/             ← Copilot SDK driver, tool registry, page snapshot
│   ├── cli/               ← Standalone CLI entry point (`browy run`)
│   ├── transports/        ← Native messaging and WebSocket framing
│   └── README.md          ← Architecture and developing locally
├── scripts/               ← Build, stage, pack helpers
├── installer/             ← NSIS installer plus install.ps1 / install.sh
├── packaging/             ← Per-OS native-messaging-host manifests
├── tests/                 ← Vitest suite (page-snapshot, redaction, agent-loop smoke)
└── docs/                  ← Screenshots used in READMEs; site lives at browyhq.github.io
```

---

## Status

Browy is **v0.1.x**, early access. The Chrome Web Store listing is live for Chrome, Edge, and Brave on Windows, macOS, and Linux. Native-host installers ship from [GitHub Releases](https://github.com/BrowyHQ/browy/releases).

Known rough edges:

- Long-running multi-step automations on hostile single-page apps (LinkedIn, Notion, Discord, Figma) need better wait and retry strategies. File issues with reproductions.
- Translations beyond Simplified Chinese have not started.
- The DevTools CLI is keyboard-only; mouse selection in the REPL is still rough.

The roadmap and current open work live on the [GitHub project board](https://github.com/orgs/BrowyHQ/projects) and in the [docs roadmap page](https://browyhq.github.io/roadmap/).

---

## Responsible AI

Browy amplifies a human operator. It does not replace the operator.

- **You see every action.** Tool calls render inline in the side panel as they happen. Browy never executes a tool you cannot watch.
- **Host-touching tools are off by default.** Shell, filesystem, and `web_fetch` require an explicit Settings toggle, one tool at a time.
- **No background activity.** The agent only acts when you send a message. No polling, no scheduled runs, no off-screen automation.
- **Page content goes to GitHub Copilot.** Same path as `gh copilot` in a terminal. Governed by your Copilot subscription terms.
- **No Browy server.** The maintainer cannot read your chats or your page content. Telemetry is not collected.
- **Chrome shows its standard debugger banner whenever the agent is driving.** You always know when Browy is attached.

Detailed security and threat-model notes at [browyhq.github.io/security/](https://browyhq.github.io/security/).

---

## Contributing

PRs welcome. The dev loop is small and the codebase is intentionally readable.

- [CONTRIBUTING.md](CONTRIBUTING.md): setup, dev loop, style, PR process
- [Architecture](src/README.md): extension ↔ port ↔ native host ↔ Copilot SDK
- [Good first issues](https://github.com/BrowyHQ/browy/labels/good%20first%20issue)
- [Discussions](https://github.com/BrowyHQ/browy/discussions): bigger questions and design proposals

Contributors are listed in [CONTRIBUTORS.md](CONTRIBUTORS.md).

---

## Security

Found a vulnerability? Use GitHub's private vulnerability reporting at <https://github.com/BrowyHQ/browy/security/advisories/new>. **Please do not open a public issue.** Full policy in [SECURITY.md](SECURITY.md).

---

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
