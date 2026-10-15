# Changelog

All notable changes to Browy will be documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **When a tool fails, the model now hears why.** Up to 0.1.13 every failure reached the model as "Tool execution failed", so it guessed at the cause and tried again; in one long run on 15 October that happened 11 times. The model now gets the actual error, such as a page that navigated away mid-call. A call that runs past the two-minute limit comes back as a timeout, with the reason.
- **A task running when the computer goes to sleep stops cleanly.** Browy notices the sleep when the computer wakes, stops the task the way Stop does, and says so in the chat: "Your computer went to sleep during this task, so I stopped it. The chat is saved. Say continue to pick up where it left off." It never repeats a step by itself, a message waiting behind another window's task doesn't start by itself either, and when you say continue the model is told its last task was cut short, so it checks the page before redoing anything that submits, sends, posts or buys.
- **Losing a tab is explained instead of guessed at.** When Chrome takes its debugger off a tab, because you clicked Cancel on the "started debugging this browser" bar, the tab closed, or it moved to a page like chrome://, the step running on it fails at once with the reason and the model is told in plain words. Up to 0.1.13 it got Chrome's bare "Detached while handling command.", and the next step quietly reattached and brought the bar back. After a Cancel, Browy now leaves the browser alone until your next message. Otherwise the next step reattaches by itself.
- **Copilot quitting no longer stalls a task for five minutes.** If the Copilot runtime exits or its connection drops mid-task, Browy ends the task at once with "Copilot quit unexpectedly, so this task stopped. The chat is saved.", starts Copilot again, and your next message carries on in the same chat. Up to 0.1.13 the task sat silent until the five-minute safety stop. After the computer wakes, Browy also checks that Copilot still answers and restarts it if not.
- **A backend crash mid-task ends the task with a note, and the panel recovers by itself.** The side panel ends the task with "The backend restarted, so this task stopped. The chat is saved.", reconnects, and registers the chat again, so your next message works. Up to 0.1.13 it said "Host disconnected. Retrying…" with a link to reinstall, and left the half-finished reply with its tools still spinning. After the computer wakes, the panel also checks it can still reach the backend.

### Changed

- **A status line for what Browy is recovering from.** A line under the side panel's info bar says when the backend is reconnecting, Copilot is restarting, the computer slept during a task, or Browy lost the tab it was working in, and goes away once things are back to normal.

## [0.1.13]: Stop always works, and a dropped tool call gets run anyway
*Released 2026-10-14*

### Fixed

- **A tool call the SDK drops is run anyway.** The Copilot runtime hands each of Browy's tool calls to Browy's backend and waits for the answer with no time limit, so recovering from a lost call is Browy's job. On 14 October the SDK received one such call and never passed it to the tool, and the run sat silent for five minutes. Browy now notices at once when the SDK skips a call, runs the tool itself, and reconnects the chat to Copilot before the next message. The two-minute answer from 0.1.12 stays as a backstop.
- **Stop always frees the panel.** Every step before a message reaches Copilot, like opening the chat or reading the page, now has a time limit and ends at once on Stop. If a turn still hasn't let go three seconds after Stop, the backend frees the panel anyway. If the backend doesn't answer Stop at all for ten seconds, the side panel restarts it. Each of these used to need an extension reload.
- **A message never disappears without a reply.** When the backend had no record of a chat, for example right after it restarted, it dropped the message and the panel waited forever. It now says so, and the side panel registers the chat again and sends the message once more. The DevTools panel also registers again after a backend restart.

### Upgrading

Run the install command again to update the backend, which has most of these fixes. Then reload the extension at chrome://extensions (brave://extensions in Brave) for the side panel's part: the ten-second restart and the automatic resend.

## [0.1.12]: a stuck tool call no longer ends the run
*Released 2026-10-14*

### Fixed

- **One tool call that never answered could end a whole run.** On 14 October a long outreach run stopped at the five-minute safety stop: one `inspect_page` request reached the backend but never reached the tool, so 0.1.11's one-minute limit on browser calls never started. Every tool request now gets an answer within two minutes. If the tool is still running, or never started, Browy tells the model the call failed and the run carries on. A late result from the abandoned call is dropped, and the backend log notes which of the two happened.

### Upgrading

Run the install command again to update the backend. The extension's version moves to 0.1.12 to stay in step; its code is unchanged, so there's nothing to reload.

## [0.1.11]: Stop stops, replies stream, and a stuck tab no longer stalls a run
*Released 2026-10-14*

### Fixed

