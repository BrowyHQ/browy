# Contributing to Browy

Thanks for being interested! Browy is in early access. The API surface is fluid, the codebase is small, and a lot is still up for grabs.

## Quick start

```bash
git clone https://github.com/BrowyHQ/browy
cd browy
npm install
npm run build
```

Then load `extension/` as an unpacked extension at `chrome://extensions` and follow [`src/README.md#developing-locally`](src/README.md#developing-locally) to register the native-messaging manifest pointing at your `dist/`.

## The dev loop

1. Edit code.
2. `npm run build` (or `node build.mjs --watch` for esbuild watch mode).
3. Send a message in the side panel. Chrome respawns the native host with your new code automatically.
4. If the host is wedged: `Get-Process node | Where { $_.Path -like "*Browy*" } | Stop-Process -Force`.

## What we'd love help with

- **Cross-platform install paths**: macOS and Linux installers need more testing
- **SPA-handling improvements**: LinkedIn, Notion, Discord, Figma all do weird things; better wait/retry strategies welcome
- **More tools**: anything CDP-backed (intercepting requests, mocking responses, perf profiling)
- **DevTools panel polish**: slash command UX, keyboard shortcuts
- **Translations**: i18n hasn't started

## Coding style

- TypeScript strict mode where it makes sense
- esbuild bundle, no transpiler config
- Prefer small focused PRs over giant ones. They're easier to review and easier to revert
- New tools go in `src/agent/loop.ts` near the existing `tools = [` array; copy the shape of an existing tool

## Tests

```bash
npm test
```

Covers the page-snapshot serializer, redaction, and a few smoke tests of the agent loop. Adding more test coverage is one of the easiest ways to contribute.

## License

By contributing you agree your contributions are licensed under [Apache-2.0](LICENSE).

## Questions

Open a discussion or ping the maintainer in an issue.

