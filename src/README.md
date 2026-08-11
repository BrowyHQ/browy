# Browy — Native Host (TypeScript)

The Node process that the extension talks to over Chrome's native-messaging bridge. It hosts the Copilot SDK session, drives the page through CDP (`chrome.debugger`), runs the tool registry, and persists chats.

If you want to **use** Browy, see the [main README](../README.md). This document is for **hacking on** the native host.

---

## Architecture

```
┌──────────── extension (chromium) ────────────┐
│  sidepanel.js    panel.js    options.js      │
│         │           │            │           │
│         └───────────┼────────────┘           │
│                     ▼                        │
│             background.js  ← single port     │
│                     │                        │
│         chrome.runtime.connectNative         │
│              ("com.browy.host")              │
└─────────────────────┬────────────────────────┘
                      │  stdio (4-byte LE length + JSON)
                      ▼
┌─────────────── native-host.js ────────────────┐
│  src/transports/native-messaging.ts           │
│  ─────────────────────────────────────────    │
│            ┌── Agent (src/agent/loop.ts) ──┐  │
│            │                                │ │
│            │  copilotClient ─ @github/      │ │
│            │      copilot-sdk session       │ │
│            │                                │ │
│            │  tools ─── 40+ CDP-backed tools│ │
│            │       click_index, type_index, │ │
│            │       extract_form, fill_form, │ │
│            │       evaluate_js, navigate,   │ │
│            │       get_console_logs, ...    │ │
│            │                                │ │
│            │  page-snapshot.ts ─ indexed    │ │
│            │      [N]<tag>text</tag> view   │ │
│            │      of every interactive elt  │ │
│            └────────────────────────────────┘ │
│                                               │
│  Chrome via chrome.debugger ←── CDP ──┐       │
│                                       ▼       │
│                              extension-context│
│                              (tab focus,      │
│                               viewport, ...)  │
└───────────────────────────────────────────────┘
```

### Source layout

```
src/
├── native-host.ts         ← entrypoint when run as native messaging host
├── cli/
│   └── cli-bin.ts         ← entrypoint when run as standalone CLI (`npm start`)
├── agent/
│   ├── loop.ts            ← Agent class: SDK session, tool registry, prompt assembly
│   ├── browsers.ts        ← detect Chrome/Edge/Brave installations + active windows
│   ├── data-root.ts       ← ~/.browy/data sandbox for save_file/note_set tools
│   ├── extension-context.ts ← per-port browser context cached for tools
│   ├── foreground.ts      ← OS focus detection (which Chromium window is on top)
│   ├── llm.ts             ← optional standalone LLM bridge (legacy)
│   ├── page-snapshot.ts   ← indexed [N] page snapshot (the model's "eyes")
│   └── runner.ts          ← per-port lifecycle, message routing
└── transports/
    ├── native-messaging.ts ← stdio length-prefixed JSON framer
    └── ws.ts               ← optional WebSocket transport (for CLI/dev)
```

---

## The tool taxonomy

Every tool returns JSON. Some return signals (`urlChanged`, `titleChanged`) that let the agent verify side effects without an extra inspect call.

### Indexed interaction (preferred)
- `inspect_page` — snapshot the page, return indexed list `[N]<tag attrs>text</tag>`
- `click_index(N)` — click element [N], auto-scrolls into view
- `type_index(N, text, clear?)` — focus + clear + type
- `select_index(N, value)` — set native `<select>` value
- `clear_index(N)` — empty an input
- `press_key(key)`, `press_keys(keys)` — keyboard events / combos
- `scroll(direction, amount?)` — scroll the page

### Forms
- `extract_form(N?)` — read schema (label, type, value, options, required) for a form or all forms
- `fill_form(fields)` — fill many fields in **one** call (auto-detects input/select/checkbox/radio)
- `check_index`, `set_radio_index`, `upload_index`, `submit_form`

### Page state
- `extract_text`, `get_page_info`, `get_page_html`, `accessibility_snapshot`, `screenshot`

### Tabs
- `list_tabs`, `switch_tab`, `new_tab`, `close_tab`, `navigate`

### Power
- `evaluate_js` — arbitrary JS in the page (top-level await OK)
- `run_script` — Node.js on the user's machine (file I/O, shell)

### DevTools
- `get_console_logs`, `get_network_requests`, `get_cookies`, `get_storage`, `replay_request`

### Files
- `download_file`, `upload_file`, `pdf_export`

### Persistent disk + memory (sandboxed at `~/.browy/data/`)
- `save_file`, `read_file`, `list_files`, `delete_file`
- `note_set`, `note_get`, `note_list`, `note_delete` — survives across chats

### Human-in-the-loop
- `focus_index` — real mouse-driven focus that triggers Chrome's password autofill
- `await_user(message)` — pause and ask the human to do something themselves

