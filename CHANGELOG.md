# Changelog

All notable changes to Browy will be documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [0.1.6]: chat history is real, and the download is 4× smaller
*Released 2026-08-11*

A deep audit of session handling, the runtime flow, and the macOS experience. Everything below was verified by driving the real native host over Chrome's native-messaging framing, or against the actual released artifacts — not by reading code alone.

### Fixed

- **Deleting a chat now actually deletes it.** The overlay's delete button was a complete no-op in both branches. `history.clear` routed through `setBrowyProtocolSessionId(id)`, which *always* detaches `this.copilotSession` when the id changes, and `clearHistory()` only ever deleted `this.copilotSession?.sessionId` — so by the time it ran there was nothing left to delete and `deleteSession` was never called. Deleting the *current* chat went through `startNewChat()`, which never sends `history.clear` at all. Either way the chat stayed on disk and reappeared on the next refresh, behind a "this cannot be undone" confirmation. There is now a dedicated `chat.delete` message that deletes by id whether or not that chat is loaded, and the UI only removes the row once the host confirms. Verified: 49 → 48 chats, row gone.
- **Browsing your history no longer reorders it.** Opening a past chat forces a `resumeSession` to read its transcript, and that rewrites the session's `modifiedTime` on disk — a chat from 26 April jumped to "now" purely from being clicked. Since the overlay sorts by that field, every chat you previewed teleported to the top. The pre-read timestamp is now pinned, and a real chat turn clears the pin so genuine activity still floats a chat up. Verified: previewing a 63-message chat left it at position 46 of 48 with an unchanged timestamp.
- **`clearHistory()` no longer silently does nothing** when the SDK handle isn't loaded — it falls back to the bound protocol session id.
- **Old chats are actually pruned.** Pruning matched only the `sp-`/`dt-` id prefix while listing matched three signals, so legacy sessions were listed forever and never cleaned up. Both now use the same Browy-specific predicate.
- **The DevTools panel no longer forgets every conversation.** `SESSION_ID` was minted at module scope from `Math.random()`, and the panel reloads every time DevTools is closed and reopened — so each open started an unresumable chat and left an orphan session on disk. The id is now persisted per inspected tab. `/reset` and the reset button mint a fresh id *and* delete the old session.
- **Restored chats show their tool calls again.** The transcript already carried `role: 'tool'` rows; the side panel threw them away, so a reopened chat looked like the agent had never done anything.
- **Chats with no recorded summary** now show when they happened ("Chat from 14 May") instead of a wall of identical "Untitled chat" rows.
- **macOS: "Sign in to GitHub Copilot" no longer runs a command that doesn't exist.** `COPILOT_CLI_PATH` and `BROWY_NODE_PATH` were read but never set anywhere in the repo, so every platform fell through to bare `copilot` on `PATH` — which doesn't exist on a clean machine, since the bundled CLI is never linked into the user's shell. Clicking Sign in opened Terminal and printed `command not found: copilot`. The bundled entry point is now resolved relative to the host, with `PATH` only as a last resort. AppleScript and shell quoting were hardened for paths containing spaces or quotes.
- **macOS: Gatekeeper quarantine is now cleared on install.** Anything downloaded through a browser carries `com.apple.quarantine`, and our bundled `node` is unsigned, so Gatekeeper silently refuses to run it — and because Chrome launches it as a native-messaging host, the user never sees the dialog, only a backend that never connects. `install.sh` now runs `xattr -dr` on the install dir. The troubleshooting entry that pointed at `~/.browy/app/native-host` (a path that never existed) has been corrected.
- **Docs: the native-host log path** was documented three different ways, none matching the code. It is `~/.browseragent/native-host.log` on every platform.

### Changed

- **Platform tarballs are roughly 4× smaller.** Each build shipped a ~106 MB `@github/copilot-<platform>-<arch>` binary that Browy never executes: the Copilot SDK resolves the CLI via `getBundledCliPath()` → `@github/copilot/index.js` and spawns it with `node index.js`. That standalone binary is only used by the package's own `bin` shim when a human types `copilot` in a shell. Worse, npm selects it by the arch of the machine running `npm ci`, and CI stages `darwin-x64` on an arm64 runner — so the Intel-Mac download contained a 106 MB *arm64* binary that nothing would ever run (confirmed in the released v0.1.5 artifact). It is now trimmed during staging; the per-arch `prebuilds/` that `index.js` actually loads are kept. Verified end-to-end against a trimmed build: SDK initialises, 22 models list, chat history loads.
- **Faster, quieter host startup.** The host no longer attempts a playwright CDP connect on boot — three parallel `connectOverCDP` calls (1.5 s timeout each) plus a fallback, all guaranteed to fail since the extension owns the browser via `chrome.debugger`. Success would also have started a 2 s `setInterval` rediscovery loop that kept the event loop hot for the host's whole life.
- **The auth probe no longer blocks the event loop on every `session.start`.** `cmdkey` / `security` results are cached for 30 s and invalidated on an explicit sign-in.
- **No more duplicate `models.list` broadcast** on cold start.
- Removed the stale Homebrew formula: it was pinned to `0.1.0` with literal `REPLACE_WITH_SHA256_AFTER_BUILD` checksums, wasn't referenced by CI or the README, and would have failed for anyone who tried it.


