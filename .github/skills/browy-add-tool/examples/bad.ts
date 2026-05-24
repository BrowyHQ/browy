// examples/bad.ts
// Same shape as good.ts but with the four most common mistakes. Each is
// annotated so an agent reading this file can pattern-match the failure
// modes in code review.

register({
  def: {
    type: 'function',
    name: 'scroll_to_index',
    // ❌ Mistake #3: description says what but not when. The LLM will
    // either skip this tool or fire it at the wrong time. Always
    // include "when to call this" + the return shape.
    description: 'Scrolls to an element.',
    parameters: {
      type: 'object',
      properties: {
        // ❌ Mistake #4: takes a selector when an index would do.
        // Selectors break the moment the SPA re-renders with a new
        // generated class name. Use the [N] index from the snapshot.
        selector: { type: 'string' },
      },
      required: ['selector'],
    },
  },
  async run(args, ctx) {
    // ❌ Mistake #2: throws on bad args instead of returning a
    // structured error. The user sees a cryptic stringified TypeError.
    const el = await ctx.cdp.send('DOM.querySelector', {
      nodeId: 1,
      selector: (args as { selector: string }).selector,
    });

    // ❌ Mistake #1: returns a plain object. The Copilot SDK expects a
    // JSON string. The SDK will reject this and the LLM will see the
    // rejection text instead of the result.
    return { success: true, el };
  },
});
