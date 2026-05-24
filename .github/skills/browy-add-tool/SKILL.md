---
name: browy-add-tool
description: Use this skill when adding a new browser tool to the Browy agent (BrowyHQ/browy). Tools are functions the LLM can call from chat. Examples include click, type, scrape, network inspection, tab control. The skill walks through the register({ def, run }) pattern used in src/agent/tools/, the schema the Copilot SDK expects, the indexed-element interaction pattern (clicking by [N] from the page snapshot rather than guessed CSS), and the conventions every tool must follow (always return a JSON string, never throw, document side effects in the description, prefer indexed clicks over selector clicks). Activate when the user says "add a tool to Browy", "let the agent do X in the browser", or "extend Browy with a new capability".
license: Apache-2.0
compatibility: Targets the BrowyHQ/browy codebase. Tools live in src/agent/tools/browser.ts. Runtime is Node 20+, TypeScript strict, ESM. Tool implementations use a CDPSession (playwright-core) injected via BrowserToolContext.
---

# Adding a new browser tool to Browy

Browy is an open-source AI agent that lives in a Chrome side panel and in a
DevTools CLI REPL. From chat, the LLM picks tools from a registry and the
host runs them against the user's real browser tab. This skill walks an
agent through adding one cleanly.

Repo: <https://github.com/BrowyHQ/browy>
Docs: <https://browyhq.github.io>

## Quick anatomy

A tool is a `ToolHandler`: a `def` (the JSON schema the LLM sees) and an
async `run` function. Both live in `src/agent/tools/browser.ts`. To add
one, append a `register({ def, run })` call.

```ts
register({
  def: {
    type: 'function',
    name: 'scroll_to_index',
    description: 'Scroll the element with index [N] from the page snapshot into view. Use after inspect_page returns elements that are below the fold. Returns { success, scrolledY }.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'The [N] index from the page snapshot.' },
      },
      required: ['index'],
    },
  },
  async run(args, ctx) {
    const idx = Number(args.index);
    if (!Number.isFinite(idx) || idx < 1) {
      return JSON.stringify({ success: false, error: 'index must be a positive integer' });
    }
    const cdp = ctx.cdp as unknown as { send: (m: string, p?: unknown) => Promise<unknown> };
    const resolved = await resolveIndex(cdp, idx);
    if (!resolved.found) {
      return JSON.stringify({ success: false, error: resolved.reason || `index ${idx} not in snapshot` });
    }
    // ... CDP scroll call ...
    return JSON.stringify({ success: true, scrolledY: 0 });
  },
});
```

See `examples/good.ts` for a complete passing example and
`examples/bad.ts` for the same shape with the four most common mistakes.

## The seven rules

Every tool in `src/agent/tools/browser.ts` must obey these. They look
fussy. They exist because Copilot's tool-calling loop runs untrusted
output back through the LLM, and one tool that throws or returns a bare
string can derail an entire agent turn.

1.  **Return a JSON string. Never an object, never a thrown error.**
    The Copilot SDK expects `string`. `runTool` already catches throws and
    serialises them, but for predictable shapes you should serialise
    yourself: `return JSON.stringify({ success: true, ... })` on success,
    `return JSON.stringify({ success: false, error: '...' })` on failure.

2.  **Validate every argument explicitly.** The LLM will sometimes pass
    `args.index` as a string, sometimes as a float, sometimes as
    `undefined`. Coerce with `Number(args.index)` and reject with
    `Number.isFinite` and a positive-integer check. Reject with `error`
    in the returned JSON. Don't throw.

3.  **Prefer indexed-element interaction over CSS selectors.** The page
    snapshot indexes every interactive element as `[N]`. `click_index`,
    `type_index`, and `scroll_to_index` use that. `click_element` and
    `type_text` with selectors exist but are second-class. New tools
    that operate on a specific element should take `index: number`, not
    `selector: string`.

