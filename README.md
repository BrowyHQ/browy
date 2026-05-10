# Browy — the AI agent that lives in your browser

> Open-source Chrome extension. Drive your real tabs through chat. Side panel for day-to-day work, DevTools REPL for the power users.

📖 **Documentation:** [browyhq.github.io/docs](https://browyhq.github.io/docs/) — install, first chat, tools reference, DevTools panel, architecture, FAQ.

**Think Claude Code or Aider, but in your browser.** Browy is the AI agent that lives in your browser — a Chromium extension (Chrome / Edge / Brave) backed by a small Node native-messaging host that drives the page through the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) via `chrome.debugger`. It works against your **real** profile — your cookies, your sessions, your logins — so most "log in to do X" tasks just work. An open-source alternative to Browser-Use and Skyvern.

There are two surfaces you can talk to Browy from:

| Surface | When to use it |
|---|---|
| **[Side Panel — Chat](extension/README.md#chat--side-panel)** | Day-to-day tab automation, scraping, form filling, multi-tab tasks. Open with the toolbar icon or the keyboard shortcut. |
| **[DevTools Panel — Console-style CLI](extension/README.md#devtools-panel--console-cli)** | Power-user REPL that lives next to the inspector. Slash commands, network/console taps, evaluate-in-page snippets. |

---

## Quick install

**Windows** (recommended for first install — bundles Node):
```powershell
irm https://github.com/BrowyHQ/browy/releases/latest/download/install.ps1 | iex
```

**macOS / Linux**:
```bash
curl -fsSL https://github.com/BrowyHQ/browy/releases/latest/download/install.sh | bash
```

After install, load `extension/` as an unpacked extension at `chrome://extensions` (Developer Mode → Load unpacked → pick the folder the installer printed). Pin the toolbar icon, click it to open the side panel.

Detailed install + troubleshooting → [extension/README.md](extension/README.md#installation)

---

## Sections

- 🟢 **[Chat — Side Panel](extension/README.md#chat--side-panel)** — full-featured chat UI, retro-pixel mascot, tab-aware
  - [Send a message → drive the active tab](extension/README.md#1-basic-flow-talk-to-your-tabs)
  - [Multi-tab workflows](extension/README.md#2-multi-tab-tasks-it-follows-your-focus)
  - [Forms: extract → fill → submit](extension/README.md#3-form-filling-the-three-step-pattern)
  - [Resume a previous chat](extension/README.md#4-resuming-old-chats)
  - [Login walls + `await_user`](extension/README.md#5-login-walls-and-await_user)

- 🖥️ **[DevTools Panel — CLI](extension/README.md#devtools-panel--console-cli)** — console-styled REPL for power users
  - [Slash commands](extension/README.md#slash-commands)
  - [Tap into network + console](extension/README.md#network--console-taps)
  - [`evaluate_js` from the prompt](extension/README.md#inline-evaluate_js)
  - [Switching models](extension/README.md#switching-models)

- 🔧 **[Architecture & developing locally](src/README.md)** — extension ↔ port ↔ native host ↔ Copilot SDK + CDP
- 📖 **[Documentation site](https://browyhq.github.io/docs/)** — install, first chat, tools reference, DevTools CLI, privacy

---

## Worked examples (real tasks Browy handles well)

- **Scrape the YC startup directory by batch** — *"List all Fall 2026 YC companies with their location and one-line pitch"* → see [extension/README.md#example-yc-directory-scrape](extension/README.md#example-yc-directory-scrape)
- **Review a GitHub PR for me** — *"Summarize the changes in this PR and flag anything that looks risky"* → [extension/README.md#example-github-pr-review](extension/README.md#example-github-pr-review)
- **Set up a Gmail filter** — *"Auto-archive everything from no-reply@\*.atlassian.net"* → [extension/README.md#example-gmail-filter](extension/README.md#example-gmail-filter)
- **Fill a sign-up form across multiple tabs** — [extension/README.md#example-multi-tab-signup](extension/README.md#example-multi-tab-signup)

---

## How Browy is different

- **Lives in your real browser.** Not a headless puppet. Your cookies, extensions, history, password manager — Browy uses them. Most "first, log in" steps go away.
- **Indexed page snapshot.** Every turn, Browy gets a numbered list of every visible interactive element (`[12]<button>Submit</button>`). It clicks by index — no flaky CSS selectors, no "find the right XPath" guesswork.
- **DevTools-aware.** Network requests, console logs, cookies, storage — all available as tools. Great for debugging your own apps.
- **Bring your own model.** Pick from any frontier model the agent has access to (Claude, GPT, Gemini, Llama, ...). Switch via `/model` in the DevTools CLI or in Settings.
- **Open source, Apache-2.0.** Audit the host. Audit the extension. Pin a known-good build.

## Browy vs alternatives

| | **Browy** | Browser-Use | Skyvern | Aider |
|---|---|---|---|---|
| Open source | ✅ Apache-2.0 | ✅ | ✅ | ✅ |
| Runs locally | ✅ | ✅ (Python) | ❌ Cloud | ✅ |
| Uses your real browser profile | ✅ | ❌ Fresh sandbox | ❌ Cloud | n/a (terminal) |
| Browser extension UI | ✅ | ❌ | ❌ | ❌ |
| Native DevTools panel | ✅ | ❌ | ❌ | ❌ |
| BYO frontier models | ✅ Claude, GPT, Gemini, Llama | ❌ Per-token API | ❌ Per-task | ❌ Per-token API |
| Headless CLI mode | ✅ `browy run` | ✅ | ✅ | ✅ |

---

## Project layout

```
browy/
├── extension/           ← Chromium extension (sidepanel + devtools panel + options)
│   └── README.md        ← Chat & DevTools CLI feature docs
├── src/                 ← Node native-messaging host (TypeScript)
│   ├── agent/           ← Copilot SDK driver, tools, page snapshot
│   ├── cli/             ← Standalone CLI entrypoint
│   ├── transports/      ← native-messaging + websocket
│   └── README.md        ← Architecture, tools, developing locally
├── scripts/             ← Build, stage, pack helpers
├── installer/           ← NSIS installer + install.ps1 / install.sh
├── packaging/           ← Per-OS native-host manifests
└── docs/screenshots/    ← Images used in READMEs
```

---

## Status

Browy is **v0.1.2** — first public release. Windows, macOS, and Linux all have native-host installers and packaged builds (see [Releases](https://github.com/BrowyHQ/browy/releases)). Expect rough edges around long-running multi-step automations on hostile SPAs (LinkedIn, Notion, Discord). File issues — they help.

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev loop (`npm run build` → hot-patch → `Stop-Process` the host).

## Security

Found a vulnerability? See [SECURITY.md](SECURITY.md). Please **don't** open a public issue.

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

