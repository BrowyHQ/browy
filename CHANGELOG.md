# Changelog

All notable changes to Browy will be documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Apache-2.0 LICENSE, NOTICE, README, CONTRIBUTING, SECURITY, CHANGELOG
- Settings page now shows install commands when host is offline
- All chat controls (input, send, stop, new chat, chat list) disable when backend is offline
- Strengthened "I'm Browy" identity in the system prompt — never mentions Copilot/Claude/GPT to the user

### Changed
- Simplified offline state to a single `// offline` badge — removed multi-iteration host-missing CTAs
- Chat list summaries: user message text is now placed before browser context so SDK summary captures intent
- `cleanChatSummary` strips paired AND unclosed `<page_snapshot>` tags

### Fixed
- `install.ps1` skips GitHub version lookup when `BROWY_LOCAL_ZIP` is set
- `install.ps1` saved with UTF-8 BOM so PowerShell 5.1 parses em-dashes correctly
- Memory leak in long-running native-host sessions
- Init race in extension where SDK chat list could load before backend was ready

## [0.1.0] — preview

Initial preview release. Side panel + DevTools panel UIs, native-messaging host wrapping the GitHub Copilot SDK, ~40 CDP-backed tools, NSIS installer for Windows.
