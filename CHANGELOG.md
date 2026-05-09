# Changelog

All notable changes to Browy will be documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.1] — fixes
*Released 2026-05-09*

### Added
- CLI install (`install.ps1` / `install.sh`) is now the primary install path; NSIS kept as fallback
- Installer copies the extension to `~/Downloads/Browy-Extension` (Windows) or `$HOME/Downloads/Browy-Extension` (mac/linux) for easy `Load unpacked`
- `BROWY_NO_OPEN=1` env var to suppress auto-opening Explorer + `chrome://extensions` after install

### Changed
- Extension toolbar icon redrawn as faithful port of the in-app pixel mascot (white CRT eyes, green grin, ear knobs, corner bolts, power LED)
- "New chat" button is no longer gated on backend readiness — it's a local reset and always works

### Fixed
- "New chat" and "Chats" toolbar buttons could appear stuck-disabled if `__host_ready` was missed during a fast service-worker restart; added a safety net on `session.ready`
- `SECURITY.md` now points at GitHub's private vulnerability reporting instead of a placeholder email

## [0.1.0] — preview (initial)

### Added
- Apache-2.0 LICENSE, NOTICE, README, CONTRIBUTING, SECURITY, CHANGELOG
- Settings page shows install commands when host is offline
- All chat controls (input, send, stop, new chat, chat list) disable when backend is offline
- Strengthened "I'm Browy" identity in the system prompt — never mentions Copilot/Claude/GPT to the user
- NSIS Windows installer, portable ZIP, native-messaging host registration on Chrome/Edge/Brave

### Changed
- Simplified offline state to a single `// offline` badge — removed multi-iteration host-missing CTAs
- Chat list summaries: user message text is now placed before browser context so SDK summary captures intent
- `cleanChatSummary` strips paired AND unclosed `<page_snapshot>` tags

### Fixed
- `install.ps1` skips GitHub version lookup when `BROWY_LOCAL_ZIP` is set
- `install.ps1` saved with UTF-8 BOM so PowerShell 5.1 parses em-dashes correctly
- Memory leak in long-running native-host sessions (~400 MB plateau instead of unbounded growth)
- Init race in extension where SDK chat list could load before backend was ready

## [0.1.0] — preview

Initial preview release. Side panel + DevTools panel UIs, native-messaging host wrapping the GitHub Copilot SDK, ~40 CDP-backed tools, NSIS installer for Windows.
