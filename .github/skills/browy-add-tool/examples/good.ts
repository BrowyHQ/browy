// examples/good.ts
// A passing example of a new Browy browser tool that follows every rule
// in SKILL.md. Drop this shape into src/agent/tools/browser.ts.

register({
  def: {
    type: 'function',
    name: 'scroll_to_index',
    description:
      'Scroll the element with index [N] from the page snapshot into view. ' +
      'Use after inspect_page returns elements that are below the fold and ' +
      'you need them visible before a screenshot or before measuring layout. ' +
      'Returns { success: boolean, scrolledY: number, error?: string }. ' +
      'Does NOT click or hover the element. Does NOT mutate the DOM.',
    parameters: {
      type: 'object',
      properties: {
        index: {
          type: 'number',
          description: 'The [N] index from the page snapshot.',
        },
      },
      required: ['index'],
    },
  },
  async run(args, ctx) {
    const idx = Number(args.index);
    if (!Number.isFinite(idx) || idx < 1) {
      return JSON.stringify({
        success: false,
        error: 'index must be a positive integer',
      });
    }

    const cdp = ctx.cdp as unknown as {
      send: (m: string, p?: unknown) => Promise<unknown>;
    };

    const resolved = await resolveIndex(cdp, idx);
    if (!resolved.found || !resolved.rect) {
      return JSON.stringify({
        success: false,
        error: resolved.reason || `index ${idx} not in snapshot. Call inspect_page first.`,
      });
    }

    const targetY = Math.max(0, resolved.rect.y - 80);
    await cdp.send('Runtime.evaluate', {
      expression: `window.scrollTo({ top: ${targetY}, behavior: 'instant' })`,
    });

    return JSON.stringify({ success: true, scrolledY: targetY });
  },
});