Full tool reference + JSON schemas: read [`src/agent/loop.ts`](agent/loop.ts) — search for `tools = [`.

---

## Developing locally

### Prereqs
- Node ≥ 20
- A Chromium browser (Chrome, Edge, or Brave)
- A GitHub Copilot subscription

### One-time setup

```bash
git clone https://github.com/BrowyHQ/browy
cd browy
npm install
npm run build
```

Then **install the dev native-messaging manifest** so Chrome can find your local build:

**Windows (PowerShell)**:
```powershell
$dist = "$PWD\dist"
$manifest = @{
  name = "com.browy.host"
  description = "Browy native host (dev)"
  path = "$PWD\dist\native-host.js"
  type = "stdio"
  allowed_origins = @("chrome-extension://YOUR_EXTENSION_ID/")
} | ConvertTo-Json
$manifest | Out-File "$env:LOCALAPPDATA\Google\Chrome\User Data\NativeMessagingHosts\com.browy.host.json" -Encoding utf8
```

**macOS**:
```bash
mkdir -p ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts
cat > ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.browy.host.json <<EOF
{
  "name": "com.browy.host",
  "description": "Browy native host (dev)",
  "path": "$(pwd)/dist/native-host.js",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://YOUR_EXTENSION_ID/"]
}
EOF
```

Get `YOUR_EXTENSION_ID` from `chrome://extensions` after loading `extension/` unpacked.

> On Linux & macOS make sure `dist/native-host.js` has a shebang and is `chmod +x`. The build does this automatically.

### The dev loop

```bash
npm run build           # esbuild bundle → dist/
# or watch mode (faster iterations):
node build.mjs --watch
```

Then in Chrome: open the side panel, send a message, the host respawns automatically with your new code (Chrome lazy-spawns native hosts per port).

If your changes don't seem to take effect, kill the running host:
```powershell
Get-Process node | Where-Object { $_.Path -like "*Browy*" -or $_.Path -like "*BrowserAgentCLI*" } | Stop-Process -Force
```
Next message respawns with fresh code.

### Hot-patch into an installed build

If you're testing against an *installed* Browy (not your dev manifest) and want to iterate without re-running the installer:

```powershell
$dst = "$env:LOCALAPPDATA\Browy\app\dist"
Copy-Item dist\native-host.js $dst -Force
Copy-Item dist\cli-bin.js     $dst -Force
Get-Process node | Where-Object { $_.Path -like "*Browy*" } | Stop-Process -Force
```
Chrome respawns the host on the next message with your patched code.

---

## Standalone CLI

Browy can also run as a regular CLI without an extension — useful for testing tools and scripting agents over WebSocket.

```bash
npm start
# or after install:
browy
```

This launches the agent on a local WS port, prints connection info, and accepts an optional driving extension/Playwright client. See `src/cli/` for entrypoint.

---

## Session storage

```
~/.browseragent/
├── sessions/             ← Copilot SDK session files (per chat)
└── (titles.json — was reverted, no longer used)

~/.browy/data/            ← Sandboxed disk for save_file / note_set tools
```

- Chat history is owned by the SDK (one YAML per session).
- We **never** read or write into `~/.copilot/` (the user's Copilot CLI's sessions). The Browy session id is namespaced (`browy-<uuid>`) so `listSessions()` filtering by id is foolproof.

---

## Debugging

### See what the agent is doing in real time

The side panel collapses tool steps by default. Click the *N tools* summary to expand. The DevTools panel shows them inline.

### See native-host stderr

Native-messaging hosts have stdout reserved for the framed protocol — anything written to stderr ends up in:

- **Windows**: `%USERPROFILE%\.browseragent\native-host.log`
- **mac/linux**: `~/.browseragent/native-host.log`

### Inspect the SDK session events

Set `BROWY_DEBUG=1` before launching to log every SDK event the host sees:
```powershell
$env:BROWY_DEBUG = "1"; npm start
```

### Reset everything
```bash
rm -rf ~/.browseragent ~/.browy
```
Next launch starts fresh (you'll need to sign in again).

---

## Building for distribution

Cross-platform tarballs/installers via the staging scripts:

```bash
npm run dist:win        # Windows zip + bundled node.exe
npm run dist:win-nsis   # NSIS installer .exe
npm run dist:mac-arm    # macOS Apple Silicon tarball
npm run dist:mac-x64    # macOS Intel tarball
npm run dist:linux      # Linux x64 tarball
npm run dist:linux-arm  # Linux arm64 tarball
npm run pack:extension  # Just the extension/ folder as .zip for the Chrome Web Store
```

Each produces an artifact in `release/`. The Windows installer registers the native-messaging manifest under `HKCU` (no admin required).

---

## Contributing

See [`../CONTRIBUTING.md`](../CONTRIBUTING.md).

