# Contributing to Browy

Thanks for being interested. Browy is in early access, the API surface is fluid, and the codebase is small enough that a single PR can have a big effect. This document covers everything you need to land your first contribution.

## Table of contents

- [Code of conduct](#code-of-conduct)
- [Ways to help](#ways-to-help)
- [Reporting bugs](#reporting-bugs)
- [Suggesting features](#suggesting-features)
- [Development setup](#development-setup)
- [The dev loop](#the-dev-loop)
- [Project layout](#project-layout)
- [Style](#style)
- [Tests](#tests)
- [Documentation](#documentation)
- [Commits and PRs](#commits-and-prs)
- [Adding a new tool](#adding-a-new-tool)
- [Releasing](#releasing)
- [License](#license)

---

## Code of conduct

This project follows the [Contributor Covenant](https://www.contributor-covenant.org/). By participating you are expected to act in good faith and treat other contributors with respect. Report any unacceptable behaviour by emailing the maintainer (see `package.json` for the address) or by opening a private security advisory.

## Ways to help

- **File reproductions for SPA issues.** LinkedIn, Notion, Discord, Figma all do weird things. A clear repro with the exact prompt and the resulting transcript is gold.
- **Add a tool.** Any CDP-backed primitive (request interception, response mocking, perf profiling, accessibility queries) is welcome. See [Adding a new tool](#adding-a-new-tool).
- **Improve the installers.** macOS and Linux paths need more testing on edge-case shells and locked-down setups.
- **Translate.** Simplified Chinese is in place. Other locales follow the same pattern; see the [localisation policy in the content pipeline](https://github.com/BrowyHQ/browyhq.github.io/blob/main/src/content/docs/) if you want to add one.
- **Documentation and screenshots.** Concrete, working examples are the highest-leverage docs.
- **Tests.** Adding test coverage to under-tested areas is one of the easiest ways to contribute.

---

## Reporting bugs

Open a [GitHub issue](https://github.com/BrowyHQ/browy/issues/new). Include:

1. **Browy version**: `browy --version` (or the version in `extension/manifest.json`).
2. **OS and browser**: `Windows 11 / Chrome 124`, `macOS Sonoma / Brave`, etc.
3. **Native-host log**: the last ~50 lines of `~/.browy/host/host.log` (or `%USERPROFILE%\.browy\host\host.log` on Windows). Redact anything sensitive before pasting.
4. **A clear reproduction**: the exact prompt, the tab you ran it against (or a public URL that produces the same behaviour), and the resulting transcript or screenshot.
5. **What you expected vs what happened.**

If the bug is a security issue, **do not file a public issue**. Use [GitHub's private vulnerability reporting](https://github.com/BrowyHQ/browy/security/advisories/new). See [SECURITY.md](SECURITY.md) for the full policy.

---

## Suggesting features

Open a [discussion](https://github.com/BrowyHQ/browy/discussions) first if the feature is non-trivial; an issue if it is a clear, well-scoped tool or fix. We respond faster when the discussion includes:

- The use case behind the request (what task are you trying to accomplish).
- Whether the feature is achievable today with `evaluate_js` or a workaround.
- A rough API or UI sketch.

Browy is intentionally small. Features that grow the surface significantly (new transports, new authentication providers, alternative LLM backends) need design agreement before code.

---

## Development setup

### Requirements

- Node.js 20+ (we test against the latest LTS).
- Chrome, Edge, or Brave installed locally.
- A GitHub Copilot subscription on your account (the agent loop needs one to run end-to-end).

### Clone and build

```bash
git clone https://github.com/BrowyHQ/browy.git
cd browy
npm install
npm run build
```

### Load the unpacked extension

1. Open `chrome://extensions/`.
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** and select `extension/` from the cloned repo.

### Point the native host at your build

Run the helper that installs the dev native-host manifest:

```bash
npm run dev:register
```

This writes a manifest under your browser's `NativeMessagingHosts` directory pointing at `dist/native-host.js`. See [`src/README.md`](src/README.md#developing-locally) for the full path table per OS.

---

## The dev loop

1. Edit code in `src/` or `extension/`.
2. `npm run build` (or `node build.mjs --watch` for esbuild watch mode).
3. Send a message in the side panel. Chrome respawns the native host with your new build automatically; you do not need to reload the extension.
4. If the host hangs:
   - Windows: `Get-Process node | Where { $_.Path -like "*Browy*" } | Stop-Process -Force`
   - macOS / Linux: `pkill -f browy-host`
5. If the extension hangs: hit the reload icon on the Browy card in `chrome://extensions/`.

For the headless CLI:

```bash
# After npm run build
node dist/cli.js run "summarise this README"
```

---

## Project layout

```
browy/
├── extension/             ← Chromium extension (side panel + DevTools panel + options)
├── src/
│   ├── agent/
│   │   ├── loop.ts        ← The agent loop. SDK session, tool dispatch, system prompt.
│   │   ├── tools/
│   │   │   ├── browser.ts ← Browser tool registry (one entry per tool)
│   │   │   └── host.ts    ← Host tool allowlist
│   │   └── snapshot.ts    ← Accessibility-tree serialiser
│   ├── cli/               ← `browy run` headless entry point
│   ├── transports/        ← native messaging + websocket
│   └── native-host.ts     ← Process entry, port lifecycle, log file
├── tests/                 ← Vitest suite
├── installer/             ← install.ps1, install.sh, NSIS
└── packaging/             ← Per-OS native-messaging-host manifests
```

If you are adding a tool, you almost certainly only touch `src/agent/tools/browser.ts` and `extension/sidepanel.js` (for any UI rendering).

---

## Style

- **TypeScript strict mode** in `src/`. The extension is plain JS deliberately (no build step on the extension side).
- **esbuild bundle, no transpiler config.** If you need a new build step, talk about it in an issue first.
- **No external runtime dependencies in the extension.** Anything you need has to be vendored or done with the platform.
- **Small, focused PRs.** A 200-line PR that does one thing is easier to review, easier to revert, and lands faster than a 1,000-line PR that does five things.
- **No em-dashes (U+2014) or en-dashes (U+2013) in user-facing copy** (READMEs, docs, blog, CWS listing, video captions). Use periods, "and", or "but". This is enforced by a grep check in the content pipeline.
- **Match the existing voice** in README and docs: concrete, specific numbers, low ceremony, no marketing-speak.

---

## Tests

```bash
npm test            # all tests
npm run test:watch  # watch mode
```

Covers the page-snapshot serialiser, redaction logic, transport framing, and a few smoke tests of the agent loop. Adding more test coverage is one of the easiest ways to contribute, especially around the snapshot serialiser, which has to handle a wide variety of malformed real-world pages.

When you add a new tool, add a smoke test under `tests/agent/tools/` that exercises the handler signature and the schema. Real integration testing happens by hand against live pages; that is fine.

---

## Documentation

If your change is user-visible, update the relevant pages in [browyhq.github.io](https://github.com/BrowyHQ/browyhq.github.io) **in the same PR** (or a linked PR if you do not have write access there yet; we'll bring it in).

The localisation rule from the docs site applies: **English changes are mandatory; matching Chinese updates are mandatory for any page that has a `zh-cn/` parallel.** Half-translated pages regress the user experience. Details in `browy-docs/src/content/docs/AGENTS.md` (private, ping the maintainer if you need access).

For inline doc strings on tools, follow the shape of existing entries in `src/agent/tools/browser.ts` (terse description, JSON schema, handler).

---

## Commits and PRs

### Commits

- Use conventional, short, lowercase subject lines: `fix:`, `feat:`, `docs:`, `chore:`, `test:`, `refactor:`.
- Keep the subject under 72 characters.
- Use the body to explain *why*, not *what*. The diff already shows what.

### PRs

1. Fork, branch from `main`. Name the branch descriptively (`feat/add-pdf-export-tool`, `fix/dom-snapshot-empty-iframe`).
2. Build, lint, and test locally before pushing.
3. Open the PR against `BrowyHQ/browy:main`. Link the issue it closes.
4. Fill in the PR template. The checklist is short and worth doing.
5. Expect a review within a few days. Smaller PRs ship faster.
6. By submitting, you agree your contribution is licensed under [Apache-2.0](LICENSE).

If your PR ends up larger than ~500 lines net, consider splitting it. We will usually ask anyway.

---

## Adding a new tool

This is the most common contribution path. The tool registry is in [`src/agent/tools/browser.ts`](src/agent/tools/browser.ts).

For AI-assisted contributors, there is a project-level agent skill at [`.github/skills/browy-add-tool/`](.github/skills/browy-add-tool/) that walks Copilot (or any Agent-Skills-compatible client) through this same workflow with worked examples.

1. **Pick a slot.** Group your tool with similar ones (see the inline section comments).
2. **Copy the shape of a neighbour.** Each tool is a `register({...})` block with `name`, `description`, `parameters` (a JSON schema the model sees), and `handler`.
3. **Make the handler thin.** It should validate input, dispatch over the port, and return the tool result. Heavy lifting belongs in a helper module.
4. **Document the tool** in [browyhq.github.io/tools](https://github.com/BrowyHQ/browyhq.github.io/blob/main/src/content/docs/tools.mdx). Both English and Chinese.
5. **Add a smoke test** that exercises the schema and handler.
6. **Verify the tool gates correctly.** It should appear in the settings tool-toggle UI and be strippable from the prompt.

Browser-driving tools go in `browser.ts`. Host-touching tools (shell, filesystem, web fetch) require an extra allowlist entry in `src/agent/loop.ts`; do not add to that allowlist without discussion.

---

## Releasing

Releases are cut from `main` by the maintainer. Each release:

1. Bumps `extension/manifest.json` and `package.json`.
2. Adds a new section to [CHANGELOG.md](CHANGELOG.md) with `### Added` / `### Changed` / `### Fixed` / `### Removed` subsections per [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
3. Tags `v0.X.Y` and pushes the tag.
4. The release workflow builds the installers and uploads to [GitHub Releases](https://github.com/BrowyHQ/browy/releases).
5. The Chrome Web Store listing is updated separately, only when the extension code itself changes.

You do not need to bump versions in your PR. The maintainer batches version bumps with releases.

---

## License

By contributing you agree your contributions are licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) for attributions.

---

## Questions

- Open a [GitHub Discussion](https://github.com/BrowyHQ/browy/discussions) for bigger questions.
- Open an [issue](https://github.com/BrowyHQ/browy/issues) for clear, well-scoped bugs or feature requests.
- Tag `@ritabratamaiti` in an existing issue if you need a maintainer's attention.

Thanks for being here.