- **A browser call that never answered stalled the whole turn.** When a tab was frozen, discarded or showing a dialog, chrome.debugger could leave a call without a reply, and the agent waited on it until a five-minute watchdog gave up with "Agent went idle for 5 min with no SDK activity". Calls to the browser now fail after a minute, or a little after a script's own timeout, so the agent gets an error it can work around. The page details Browy attaches to each message give up after a few seconds, so a blocked tab no longer holds up the model either. The watchdog stays as a last resort. It now names the tool it was waiting on and aborts the turn in the Copilot runtime too, so your next message doesn't queue behind the stuck one.
- **Replies stream, and nothing gets dropped.** Sessions were created without the SDK's `streaming` option, so each reply showed up in one piece when the model finished. And when a turn had several messages (the model says something, calls tools, then says more), every message after the first was dropped if it was shorter than what came before it, or cut mid-word if it was longer. Each message is now tracked on its own.
- **Chats you come back to keep Browy's instructions.** Resuming a chat after the backend restarted didn't pass Browy's system prompt, and the runtime doesn't keep it, so the rest of that chat ran on the stock Copilot coding-agent prompt.
- **Stop stops.** It ends the turn right away with whatever Browy had said, aborts the turn in the Copilot runtime, and releases any browser call it was waiting on. The chat stays put, so your next message carries on from there.
- **`close_tab` closes the right tab.** In the extension it didn't close anything, then switched you to the first tab in the list, often one of yours in another window. It now closes the tab Browy is working in, or the one you name, and carries on in the tab the browser shows next.

### Changed

- **Copilot SDK 1.0.21 and Copilot CLI 1.0.97.** Browy was still on SDK 0.3.0 from April, six months and a major version behind. SDK 1.x brings its own Copilot runtime, but that runtime can't run the interactive sign-in, so Browy keeps shipping the full CLI and hands it to the SDK. The download stays about the same size. Dependabot now opens weekly update PRs, and every release takes them first.
- **Two windows, one Browy.** Each window's Browy now works on that window's tabs; it used to follow whichever window you focused last. A message sent from a second window while the first is busy waits its turn and starts as soon as the first finishes, instead of failing with "agent is busy on another panel", and Stop takes it out of the line. Closing a panel mid-run stops that run, and its output no longer spills into the other open panels.

### Upgrading

Run the install command again to update the backend, which is where most of this lives. The 0.1.11 extension adds the rest: each window working on its own tabs, the note when a message is waiting for another window, and a Stop that leaves no tool spinning. With an older extension, `close_tab` says it couldn't close the tab rather than switching you to another one.

## [0.1.10]: `run_script` is off until you switch it on
*Released 2026-10-13*

### Security

- **`run_script` is opt-in.** It runs Node.js on your computer with your user's privileges, which means files, the network and the shell, but it was a browser tool that was on by default, and Settings described it as running a script in the page. Any page Browy reads can carry text aimed at the model, and the Copilot CLI's own tools that reach your machine, like `bash`, have always stayed off until you switch them on. `run_script` now works the same way: it's listed with them under Settings, Tools, host, and it stays off until you turn it on.

### Upgrading

Run the install command again to update the backend; that's where the change takes effect, so `run_script` is off from then on. The 0.1.10 extension adds its switch under host tools. Until your browser has it, the old switch under DevTools no longer turns `run_script` on.

## [0.1.9]: a new chat no longer inherits the last chat's actions
*Released 2026-10-13*

### Fixed

- **A new chat could claim work it never did.** Browy shows the model its last few tool calls, so it can check whether a click or a fill worked. That list belonged to the whole backend instead of to one chat, so a new chat's first message arrived with the previous chat's tool calls attached. Asked in a fresh chat to fill a form it had just filled in another, the model replied that the form was filled and called no tools. Each chat now keeps its own list.

### Upgrading

Run the install command again to update the backend. The extension's version moves to 0.1.9 to stay in step; its code is unchanged.

## [0.1.8]: the current Copilot CLI, and Browy's own instructions reach the model
*Released 2026-10-12*

Browy 0.1.7 shipped Copilot CLI 1.0.36, and the current release is 1.0.95. Updating it turned up a bigger problem: the instructions that tell the model it is Browy, how to use the indexed tools, and when to hand a sign-in back to you were never being sent.

### Changed

- **Copilot CLI 1.0.95.** The CLI is now a native binary in a per-platform package, `@github/copilot-<platform>-<arch>`, instead of a Node script. The Copilot SDK Browy uses can't find it on its own, so the backend locates it and passes it in. On Windows the CLI starts in 0.6 s instead of 5.8 s, measured with the same SDK calls Browy makes. The cost is size: the binary is about 150 MB unpacked, so the Windows download grows from about 80 MB to about 140 MB.
- **"Fill this form" fills it and stops.** Browy now submits only when you ask it to submit, send, post or buy. Otherwise it leaves the form filled and tells you it's ready for you to check. Its instructions used to say fill, then submit, though they weren't reaching the model (see below).