4.  **Describe side effects + return shape in the `description`.** The
    LLM picks tools by reading their `description`. Say what the tool
    does, when to call it, and what the JSON return looks like. Bad:
    `"Click an element."` Good: `"Click the element with index [N]. Auto-scrolls into view. Returns { urlChanged, titleChanged, domChanged, modalAppeared } so you can verify the click had an effect. PREFER this over click_element when the element appears in the snapshot."`

5.  **Return state-delta on actions that change the page.** Tools that
    can cause navigation, modals, or DOM mutation should return the
    deltas (`urlChanged`, `domChanged`, `modalAppeared`, etc.) so the
    LLM can verify and recover. Use `captureClickState` in the existing
    file as the pattern.

6.  **Single CDP round-trip when possible.** Each `ctx.cdp.send(...)`
    adds 5-15ms over native messaging. If a tool needs URL, title, and a
    text hash, do it in one `Runtime.evaluate` with a `JSON.stringify`
    expression. `captureClickState` is the reference implementation.

7.  **Snapshot indices go stale after navigation.** Any tool that may
    cause the page to change should recommend `inspect_page` in its
    return value when `domChanged: true`. Or, for tools where the next
    step almost always needs a fresh snapshot, just call
    `capturePageSnapshot` yourself and include the new listing.

## Workflow

1.  **Read the existing tools.** The contract isn't only in this skill.
    It's in the patterns already proven. Open `src/agent/tools/browser.ts`
    and read `inspect_page`, `click_index`, and `type_index`. Anything
    your new tool returns should resemble those shapes.

2.  **Pick the right primitive.** If the work is one CDP call wide,
    inline it. If it's three or more CDP calls, factor a helper above
    the `register({...})` block. Helpers `resolveIndex`,
    `captureClickState`, and `capturePageSnapshot` already exist.

3.  **Write a small test that covers the JSON shape.** Browy ships
    `npm test`. Add a fixture that calls the tool through `runTool`
    and asserts the parsed result has the documented keys. Don't test
    side effects against a live page. Mock the `ctx.cdp.send` if
    needed.

4.  **Document in `docs/tools.mdx`.** Each new tool goes in the
    `browy-docs` repo at `src/content/docs/tools.mdx` under the right
    category. Mirror the change in `src/content/docs/zh-cn/tools.mdx`
    in idiomatic Chinese (the project enforces zh-CN parity).

5.  **Add a CHANGELOG entry.** `CHANGELOG.md` in the Browy repo,
    `### Added` under the next unreleased version.

## Common mistakes (the `examples/bad.ts` lineup)

-   Tool returns a plain object instead of a JSON string. The Copilot
    SDK will reject it and the LLM sees the rejection text instead of
    your result.
-   Tool throws on bad args. `runTool` catches, but the user sees a
    cryptic `JSON.stringify({error: 'TypeError: x.foo is undefined'})`
    instead of a structured `{ success: false, error: 'index must be a positive integer' }`.
-   Tool description says only what it does, never when to use it. The
    LLM will either skip it or call it when it shouldn't.
-   Tool uses `selector: string` when an index would do. Selectors break
    on dynamic class names; indices are stable across re-renders of the
    same DOM.

## Beyond browser tools

Browy also exposes host-side tools (shell, filesystem, web fetch) under
`src/agent/tools/host.ts`. The pattern is the same. The key difference
is the context: host tools receive a `HostToolContext` with `cwd`,
`env`, and a `permissions` object that gates dangerous operations. Add
new host tools only when the work genuinely needs the user's machine,
not the browser tab. And gate them behind a permission flag.

## Why this matters

Browy's whole value proposition is that the LLM can do something
specific in the user's browser. Every new tool widens the set of
"specific things." A well-shaped tool is read once by the LLM and used
correctly for the lifetime of the project. A poorly-shaped tool burns
LLM turns on confusion and shows up in support issues.
