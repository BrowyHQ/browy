# Changelog

All notable changes to Browy will be documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