### Fixed

- **Browy's system prompt was never sent.** The SDK builds a session from `systemMessage` and ignores `systemPrompt`, which is the name Browy used, so chats ran on the CLI's default instructions plus Browy's tool list. Asked its name, Browy now answers "I'm Browy".
- **`browy run` works.** It called a `sendMessage()` method the SDK doesn't have and crashed on the first prompt with `t.sendMessage is not a function`. It now streams replies the way the side panel does.
- **The host log records what the agent does.** The backend's console hook called `require()` inside an ES module bundle, which throws, so the agent's progress lines never reached `~/.browseragent/native-host.log`. They do now, including which Copilot CLI started.
- **Every platform's package carries its own CLI.** CI builds the Intel Mac and Linux arm64 packages on runners of the other architecture, where npm installs the runner's binary. Staging now removes it and fetches the target's own package.

### Upgrading

Run the install command again to update the backend. The extension's version moves to 0.1.8 to stay in step; its code is unchanged.

## [0.1.7]: first-run setup, and the extension knows when your backend is too old
*Released 2026-09-29*

Installing the backend is the one setup step that leaves the browser, and the side panel handled it with a red one-line banner. Separately, the Web Store updates the extension on its own but nothing updates the backend, so after every release people ran a new panel against an old host and features quietly failed. This release fixes both. It also ships the two-window session fix and the new store description, which were committed after 0.1.6 but never released.

### Added

- **A first-run setup screen** ([#10](https://github.com/BrowyHQ/browy/issues/10)). When the backend isn't installed, the side panel now shows what to run instead of a banner over a disabled input: the install command for your OS (detected automatically, with a copy button), where to paste it, and what happens next. It checks for the backend every few seconds, and right away when you come back to the window, then moves on by itself. No reopening the panel. A backend that's installed but too old to trust this extension's ID gets the same screen with update wording. Measured against a real browser: from the host being registered to a live chat in 3.6 s, with no flicker between probes.
- **"Try one of these" prompts** on the first empty chat, until you send your first message. Right after installing from the Web Store the active tab is usually the store itself, which Chrome never lets an extension read. On that tab, or any browser page, the panel says so instead of sending a prompt that can only fail.
- **A host-version check** ([#11](https://github.com/BrowyHQ/browy/issues/11)). When the backend is older than the extension needs, the side panel shows a yellow banner with a button that copies the update command, and a "later" that snoozes it for a day. The DevTools panel prints the same warning, and the settings page shows "backend outdated" instead of a meaningless version.

### Fixed

- **Two side panels in two windows no longer break each other.** Every panel connected with the same port name, so a second window overwrote the first in the background's client map. Every host reply went to the newer window, and the older one went dead with no error. Whichever closed first then ended the other's live session and detached its debugger mid-use. The DevTools panel had the same bug. Port names are now unique per panel, and a second panel that claims a session another live panel owns gets a fresh one. Switching chats and starting a new chat now end the outgoing session instead of leaking it until the panel closes.
- **The backend reports its real version.** Every host up to 0.1.6 reported a hard-coded `0.3.0`, which matched no release, and `PROTOCOL_VERSION` stayed at `1` through three protocol additions. The version now comes from `package.json` at build time, and the protocol is `2`. Hosts from 0.1.6 and earlier can't say which of those additions they have, so they'll see the update banner once.
- **The settings page no longer hangs on "starting…"** when the backend is too old to trust the extension.
- **Docs.** The "check the host is on disk" command pointed at `browy.exe` / `~/.browy/app/browy`, which no release has shipped. Download sizes were about 50 MB too high. The log path was still wrong in the FAQ, architecture and privacy pages, despite 0.1.6's note. And the privacy page said chat history lives only in extension storage and is deleted on uninstall. In fact transcripts live in the Copilot SDK's store under `~/.copilot/`, and uninstalling doesn't remove them. Deleting a chat in the side panel removes both copies.

### Changed

- **Installers send you back to the browser.** They used to tell Web Store users to "install the Browy extension" they already had, and they opened the sideload folder in Explorer or Finder on every run, updates included. They now say the panel connects by itself. The folder only opens with `BROWY_OPEN=1`, so `BROWY_NO_OPEN` is no longer needed.
- **New store description:** "The browser agent that runs on the AI subscription you already pay for. No second bill." The old line was another product's title tag word for word, and "No API key" was dropped because no user has asked for it.

### Upgrading

Run the install command again to update the backend. From now on the side panel tells you when you need to.

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


## [0.1.5]: cold-start UX
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