*Released 2026-08-10*

Browy's native host takes a while to cold start — measured 10.8s to first response on a warm machine and 47s under load, because Chrome spawns a fresh host process and the Copilot SDK subprocess has to boot behind it. The UI handled that window badly. This release is entirely about the first 45 seconds.

### Fixed

- **Browy no longer tells working installs to install the backend.** The side panel had only two states, online and offline, so the whole cold-start window rendered the offline copy: a disabled input reading *"offline — install the browy backend to chat"*. Users with a perfectly good install were told it was missing, every single cold start. There is now a distinct `booting` state with its own copy ("starting browy backend — you can start typing…") and no install CTA.
- **You can now type while the backend starts.** The queue that holds a chat send until `session.ready` (`wsShim` → `pendingHostMsgs` → `flushPendingHostMsgs`) was unreachable dead code: the input was disabled until `__host_ready`, and `session.ready` lands ~16ms later, so the queue never fired. The input and send button are now live during boot, sends are queued, and a banner explains the message will go automatically. This reclaims the entire cold-start window.
- **"No past chats yet" no longer lies about your history.** The chats overlay used a 4s timeout on `chat.list` that resolved to an empty array — visually identical to genuinely having no chats. The host actually needs 7.7s–40s after `session.ready` before it can answer. This was the root cause of the "all my chats are gone" reports. The overlay now distinguishes four states — connecting, loading, timed out (with retry), and genuinely empty — and never claims emptiness it hasn't confirmed.

### Added

- **`sdk.ready` protocol message.** `session.ready` only means the host process is answering; the Copilot SDK behind it is still booting, and until it lands `chat.list` and `models.list` both legitimately return nothing. The host now broadcasts `sdk.ready` when the SDK is actually usable, and latches it so a panel attaching later still learns about it via `pushInitialState`. The chats overlay re-renders on it.
- **`npm run test:unit`** — a dependency-free regression test (`tests/sidepanel-boot-state.mjs`) that extracts `setControlsState` from the panel source and asserts the boot-state contract, so the "install the backend" copy can never reappear during boot.

### Changed

- `chat.list` requests are de-duplicated while one is in flight, and the result is cached so typing in the chats search box filters locally instead of re-scanning every session on disk per keystroke.


*Released 2026-05-25*

### Fixed

- **install.ps1 no longer fails silently on PowerShell 7.** The file shipped with a UTF-8 BOM, which PS7's `iex` parses as an unrecognised command name. The error fired before `$ErrorActionPreference='Stop'` was set in the script body, so it was non-fatal and silent (depending on the host), and the user saw a blank cursor. PS5.1 silently swallows the BOM so this never reproduced on legacy hosts. The BOM is now stripped, and a `.gitattributes` rule prevents editors from re-adding it.
- **Side-panel "Install →" link** now opens the install guide page instead of triggering a `.ps1` download. Double-clicked downloaded `.ps1` files silently exit on most Windows machines because of Mark-of-the-Web and execution policy. The guide page has the `irm ... | iex` one-liner that actually works.
- **Stale-host detection.** The side panel now distinguishes "backend not installed" (`__host_missing`) from "backend installed but does not trust this extension" (`__host_stale`). The second case happens when an older backend (pre-0.1.3) was installed before the user switched to the Chrome Web Store extension. The CTA now says "Upgrade →" instead of "Install →" in that case, which routes to the same one-liner that overwrites the manifest with the right `allowed_origins`.
- **DevTools CLI** surfaces the same two error types instead of a generic "host disconnected."
- **Chats overlay now shows the user's full Browy history**, including older sessions whose ID does not start with `sp-` / `dt-`. The filter now treats a session as Browy if its ID matches the new scheme, OR its working directory is `~/.browseragent/sessions`, OR its summary contains a `<browser_context>` block. Older installs that pre-date the `sp-` / `dt-` ID scheme silently disappeared from the chats picker even though they were still on disk; they are now visible again.
- **Chats overlay loading state.** When the backend is still starting up, the chats overlay now shows "connecting..." instead of "no past chats yet". On `session.ready` the overlay re-renders so the SDK-backed history pops in without the user reopening.

### Upgrading from 0.1.2 or earlier

If you installed the backend with a version before 0.1.3 and then later installed the extension from the Chrome Web Store, your side panel will say "Backend installed but does not trust this extension." Re-run the installer (`irm https://github.com/BrowyHQ/browy/releases/latest/download/install.ps1 | iex` on Windows, `curl -fsSL https://github.com/BrowyHQ/browy/releases/latest/download/install.sh | bash` on macOS/Linux). The 0.1.3+ installer writes both the dev and Chrome Web Store extension IDs into `allowed_origins`, so the same machine can run either install path.

## [0.1.2]: devtools REPL + tool toggles + headless CLI
*Released 2026-05-10*

### Added
- **`/js` REPL** in the DevTools panel, toggle a JavaScript REPL that
  evaluates each input line against the inspected page via the DevTools
  runtime. Prompt glyph flips to `js>` while active. No model call.
- **Tool toggles** in extension Settings, disable any built-in browser
  tool (e.g. `evaluate_js` for paranoid mode, `download_file`, etc.).
  Disabled tools are stripped from the SDK's allowlist AND from the tool
  definitions sent to the model, so the agent never sees they exist.
  Persisted in `chrome.storage.local.settings.tools`; forwarded on every
  `session.start` so multiple panels and reloads converge on the same
  preferences.
- **Host SDK tool opt-in**, `read_file`, `write_file`, `bash`, `grep`,
  `glob`, `web_fetch` are off by default and can be enabled per-tool from
  Settings. Final gate enforced server-side in `src/agent/loop.ts`.
- **`browy run`**, headless terminal agent (no browser required) backed
  by the Copilot SDK's full default toolset (`read_file`, `write_file`,
  `bash`, `web_fetch`, …) scoped to your current directory.
  - `browy run "<task>"`, one-shot, prints reply, exits
  - `browy run`, interactive REPL
  - `browy run --resume <id>` / `--list` / `--model <id>` / `--cwd <path>`
  - Sessions stored under `~/.browy/cli-sessions/`, isolated from both
    the browser-coupled Browy sessions and the user's own `copilot` CLI.

### Removed
- Automatic secret-redaction filter for console/network/log surfaces.
  Browy now passes URLs, headers, and console text through unchanged.
  You, not Browy, decide what to share with the agent. This restores
  full power-user workflows like pasting API keys into chat to test
  backends, inspecting `Authorization` headers, and reading raw OAuth
  redirect URLs from the network log.

## [0.1.1]: fixes
*Released 2026-05-09*

### Added
- CLI install (`install.ps1` / `install.sh`) is now the primary install path; NSIS kept as fallback
- Installer copies the extension to `~/Downloads/Browy-Extension` (Windows) or `$HOME/Downloads/Browy-Extension` (mac/linux) for easy `Load unpacked`
- `BROWY_NO_OPEN=1` env var to suppress auto-opening Explorer + `chrome://extensions` after install

### Changed
- Extension toolbar icon redrawn as faithful port of the in-app pixel mascot (white CRT eyes, green grin, ear knobs, corner bolts, power LED)
- "New chat" button is no longer gated on backend readiness, it's a local reset and always works

### Fixed
- "New chat" and "Chats" toolbar buttons could appear stuck-disabled if `__host_ready` was missed during a fast service-worker restart; added a safety net on `session.ready`
- `SECURITY.md` now points at GitHub's private vulnerability reporting instead of a placeholder email

## [0.1.0]: preview (initial)

### Added
- Apache-2.0 LICENSE, NOTICE, README, CONTRIBUTING, SECURITY, CHANGELOG
- Settings page shows install commands when host is offline
- All chat controls (input, send, stop, new chat, chat list) disable when backend is offline
- Strengthened "I'm Browy" identity in the system prompt, never mentions Copilot/Claude/GPT to the user
- NSIS Windows installer, portable ZIP, native-messaging host registration on Chrome/Edge/Brave

### Changed
- Simplified offline state to a single `// offline` badge, removed multi-iteration host-missing CTAs
- Chat list summaries: user message text is now placed before browser context so SDK summary captures intent
- `cleanChatSummary` strips paired AND unclosed `<page_snapshot>` tags

### Fixed
- `install.ps1` skips GitHub version lookup when `BROWY_LOCAL_ZIP` is set
- `install.ps1` saved with UTF-8 BOM so PowerShell 5.1 parses em-dashes correctly
- Memory leak in long-running native-host sessions (~400 MB plateau instead of unbounded growth)
- Init race in extension where SDK chat list could load before backend was ready

## [0.1.0]: preview

Initial preview release. Side panel + DevTools panel UIs, native-messaging host wrapping the GitHub Copilot SDK, ~40 CDP-backed tools, NSIS installer for Windows.
