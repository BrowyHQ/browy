import type { ToolDef } from '../../types.js';
import type { CDPSession, Browser, BrowserContext, Page } from 'playwright-core';
import {
  capturePageSnapshot, ensureSnapshot, resolveIndex, serializeSnapshot,
  type ResolvedElement,
} from '../page-snapshot.js';

export interface BrowserToolContext {
  cdp: CDPSession;
  browser: Browser;
  getPages: () => Page[];
  setActivePage: (page: Page) => Promise<void>;
  /** Optional: extension-mode contexts can fetch the user's currently-focused
   *  tab directly from the browser. The playwright-backed context populates
   *  this implicitly via Agent.refreshTabInfo() instead. */
  getActiveTabInfo?: () => Promise<{ url: string; title: string; tabCount: number; brand: string } | null>;
}

export interface ToolHandler {
  def: ToolDef;
  run: (args: Record<string, unknown>, ctx: BrowserToolContext) => Promise<string>;
}

const tools: ToolHandler[] = [];

function register(handler: ToolHandler) {
  tools.push(handler);
}

export function getAllTools(): ToolHandler[] {
  return tools;
}

export function getToolDefs(): ToolDef[] {
  return tools.map((t) => t.def);
}

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: BrowserToolContext,
): Promise<string> {
  const handler = tools.find((t) => t.def.name === name);
  if (!handler) return JSON.stringify({ error: `Unknown tool: ${name}` });
  try {
    return await handler.run(args, ctx);
  } catch (err) {
    return JSON.stringify({ error: String(err) });
  }
}

// ── Tools ──────────────────────────────────────────────────────────────────

// ── Indexed-element interaction (the SeeAct/browser-use pattern) ──────────
//
// These are the PREFERRED interaction tools. They operate on the indexed
// snapshot the runtime injects into <browser_context> each turn (or that the
// agent refreshes via inspect_page). Targeting elements by [N] is far more
// reliable than guessed CSS selectors.

async function captureUrlTitle(ctx: BrowserToolContext): Promise<{ url: string; title: string }> {
  try {
    const r = await ctx.cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({ url: location.href, title: document.title })`,
      returnByValue: true,
    }) as { result?: { value?: string } };
    return JSON.parse(String(r?.result?.value ?? '{"url":"","title":""}'));
  } catch { return { url: '', title: '' }; }
}

async function dispatchClick(ctx: BrowserToolContext, cx: number, cy: number): Promise<void> {
  await ctx.cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: cx, y: cy, button: 'none', clickCount: 0,
  });
  await ctx.cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1,
  });
  await ctx.cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1,
  });
}

register({
  def: {
    type: 'function', name: 'inspect_page',
    description: 'Re-snapshot the current page and return the indexed listing of interactive elements ([N]<tag attrs>text</tag>). Call this after any navigation, after a click that loads new content, after expanding a menu, or whenever you suspect the indices in <browser_context> are stale. The returned listing replaces what you saw in <browser_context>.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  async run(_args, ctx) {
    const snap = await capturePageSnapshot(ctx.cdp as unknown as { send: (m: string, p?: unknown) => Promise<unknown> });
    return serializeSnapshot(snap);
  },
});

register({
  def: {
    type: 'function', name: 'click_index',
    description: 'Click the element with the given index [N] from the page snapshot. Auto-scrolls into view. Returns urlChanged/titleChanged so you can verify the click had an effect. PREFER this over click_element when the element appears in the snapshot.',
    parameters: { type: 'object', properties: {
      index: { type: 'number', description: 'The [N] index from the page snapshot.' },
    }, required: ['index'] },
  },
  async run(args, ctx) {
    const idx = Number(args.index);
    if (!Number.isFinite(idx) || idx < 1) return JSON.stringify({ error: 'index must be a positive integer' });
    const cdp = ctx.cdp as unknown as { send: (m: string, p?: unknown) => Promise<unknown> };
    const before = await captureUrlTitle(ctx);
    const resolved: ResolvedElement = await resolveIndex(cdp, idx);
    if (!resolved.found || !resolved.rect) {
      return JSON.stringify({ success: false, error: resolved.reason || `index ${idx} not found — call inspect_page` });
    }
    await dispatchClick(ctx, resolved.rect.cx, resolved.rect.cy);
    // Brief wait for navigation/render to settle.
    await new Promise((r) => setTimeout(r, 500));
    const after = await captureUrlTitle(ctx);
    return JSON.stringify({
      success: true,
      tag: resolved.tag,
      urlChanged: before.url !== after.url,
      titleChanged: before.title !== after.title,
      url: after.url,
      title: after.title,
      hint: before.url !== after.url ? 'Page changed — call inspect_page before next interaction.' : undefined,
    });
  },
});

register({
  def: {
    type: 'function', name: 'type_index',
    description: 'Type text into the input/textarea at index [N]. Focuses the element first, optionally clears existing value, then sets value via the React-friendly setter and dispatches input/change events. Use press_key("Enter") afterward if you need to submit. PREFER this over fill_input when the element appears in the snapshot.',
    parameters: { type: 'object', properties: {
      index: { type: 'number', description: 'The [N] index from the page snapshot.' },
      text: { type: 'string', description: 'Text to type.' },
      clear: { type: 'string', description: 'Set to "false" to append instead of replace (default: "true" — clears first).' },
    }, required: ['index', 'text'] },
  },
  async run(args, ctx) {
    const idx = Number(args.index);
    const text = String(args.text ?? '');
    const clear = args.clear !== 'false';
    if (!Number.isFinite(idx) || idx < 1) return JSON.stringify({ error: 'index must be a positive integer' });
    const cdp = ctx.cdp as unknown as { send: (m: string, p?: unknown) => Promise<unknown> };
    const resolved: ResolvedElement = await resolveIndex(cdp, idx);
    if (!resolved.found) return JSON.stringify({ success: false, error: resolved.reason || `index ${idx} not found — call inspect_page` });
    if (!resolved.isEditable) return JSON.stringify({ success: false, error: `element [${idx}] (<${resolved.tag}>) is not editable` });
    const expr = `(() => {
      const el = document.querySelector('[data-browy-id="${idx}"]');
      if (!el) return JSON.stringify({ error: 'element vanished' });
      try { el.focus(); } catch(_) {}
      const tag = el.tagName.toLowerCase();
      const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const newVal = ${clear ? '' : '(el.value || "") + '}${JSON.stringify(text)};
      if (setter) setter.call(el, newVal); else el.value = newVal;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return JSON.stringify({ success: true, value: String(el.value || '').slice(0, 200) });
    })()`;
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }) as { result?: { value?: string } };
    return String(r?.result?.value ?? '{}');
  },
});

register({
  def: {
    type: 'function', name: 'select_index',
    description: 'Set the value of a native <select> element at index [N]. Matches by exact value, then by visible label text. For non-native (custom) dropdowns, use click_index to open it then click_index on the option.',
    parameters: { type: 'object', properties: {
      index: { type: 'number', description: 'The [N] index of the <select>.' },
      value: { type: 'string', description: 'Option value or visible label to choose.' },
    }, required: ['index', 'value'] },
  },
  async run(args, ctx) {
    const idx = Number(args.index);
    const value = String(args.value ?? '');
    if (!Number.isFinite(idx) || idx < 1) return JSON.stringify({ error: 'index must be a positive integer' });
    const cdp = ctx.cdp as unknown as { send: (m: string, p?: unknown) => Promise<unknown> };
    const expr = `(() => {
      const el = document.querySelector('[data-browy-id="${idx}"]');
      if (!el) return JSON.stringify({ error: 'index ${idx} not found — call inspect_page' });
      if (el.tagName !== 'SELECT') return JSON.stringify({ error: 'not a <select>; for custom dropdowns use click_index' });
      const want = ${JSON.stringify(value)};
      let chosen = null;
      for (const o of el.options) {
        if (o.value === want || o.text.trim() === want.trim()) { chosen = o; break; }
      }
      if (!chosen) return JSON.stringify({ error: 'no matching option', options: Array.from(el.options).slice(0, 50).map(o => ({ value: o.value, label: o.text })) });
      el.value = chosen.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return JSON.stringify({ success: true, value: chosen.value, label: chosen.text });
    })()`;
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }) as { result?: { value?: string } };
    return String(r?.result?.value ?? '{}');
  },
});

register({
  def: {
    type: 'function', name: 'clear_index',
    description: 'Empty the value of an input/textarea at index [N]. Convenience for type_index with empty text.',
    parameters: { type: 'object', properties: {
      index: { type: 'number', description: 'The [N] index from the page snapshot.' },
    }, required: ['index'] },
  },
  async run(args, ctx) {
    const idx = Number(args.index);
    if (!Number.isFinite(idx) || idx < 1) return JSON.stringify({ error: 'index must be a positive integer' });
    const cdp = ctx.cdp as unknown as { send: (m: string, p?: unknown) => Promise<unknown> };
    const expr = `(() => {
      const el = document.querySelector('[data-browy-id="${idx}"]');
      if (!el) return JSON.stringify({ error: 'index ${idx} not found — call inspect_page' });
      try { el.focus(); } catch(_) {}
      const tag = el.tagName.toLowerCase();
      const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, ''); else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return JSON.stringify({ success: true });
    })()`;
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }) as { result?: { value?: string } };
    return String(r?.result?.value ?? '{}');
  },
});

// ── Form-entry power tools (inspired by browser-use, Stagehand, Playwright) ─

register({
  def: {
    type: 'function', name: 'check_index',
    description: 'Toggle a checkbox or radio button at index [N]. Use checked="true" to set, "false" to uncheck. Dispatches input/change so React/Vue forms react. For checkboxes, omit `checked` to flip the current state.',
    parameters: { type: 'object', properties: {
      index: { type: 'number', description: 'The [N] index of the checkbox or radio.' },
      checked: { type: 'string', description: '"true" / "false" — desired state. Omit to toggle.' },
    }, required: ['index'] },
  },
  async run(args, ctx) {
    const idx = Number(args.index);
    if (!Number.isFinite(idx) || idx < 1) return JSON.stringify({ error: 'index must be a positive integer' });
    const cdp = ctx.cdp as unknown as { send: (m: string, p?: unknown) => Promise<unknown> };
    const want = args.checked == null ? 'null' : (String(args.checked) === 'true' ? 'true' : 'false');
    const expr = `(() => {
      const el = document.querySelector('[data-browy-id="${idx}"]');
      if (!el) return JSON.stringify({ error: 'index ${idx} not found — call inspect_page' });
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || '').toLowerCase();
      const isCheck = tag === 'input' && (type === 'checkbox' || type === 'radio');
      if (!isCheck) return JSON.stringify({ error: '<' + tag + ' type=' + type + '> is not a checkbox or radio' });
      const target = ${want};
      const next = target === null ? !el.checked : target;
      if (el.checked === next && type !== 'radio') return JSON.stringify({ success: true, checked: el.checked, noop: true });
      // Use the React-friendly setter so framework state updates.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
      if (setter) setter.call(el, next); else el.checked = next;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      // Click is what radio groups need to trigger group bookkeeping.
      if (type === 'radio' && next) try { el.click(); } catch(_) {}
      return JSON.stringify({ success: true, checked: el.checked, type });
    })()`;
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }) as { result?: { value?: string } };
    return String(r?.result?.value ?? '{}');
  },
});

register({
  def: {
    type: 'function', name: 'set_radio_index',
    description: 'Convenience for selecting a specific radio button at index [N] (equivalent to check_index with checked="true").',
    parameters: { type: 'object', properties: {
      index: { type: 'number', description: 'The [N] index of the radio button to select.' },
    }, required: ['index'] },
  },
  async run(args, ctx) {
    return runTool('check_index', { index: args.index, checked: 'true' }, ctx);
  },
});

register({
  def: {
    type: 'function', name: 'extract_form',
    description: `Extract the schema of a form on the page so you can plan a fill before doing it. If \`index\` is provided, returns the form containing element [N]; otherwise returns the largest form on the page. Each field reports: index (matching the page snapshot), label (from <label for>, aria-label, placeholder, or nearest text), tag, type, name, current value, required, and for <select>/radio groups the available options. PREFER calling this once before a multi-field fill.`,
    parameters: { type: 'object', properties: {
      index: { type: 'number', description: 'Optional [N] of any element inside the form you want; the closest enclosing <form> is used.' },
    }, required: [] },
  },
  async run(args, ctx) {
    const cdp = ctx.cdp as unknown as { send: (m: string, p?: unknown) => Promise<unknown> };
    const idxArg = args.index == null ? 'null' : Number(args.index);
    const expr = `(() => {
      function labelFor(el) {
        if (el.id) {
          const lab = document.querySelector('label[for=' + JSON.stringify(el.id) + ']');
          if (lab) return lab.innerText.trim();
        }
        const wrap = el.closest('label');
        if (wrap) return wrap.innerText.trim();
        const al = el.getAttribute('aria-label');
        if (al) return al.trim();
        const ph = el.getAttribute('placeholder');
        if (ph) return ph.trim();
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const t = document.getElementById(labelledBy);
          if (t) return t.innerText.trim();
        }
        // Fall back to nearest preceding text node sibling
        let prev = el.previousElementSibling;
        while (prev) {
          const txt = (prev.innerText || '').trim();
          if (txt && txt.length < 80) return txt;
          prev = prev.previousElementSibling;
        }
        return '';
      }
      function describe(el) {
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute('type') || '').toLowerCase();
        const idAttr = el.getAttribute('data-browy-id');
        const out = {
          index: idAttr ? Number(idAttr) : null,
          tag, type: type || undefined,
          name: el.getAttribute('name') || undefined,
          label: labelFor(el).slice(0, 120),
          required: el.hasAttribute('required'),
          disabled: el.hasAttribute('disabled') || el.hasAttribute('readonly'),
        };
        if (tag === 'select') {
          out.value = el.value;
          out.options = Array.from(el.options).slice(0, 50).map(o => ({ value: o.value, label: (o.text || '').trim().slice(0, 80), selected: o.selected }));
        } else if (type === 'checkbox' || type === 'radio') {
          out.checked = el.checked;
          if (type === 'radio') out.group = el.getAttribute('name') || undefined;
        } else if (tag === 'input' || tag === 'textarea') {
          out.value = String(el.value || '').slice(0, 200);
          if (el.maxLength && el.maxLength > 0) out.maxLength = el.maxLength;
        }
        return out;
      }
      let form = null;
      const startIdx = ${idxArg};
      if (startIdx != null) {
        const start = document.querySelector('[data-browy-id="' + startIdx + '"]');
        if (!start) return JSON.stringify({ error: 'index ' + startIdx + ' not found — call inspect_page' });
        form = start.closest('form') || start.closest('[role="form"]');
      }
      if (!form) {
        const forms = Array.from(document.querySelectorAll('form, [role="form"]'));
        if (forms.length === 0) {
          // Synthesize a "form" from all visible inputs so the tool still works on form-less pages.
          const fields = Array.from(document.querySelectorAll('input, textarea, select'))
            .filter(el => el.offsetParent !== null && (el.getAttribute('type') || '') !== 'hidden')
            .map(describe);
          return JSON.stringify({ form: { synthetic: true }, fields, submit: null });
        }
        // Pick the form with the most input descendants.
        forms.sort((a, b) => b.querySelectorAll('input,textarea,select').length - a.querySelectorAll('input,textarea,select').length);
        form = forms[0];
      }
      const fields = Array.from(form.querySelectorAll('input, textarea, select'))
        .filter(el => (el.getAttribute('type') || '') !== 'hidden')
        .map(describe);
      // Group radios by name with shared options.
      const groups = {};
      for (const f of fields) {
        if (f.type === 'radio' && f.group) {
          if (!groups[f.group]) groups[f.group] = [];
          groups[f.group].push({ index: f.index, label: f.label, checked: f.checked });
        }
      }
      const submitEl = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
      const submit = submitEl ? {
        index: submitEl.getAttribute('data-browy-id') ? Number(submitEl.getAttribute('data-browy-id')) : null,
        text: (submitEl.innerText || submitEl.value || 'Submit').trim().slice(0, 80),
      } : null;
      return JSON.stringify({
        form: {
          id: form.id || undefined,
          action: form.getAttribute('action') || undefined,
          method: (form.getAttribute('method') || 'GET').toUpperCase(),
          name: form.getAttribute('name') || undefined,
        },
        fields, radioGroups: groups, submit,
      });
    })()`;
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }) as { result?: { value?: string } };
    return String(r?.result?.value ?? '{}');
  },
});

register({
  def: {
    type: 'function', name: 'fill_form',
    description: `Fill multiple form fields in ONE call. Pass an array of {index, value} pairs (and optionally {action} for special types). Much cheaper than one tool call per field. Action defaults to "type" for inputs/textareas, "select" for <select>, "check" for checkboxes/radios. After fill_form, call submit_form (or click_index on the submit button) — fill_form does NOT submit.`,
    parameters: { type: 'object', properties: {
      fields: {
        type: 'string',
        description: 'JSON array of {index, value, action?} — e.g. \'[{"index":3,"value":"alice@example.com"},{"index":4,"value":"hunter2"},{"index":5,"value":"true","action":"check"}]\'. Strings only: numbers stringify, booleans use "true"/"false".',
      },
    }, required: ['fields'] },
  },
  async run(args, ctx) {
    let parsed: Array<{ index: number; value: string; action?: string }>;
    try {
      const raw = typeof args.fields === 'string' ? JSON.parse(args.fields) : args.fields;
      if (!Array.isArray(raw)) throw new Error('fields must be an array');
      parsed = raw;
    } catch (e) {
      return JSON.stringify({ error: `bad fields JSON: ${(e as Error).message}` });
    }
    const cdp = ctx.cdp as unknown as { send: (m: string, p?: unknown) => Promise<unknown> };
    // Run all fills in a single CDP eval to minimise round-trips.
    const expr = `(() => {
      const fields = ${JSON.stringify(parsed)};
      const results = [];
      for (const f of fields) {
        const el = document.querySelector('[data-browy-id="' + f.index + '"]');
        if (!el) { results.push({ index: f.index, ok: false, error: 'not found' }); continue; }
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute('type') || '').toLowerCase();
        try {
          el.focus && el.focus();
          let action = f.action;
          if (!action) {
            if (tag === 'select') action = 'select';
            else if (type === 'checkbox' || type === 'radio') action = 'check';
            else action = 'type';
          }
          if (action === 'select') {
            let chosen = null;
            for (const o of el.options) {
              if (o.value === f.value || o.text.trim() === String(f.value).trim()) { chosen = o; break; }
            }
            if (!chosen) { results.push({ index: f.index, ok: false, error: 'no matching option' }); continue; }
            el.value = chosen.value;
          } else if (action === 'check') {
            const next = String(f.value).toLowerCase() !== 'false';
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
            if (setter) setter.call(el, next); else el.checked = next;
          } else {
            const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(el, String(f.value)); else el.value = String(f.value);
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          results.push({ index: f.index, ok: true, action });
        } catch (e) {
          results.push({ index: f.index, ok: false, error: String(e?.message || e) });
        }
      }
      const okCount = results.filter(r => r.ok).length;
      return JSON.stringify({ filled: okCount, total: results.length, results });
    })()`;
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }) as { result?: { value?: string } };
    return String(r?.result?.value ?? '{}');
  },
});

register({
  def: {
    type: 'function', name: 'submit_form',
    description: `Submit the form containing the element at index [N] (or the page's primary form if no index). Prefers clicking the form's submit button (so JS handlers run); falls back to form.requestSubmit() / form.submit(). Returns urlChanged so you can verify navigation occurred.`,
    parameters: { type: 'object', properties: {
      index: { type: 'number', description: 'Optional: any [N] inside the form to submit.' },
    }, required: [] },
  },
  async run(args, ctx) {
    const cdp = ctx.cdp as unknown as { send: (m: string, p?: unknown) => Promise<unknown> };
    const before = await captureUrlTitle(ctx);
    const idxArg = args.index == null ? 'null' : Number(args.index);
    const expr = `(() => {
      let form = null;
      const startIdx = ${idxArg};
      if (startIdx != null) {
        const start = document.querySelector('[data-browy-id="' + startIdx + '"]');
        if (start) form = start.closest('form');
      }
      if (!form) {
        const forms = Array.from(document.querySelectorAll('form'));
        forms.sort((a, b) => b.querySelectorAll('input,textarea,select').length - a.querySelectorAll('input,textarea,select').length);
        form = forms[0];
      }
      if (!form) return JSON.stringify({ error: 'no <form> found' });
      const btn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
      if (btn) { try { btn.click(); return JSON.stringify({ success: true, via: 'click', text: (btn.innerText || btn.value || '').trim().slice(0, 60) }); } catch(_) {} }
      try { form.requestSubmit ? form.requestSubmit() : form.submit(); return JSON.stringify({ success: true, via: 'requestSubmit' }); }
      catch (e) { return JSON.stringify({ error: String(e?.message || e) }); }
    })()`;
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }) as { result?: { value?: string } };
    await new Promise((r) => setTimeout(r, 800));
    const after = await captureUrlTitle(ctx);
    const inner = JSON.parse(String(r?.result?.value ?? '{}'));
    return JSON.stringify({
      ...inner,
      urlChanged: before.url !== after.url,
      titleChanged: before.title !== after.title,
      url: after.url,
      hint: before.url !== after.url ? 'Page changed — call inspect_page before next interaction.' : 'No URL change — submit may have failed validation; inspect_page to check for error messages.',
    });
  },
});

register({
  def: {
    type: 'function', name: 'upload_index',
    description: 'Attach a local file to a <input type="file"> at index [N]. Bypasses the OS file-picker dialog entirely (uses CDP DOM.setFileInputFiles). Use absolute path. For multiple files on a multi-attach input, pass paths as a JSON array string.',
    parameters: { type: 'object', properties: {
      index: { type: 'number', description: 'The [N] index of the file input.' },
      path: { type: 'string', description: 'Absolute local file path, OR a JSON array of paths for multi-file inputs.' },
    }, required: ['index', 'path'] },
  },
  async run(args, ctx) {
    const idx = Number(args.index);
    if (!Number.isFinite(idx) || idx < 1) return JSON.stringify({ error: 'index must be a positive integer' });
    let paths: string[];
    const raw = String(args.path);
    if (raw.trim().startsWith('[')) {
      try { paths = JSON.parse(raw); } catch { return JSON.stringify({ error: 'bad path JSON array' }); }
    } else {
      paths = [raw];
    }
    const fs = await import('fs');
    for (const p of paths) {
      if (!fs.existsSync(p)) return JSON.stringify({ error: `File not found: ${p}` });
    }
    // Look up the backendNodeId via the data-browy-id attribute selector,
    // then DOM.setFileInputFiles. Avoids needing a full DOM tree fetch.
    const cdp = ctx.cdp as unknown as { send: (m: string, p?: unknown) => Promise<unknown> };
    const doc: any = await cdp.send('DOM.getDocument', { depth: -1 });
    const found: any = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: `[data-browy-id="${idx}"]` });
    if (!found?.nodeId) return JSON.stringify({ error: `index ${idx} not found in DOM — call inspect_page` });
    await cdp.send('DOM.setFileInputFiles', { files: paths, nodeId: found.nodeId });
    return JSON.stringify({ success: true, index: idx, files: paths });
  },
});

register({
  def: {
    type: 'function', name: 'press_keys',
    description: `Send a keyboard combination (e.g. "Ctrl+Enter" to submit a chat input, "Tab" to move focus, "Escape" to dismiss). Modifiers: Ctrl, Alt, Shift, Meta. Use this AFTER focusing the right input via type_index/focus_index.`,
    parameters: { type: 'object', properties: {
      keys: { type: 'string', description: 'Key combo, e.g. "Enter", "Ctrl+Enter", "Shift+Tab", "Meta+K".' },
    }, required: ['keys'] },
  },
  async run(args, ctx) {
    const combo = String(args.keys || '').trim();
    if (!combo) return JSON.stringify({ error: 'keys required' });
    const parts = combo.split('+').map(s => s.trim());
    const key = parts.pop() || '';
    const mods = new Set(parts.map(p => p.toLowerCase()));
    const modifiers =
      (mods.has('alt') ? 1 : 0) |
      (mods.has('ctrl') || mods.has('control') ? 2 : 0) |
      (mods.has('meta') || mods.has('cmd') || mods.has('command') ? 4 : 0) |
      (mods.has('shift') ? 8 : 0);
    // Map common keys → CDP key field. CDP wants the DOM "code" / "key" fields.
    const KEY_MAP: Record<string, { key: string; code: string; windowsVirtualKeyCode?: number; text?: string }> = {
      Enter:     { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
      Tab:       { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
      Escape:    { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
      Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
      Delete:    { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
      ArrowUp:   { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
      ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
      ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
      ArrowRight:{ key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
      Home:      { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
      End:       { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
      PageUp:    { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
      PageDown:  { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
      Space:     { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
    };
    const norm = key.length === 1 ? key.toUpperCase() : key;
    const mapped = KEY_MAP[norm] || (key.length === 1
      ? { key, code: 'Key' + key.toUpperCase(), windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), text: key }
      : { key, code: key });
    const base: any = { ...mapped, modifiers };
    await ctx.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
    if (base.text && !modifiers) await ctx.cdp.send('Input.dispatchKeyEvent', { type: 'char', ...base });
    await ctx.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    return JSON.stringify({ success: true, keys: combo });
  },
});

// ── Legacy / general tools ────────────────────────────────────────────────

register({
  def: {
    type: 'function', name: 'navigate',
    description: 'Navigate to a URL. By default, navigates the active tab when the URL is on the SAME hostname as the current tab (so the user keeps working in the same tab); opens a new tab otherwise. Set new_tab="true"/"false" to override.',
    parameters: { type: 'object', properties: {
      url: { type: 'string', description: 'The URL to navigate to' },
      new_tab: { type: 'string', description: 'Set to "true" to force a new tab, "false" to force navigating the current tab. Default: same-host → current tab, cross-host → new tab.' },
    }, required: ['url'] },
  },
  async run(args, ctx) {
    const url = String(args.url);
    let newTab: boolean;
    if (args.new_tab === 'true') newTab = true;
    else if (args.new_tab === 'false') newTab = false;
    else {
      // Smart default: same hostname → current tab, cross-host → new tab.
      let curHost = '';
      try {
        if (ctx.getActiveTabInfo) {
          const info = await ctx.getActiveTabInfo();
          if (info?.url) curHost = new URL(info.url).hostname;
        } else {
          const pages = ctx.getPages();
          if (pages.length) curHost = new URL(pages[0].url()).hostname;
        }
        const tgtHost = new URL(url).hostname;
        newTab = !(curHost && tgtHost && curHost === tgtHost);
      } catch {
        newTab = true; // safe fallback
      }
    }

    if (newTab) {
      // Open in a new tab via Playwright, then switch CDP to it
      const context = ctx.browser.contexts()[0];
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'load', timeout: 15_000 }).catch(() => {});
      await ctx.setActivePage(page);
      return JSON.stringify({ success: true, url, newTab: true });
    }

    // Navigate current tab
    await ctx.cdp.send('Page.navigate', { url });
    await ctx.cdp.send('Page.setLifecycleEventsEnabled', { enabled: true });
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 10_000);
      const handler = (params: { name: string }) => {
        if (params.name === 'load') {
          clearTimeout(timeout);
          ctx.cdp.off('Page.lifecycleEvent', handler);
          resolve();
        }
      };
      ctx.cdp.on('Page.lifecycleEvent', handler);
    });
    await new Promise((r) => setTimeout(r, 500));
    return JSON.stringify({ success: true, url, newTab: false });
  },
});

register({
  def: {
    type: 'function', name: 'get_page_info', description: 'Get URL, title, meta description, and visible text preview (first 2000 chars) of the current page.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  async run(_args, ctx) {
    const { result } = await ctx.cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        url: location.href,
        title: document.title,
        meta: document.querySelector('meta[name="description"]')?.content || '',
        text: document.body?.innerText?.slice(0, 2000) || ''
      })`,
      returnByValue: true,
    });
    return result.value as string;
  },
});

register({
  def: {
    type: 'function', name: 'query_dom', description: 'Query DOM with a CSS selector. Returns tag, text, attributes of matching elements (max 20).',
    parameters: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector' } }, required: ['selector'] },
  },
  async run(args, ctx) {
    const selector = String(args.selector).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const { result } = await ctx.cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify((() => {
        try {
          const els = document.querySelectorAll('${selector}');
          return { count: els.length, results: Array.from(els).slice(0, 20).map((el, i) => ({
            i, tag: el.tagName.toLowerCase(), id: el.id || undefined,
            text: el.innerText?.slice(0, 200) || '', href: el.getAttribute('href') || undefined,
            value: el.value ?? undefined
          }))};
        } catch(e) { return { error: String(e) }; }
      })())`,
      returnByValue: true,
    });
    return result.value as string;
  },
});

register({
  def: {
    type: 'function', name: 'click_element', description: 'Click an element by CSS selector.',
    parameters: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector' } }, required: ['selector'] },
  },
  async run(args, ctx) {
    const selector = String(args.selector).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const { result } = await ctx.cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector('${selector}');
        if (!el) return JSON.stringify({ error: 'Element not found: ${selector}' });
        el.click();
        return JSON.stringify({ success: true, tag: el.tagName.toLowerCase(), text: el.innerText?.slice(0, 100) });
      })()`,
      returnByValue: true,
    });
    return result.value as string;
  },
});

register({
  def: {
    type: 'function', name: 'fill_input', description: 'Fill a form input by CSS selector.',
    parameters: { type: 'object', properties: {
      selector: { type: 'string', description: 'CSS selector of input' },
      value: { type: 'string', description: 'Value to fill' },
    }, required: ['selector', 'value'] },
  },
  async run(args, ctx) {
    const selector = String(args.selector).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const value = String(args.value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const { result } = await ctx.cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector('${selector}');
        if (!el) return JSON.stringify({ error: 'Element not found' });
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
          || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(el, '${value}');
        else el.value = '${value}';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return JSON.stringify({ success: true });
      })()`,
      returnByValue: true,
    });
    return result.value as string;
  },
});

register({
  def: {
    type: 'function', name: 'extract_text', description: 'Extract visible text from page or element (max 4000 chars).',
    parameters: { type: 'object', properties: { selector: { type: 'string', description: 'Optional CSS selector' } }, required: [] },
  },
  async run(args, ctx) {
    const sel = args.selector ? String(args.selector).replace(/'/g, "\\'") : '';
    const expr = sel
      ? `JSON.stringify({ text: (document.querySelector('${sel}')?.innerText || 'Not found').slice(0, 4000) })`
      : `JSON.stringify({ text: document.body?.innerText?.slice(0, 4000) || '' })`;
    const { result } = await ctx.cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return result.value as string;
  },
});

register({
  def: {
    type: 'function', name: 'screenshot', description: 'Capture a screenshot of the current page. Returns base64 PNG (truncated preview in response, full image saved to disk).',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  async run(_args, ctx) {
    const { data } = await ctx.cdp.send('Page.captureScreenshot', { format: 'png' });
    const fs = await import('fs');
    const pathMod = await import('path');
    const os = await import('os');
    const dir = pathMod.join(os.homedir(), '.browy', 'data', 'screenshots');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const file = pathMod.join(dir, `screenshot-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    // Rotate: keep only the 50 most recent shots so the disk doesn't fill up
    // over long sessions. The agent rarely re-reads old screenshots — they're
    // for ground-truth, not history.
    try {
      const entries = fs.readdirSync(dir)
        .filter(n => n.startsWith('screenshot-') && n.endsWith('.png'))
        .map(n => ({ n, t: Number(n.slice('screenshot-'.length, -'.png'.length)) || 0 }))
        .sort((a, b) => b.t - a.t);
      for (const old of entries.slice(50)) {
        try { fs.unlinkSync(pathMod.join(dir, old.n)); } catch {}
      }
    } catch {}
    return JSON.stringify({ success: true, saved: file, sizeKB: Math.round(data.length * 0.75 / 1024) });
  },
});

register({
  def: {
    type: 'function', name: 'evaluate_js', description: `Execute JavaScript code in the browser page context. Use this for ANY custom browser action — composing complex DOM queries, automating multi-step UI flows, extracting structured data, or doing anything the pre-built tools can't handle. The code runs in the page with full DOM access. Return data by making the last expression a value. For async work, use await (top-level await is supported).`,
    parameters: { type: 'object', properties: { code: { type: 'string', description: 'JavaScript code to execute in the page. Can use await. Return data as the last expression.' } }, required: ['code'] },
  },
  async run(args, ctx) {
    const code = String(args.code);
    // Wrap in async IIFE for top-level await support
    const wrapped = `(async () => { ${code} })()`;
    const { result, exceptionDetails } = await ctx.cdp.send('Runtime.evaluate', {
      expression: wrapped,
      returnByValue: true,
      awaitPromise: true,
      timeout: 30_000,
    });
    if (exceptionDetails) {
      const errMsg = exceptionDetails.exception?.description || exceptionDetails.text || 'JS execution error';
      return JSON.stringify({ error: errMsg.slice(0, 2000) });
    }
    const val = result.value;
    const str = typeof val === 'string' ? val : JSON.stringify(val);
    return (str ?? 'undefined').slice(0, 6000);
  },
});

register({
  def: {
    type: 'function', name: 'get_page_html', description: 'Get HTML of the page or a specific element (max 8000 chars).',
    parameters: { type: 'object', properties: { selector: { type: 'string', description: 'Optional CSS selector' } }, required: [] },
  },
  async run(args, ctx) {
    const sel = args.selector ? String(args.selector).replace(/'/g, "\\'") : '';
    const expr = sel
      ? `(document.querySelector('${sel}')?.outerHTML || 'Not found').slice(0, 8000)`
      : `document.body?.innerHTML?.slice(0, 8000) || ''`;
    const { result } = await ctx.cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return JSON.stringify({ html: (result.value as string).slice(0, 8000) });
  },
});

register({
  def: {
    type: 'function', name: 'list_tabs', description: 'List all open browser tabs with their index, title, and URL. Use the index with switch_tab to change which tab the agent operates on.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  async run(_args, ctx) {
    const pages = ctx.getPages();
    const tabs = await Promise.all(pages.map(async (p, i) => {
      let title = '';
      try { title = await p.title(); } catch {}
      return { index: i, title, url: p.url() };
    }));
    return JSON.stringify({ count: tabs.length, tabs });
  },
});

register({
  def: {
    type: 'function', name: 'switch_tab', description: 'Switch to a different browser tab by index (from list_tabs). Visually brings the tab to the front AND changes which tab the agent operates on.',
    parameters: { type: 'object', properties: {
      index: { type: 'string', description: 'Tab index number from list_tabs' },
    }, required: ['index'] },
  },
  async run(args, ctx) {
    const index = parseInt(String(args.index), 10);
    const pages = ctx.getPages();
    if (index < 0 || index >= pages.length) {
      return JSON.stringify({ error: `Invalid tab index ${index}. Use list_tabs to see available tabs.` });
    }
    const page = pages[index];
    await ctx.setActivePage(page);
    // Visually bring the tab to front
    await page.bringToFront();
    let title = '';
    try { title = await page.title(); } catch {}
    return JSON.stringify({ success: true, index, title, url: page.url() });
  },
});

register({
  def: {
    type: 'function', name: 'run_script',
    description: `Execute a Node.js script on the local machine. Use this for:
- Complex data processing that can't be done in the browser
- File I/O (reading/writing files)
- Running shell commands via child_process
- Making HTTP/API requests (fetch is available)
- Any computation that needs full Node.js capabilities

The script auto-detects ESM vs CJS:
- If your code uses \`require(...)\`, \`module.exports\`, or \`__dirname\`/\`__filename\`, it runs as CommonJS — write idiomatic CJS.
- Otherwise it runs as ESM — use \`import\` (or \`await import(...)\`); top-level \`await\` is supported.

stdout is captured and returned. Use console.log() for output. Timeout 30s, output capped at ~6KB.`,
    parameters: { type: 'object', properties: {
      code: { type: 'string', description: 'Node.js JavaScript code. Use console.log() for output. Top-level await is supported in ESM mode.' },
    }, required: ['code'] },
  },
  async run(args, _ctx) {
    const code = String(args.code);
    const fs = await import('fs');
    const path = await import('path');
    const { execSync } = await import('child_process');

    // Pick CJS if the code clearly uses CJS-only constructs; else ESM.
    // We check at word boundaries to avoid false positives in strings.
    const looksCjs =
      /\brequire\s*\(/.test(code) ||
      /\bmodule\.exports\b/.test(code) ||
      /\bexports\.[A-Za-z_$]/.test(code) ||
      /\b__dirname\b/.test(code) ||
      /\b__filename\b/.test(code);
    const ext = looksCjs ? 'cjs' : 'mjs';

    const tmpFile = path.join(process.cwd(), `.browseragent-script-${Date.now()}.${ext}`);
    try {
      fs.writeFileSync(tmpFile, code, 'utf8');
      const output = execSync(`node "${tmpFile}"`, {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        cwd: process.cwd(),
      });
      return output.slice(0, 6000) || '(no output)';
    } catch (err: unknown) {
      const e = err as { stderr?: string; stdout?: string; message?: string };
      return JSON.stringify({
        error: (e.stderr || e.message || String(err)).slice(0, 2000),
        stdout: (e.stdout || '').slice(0, 1000),
        mode: ext,
      });
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  },
});

register({
  def: {
    type: 'function', name: 'press_key',
    description: 'Press a keyboard key or key combination in the browser. Useful for keyboard shortcuts, Enter to submit, Escape to close, arrow keys, etc.',
    parameters: { type: 'object', properties: {
      key: { type: 'string', description: 'Key to press: Enter, Escape, Tab, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Backspace, Delete, or any character. For combos: Control+a, Alt+F4, etc.' },
    }, required: ['key'] },
  },
  async run(args, ctx) {
    const key = String(args.key);
    // Handle key combos like Control+a
    const parts = key.split('+');
    const modifiers = [];
    let mainKey = parts[parts.length - 1];

    for (let i = 0; i < parts.length - 1; i++) {
      const mod = parts[i].toLowerCase();
      if (mod === 'control' || mod === 'ctrl') modifiers.push('control');
      else if (mod === 'alt') modifiers.push('alt');
      else if (mod === 'shift') modifiers.push('shift');
      else if (mod === 'meta' || mod === 'cmd') modifiers.push('meta');
    }

    // Map common key names to CDP key codes
    const keyMap: Record<string, { key: string; code: string; keyCode: number }> = {
      'enter': { key: 'Enter', code: 'Enter', keyCode: 13 },
      'escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
      'esc': { key: 'Escape', code: 'Escape', keyCode: 27 },
      'tab': { key: 'Tab', code: 'Tab', keyCode: 9 },
      'backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
      'delete': { key: 'Delete', code: 'Delete', keyCode: 46 },
      'arrowup': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
      'arrowdown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
      'arrowleft': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
      'arrowright': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
      'space': { key: ' ', code: 'Space', keyCode: 32 },
    };

    const mapped = keyMap[mainKey.toLowerCase()] || { key: mainKey, code: `Key${mainKey.toUpperCase()}`, keyCode: mainKey.charCodeAt(0) };
    const modFlag = modifiers.reduce((n, m) => n | ({ control: 2, alt: 1, shift: 8, meta: 4 }[m] || 0), 0);

    await ctx.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: mapped.key,
      code: mapped.code,
      windowsVirtualKeyCode: mapped.keyCode,
      modifiers: modFlag,
    } as any);
    await ctx.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: mapped.key,
      code: mapped.code,
      windowsVirtualKeyCode: mapped.keyCode,
      modifiers: modFlag,
    } as any);

    return JSON.stringify({ success: true, key });
  },
});

// ── Tier 1: core flow enablers ─────────────────────────────────────────────

register({
  def: {
    type: 'function', name: 'close_tab',
    description: 'Close a browser tab. Defaults to closing the currently active tab. Pass index to close a specific tab from list_tabs.',
    parameters: { type: 'object', properties: {
      index: { type: 'string', description: 'Optional tab index from list_tabs. If omitted, closes the active tab.' },
    }, required: [] },
  },
  async run(args, ctx) {
    const pages = ctx.getPages();
    if (pages.length === 0) return JSON.stringify({ error: 'No tabs open' });
    let target: Page;
    let idx: number;
    if (args.index !== undefined && String(args.index).length > 0) {
      idx = parseInt(String(args.index), 10);
      if (idx < 0 || idx >= pages.length) return JSON.stringify({ error: `Invalid tab index ${idx}. Use list_tabs.` });
      target = pages[idx];
    } else {
      // Active page = page that owns ctx.cdp; fall back to first.
      target = pages[0];
      idx = 0;
      // Try to identify active page by URL match against cdp target.
      try {
        const { targetInfo } = await ctx.cdp.send('Target.getTargetInfo' as any) as any;
        const activeUrl = targetInfo?.url;
        const found = pages.findIndex((p) => p.url() === activeUrl);
        if (found >= 0) { target = pages[found]; idx = found; }
      } catch {}
    }
    let closedTitle = '';
    try { closedTitle = await target.title(); } catch {}
    const closedUrl = target.url();
    await target.close().catch(() => {});
    // After close, switch active page to a remaining tab if we just closed the active one.
    const remaining = ctx.getPages();
    if (remaining.length > 0) {
      await ctx.setActivePage(remaining[Math.min(idx, remaining.length - 1)]);
    }
    return JSON.stringify({ success: true, closed: { index: idx, title: closedTitle, url: closedUrl }, remaining: remaining.length });
  },
});

register({
  def: {
    type: 'function', name: 'new_tab',
    description: 'Open a new browser tab. Optionally navigate it to a URL. Optionally keep current tab focused (switch=false).',
    parameters: { type: 'object', properties: {
      url: { type: 'string', description: 'Optional URL to load in the new tab' },
      switch: { type: 'string', description: '"false" to keep current tab as the active one (default: "true" — switch to new tab)' },
    }, required: [] },
  },
  async run(args, ctx) {
    const url = args.url ? String(args.url) : 'about:blank';
    const doSwitch = String(args.switch ?? 'true') !== 'false';
    const context = ctx.browser.contexts()[0];
    const page = await context.newPage();
    if (url !== 'about:blank') {
      await page.goto(url, { waitUntil: 'load', timeout: 15_000 }).catch(() => {});
    }
    if (doSwitch) await ctx.setActivePage(page);
    let title = '';
    try { title = await page.title(); } catch {}
    return JSON.stringify({ success: true, url: page.url(), title, switched: doSwitch });
  },
});

register({
  def: {
    type: 'function', name: 'wait_for',
    description: 'Wait for a condition before proceeding. One of: a CSS selector to appear, a URL substring to match, network-idle, or a fixed delay. Returns when condition is met or timeout (default 10s).',
    parameters: { type: 'object', properties: {
      selector: { type: 'string', description: 'CSS selector to wait for' },
      url_contains: { type: 'string', description: 'Wait until current URL contains this substring' },
      network_idle: { type: 'string', description: '"true" to wait for network idle (no requests for ~500ms)' },
      ms: { type: 'string', description: 'Fixed delay in milliseconds' },
      timeout_ms: { type: 'string', description: 'Max wait time (default 10000)' },
    }, required: [] },
  },
  async run(args, ctx) {
    const timeout = parseInt(String(args.timeout_ms ?? '10000'), 10);
    if (args.ms !== undefined) {
      const ms = Math.min(parseInt(String(args.ms), 10), 60_000);
      await new Promise((r) => setTimeout(r, ms));
      return JSON.stringify({ success: true, waited_ms: ms });
    }
    if (args.selector) {
      const sel = String(args.selector);
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const { result } = await ctx.cdp.send('Runtime.evaluate', {
          expression: `!!document.querySelector(${JSON.stringify(sel)})`,
          returnByValue: true,
        });
        if (result?.value) return JSON.stringify({ success: true, condition: 'selector', selector: sel, elapsed_ms: Date.now() - start });
        await new Promise((r) => setTimeout(r, 150));
      }
      return JSON.stringify({ error: `Timeout waiting for selector ${sel}`, timeout_ms: timeout });
    }
    if (args.url_contains) {
      const needle = String(args.url_contains);
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const { result } = await ctx.cdp.send('Runtime.evaluate', {
          expression: 'location.href', returnByValue: true,
        });
        if (String(result?.value || '').includes(needle)) {
          return JSON.stringify({ success: true, condition: 'url_contains', url: result.value, elapsed_ms: Date.now() - start });
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      return JSON.stringify({ error: `Timeout waiting for url containing ${needle}`, timeout_ms: timeout });
    }
    if (String(args.network_idle ?? '') === 'true') {
      // Poll the page's performance API for in-flight resources rather than
      // attaching CDP listeners — Playwright's CDPSession misbehaves when we
      // attach/detach Network listeners (subsequent events stop firing).
      const start = Date.now();
      let lastCount = -1;
      let stableSince = Date.now();
      while (Date.now() - start < timeout) {
        await new Promise((r) => setTimeout(r, 200));
        const { result } = await ctx.cdp.send('Runtime.evaluate', {
          expression: '(() => performance.getEntriesByType("resource").length)()',
          returnByValue: true,
        });
        const count = Number(result?.value ?? 0);
        if (count !== lastCount) {
          lastCount = count;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= 500) {
          return JSON.stringify({ success: true, condition: 'network_idle', resource_count: count, elapsed_ms: Date.now() - start });
        }
      }
      return JSON.stringify({ error: 'Timeout waiting for network idle', timeout_ms: timeout });
    }
    return JSON.stringify({ error: 'wait_for requires one of: selector, url_contains, network_idle, ms' });
  },
});

register({
  def: {
    type: 'function', name: 'scroll',
    description: 'Scroll the page or an element. Modes: "to" (scroll a selector into view), "by" (scroll by pixels), "to_end" (scroll to bottom; supports infinite-scroll loops with max_steps).',
    parameters: { type: 'object', properties: {
      mode: { type: 'string', description: 'one of: to | by | to_end' },
      selector: { type: 'string', description: 'For mode=to: element to scroll into view' },
      x: { type: 'string', description: 'For mode=by: horizontal pixels (default 0)' },
      y: { type: 'string', description: 'For mode=by: vertical pixels (positive = down)' },
      max_steps: { type: 'string', description: 'For mode=to_end: max scroll iterations for infinite-scroll pages (default 10)' },
      step_ms: { type: 'string', description: 'For mode=to_end: pause between scrolls (default 600)' },
    }, required: ['mode'] },
  },
  async run(args, ctx) {
    const mode = String(args.mode);
    if (mode === 'to') {
      const sel = String(args.selector || '');
      if (!sel) return JSON.stringify({ error: 'selector required for mode=to' });
      const code = `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return { error: 'not found' }; el.scrollIntoView({ behavior: 'instant', block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`;
      const { result } = await ctx.cdp.send('Runtime.evaluate', { expression: code, returnByValue: true });
      return JSON.stringify({ success: !result?.value?.error, result: result?.value });
    }
    if (mode === 'by') {
      const x = parseInt(String(args.x ?? '0'), 10);
      const y = parseInt(String(args.y ?? '0'), 10);
      const code = `(() => { window.scrollBy(${x}, ${y}); return { scrollX: window.scrollX, scrollY: window.scrollY }; })()`;
      const { result } = await ctx.cdp.send('Runtime.evaluate', { expression: code, returnByValue: true });
      return JSON.stringify({ success: true, ...result?.value });
    }
    if (mode === 'to_end') {
      const maxSteps = parseInt(String(args.max_steps ?? '10'), 10);
      const stepMs = parseInt(String(args.step_ms ?? '600'), 10);
      let lastH = 0;
      let stableCount = 0;
      for (let i = 0; i < maxSteps; i++) {
        const { result } = await ctx.cdp.send('Runtime.evaluate', {
          expression: `(() => { window.scrollTo(0, document.body.scrollHeight); return document.body.scrollHeight; })()`,
          returnByValue: true,
        });
        const h = Number(result?.value || 0);
        if (h === lastH) {
          stableCount++;
          if (stableCount >= 2) return JSON.stringify({ success: true, steps: i + 1, final_height: h, reason: 'stable' });
        } else {
          stableCount = 0;
          lastH = h;
        }
        await new Promise((r) => setTimeout(r, stepMs));
      }
      return JSON.stringify({ success: true, steps: maxSteps, final_height: lastH, reason: 'max_steps' });
    }
    return JSON.stringify({ error: `Unknown mode: ${mode}` });
  },
});

register({
  def: {
    type: 'function', name: 'hover',
    description: 'Hover the mouse over an element by CSS selector. Reveals tooltips and fly-out menus that gate clicks.',
    parameters: { type: 'object', properties: {
      selector: { type: 'string', description: 'CSS selector' },
    }, required: ['selector'] },
  },
  async run(args, ctx) {
    const sel = String(args.selector);
    // Get center coords of the element in viewport.
    const code = `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`;
    const { result } = await ctx.cdp.send('Runtime.evaluate', { expression: code, returnByValue: true });
    const pt = result?.value as { x: number; y: number } | null;
    if (!pt) return JSON.stringify({ error: `Element not found: ${sel}` });
    await ctx.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none' } as any);
    // Tiny settle so hover-driven UI can render before subsequent steps.
    await new Promise((r) => setTimeout(r, 120));
    return JSON.stringify({ success: true, selector: sel, x: pt.x, y: pt.y });
  },
});

register({
  def: {
    type: 'function', name: 'select_option',
    description: 'Choose an option in a <select> dropdown. Match by value or visible label. Dispatches change/input events so frameworks (React/Vue) react.',
    parameters: { type: 'object', properties: {
      selector: { type: 'string', description: 'CSS selector for the <select>' },
      value: { type: 'string', description: 'Option value attribute to select' },
      label: { type: 'string', description: 'Visible option text to select (alternative to value)' },
    }, required: ['selector'] },
  },
  async run(args, ctx) {
    const sel = String(args.selector);
    const value = args.value !== undefined ? String(args.value) : null;
    const label = args.label !== undefined ? String(args.label) : null;
    if (value === null && label === null) return JSON.stringify({ error: 'Provide value or label' });
    const code = `(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el || el.tagName !== 'SELECT') return { error: 'Select element not found' };
      let chosen = null;
      for (const o of el.options) {
        if (${value === null ? 'false' : `o.value === ${JSON.stringify(value)}`}) { chosen = o; break; }
        if (${label === null ? 'false' : `o.text.trim() === ${JSON.stringify(label?.trim())}`}) { chosen = o; break; }
      }
      if (!chosen) return { error: 'No matching option', options: Array.from(el.options).map(o => ({ value: o.value, label: o.text })).slice(0, 50) };
      el.value = chosen.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true, value: chosen.value, label: chosen.text };
    })()`;
    const { result } = await ctx.cdp.send('Runtime.evaluate', { expression: code, returnByValue: true });
    return JSON.stringify(result?.value || { error: 'No result' });
  },
});

register({
  def: {
    type: 'function', name: 'find_visible_text',
    description: 'Find elements containing the given visible text (case-insensitive substring). Returns up to 10 matches with a stable CSS-path you can pass to click_element/fill_input. Use this when the user describes a control by what it says ("the Sign Up button"), not by its selector.',
    parameters: { type: 'object', properties: {
      text: { type: 'string', description: 'Text substring to search for' },
      tag: { type: 'string', description: 'Optional tag filter (e.g., button, a, input)' },
    }, required: ['text'] },
  },
  async run(args, ctx) {
    const needle = String(args.text);
    const tag = args.tag ? String(args.tag).toLowerCase() : null;
    const code = `(() => {
      const needle = ${JSON.stringify(needle.toLowerCase())};
      const tagFilter = ${tag ? JSON.stringify(tag) : 'null'};
      function cssPath(el) {
        if (!(el instanceof Element)) return '';
        const parts = [];
        let cur = el;
        while (cur && cur.nodeType === 1 && parts.length < 6) {
          let s = cur.tagName.toLowerCase();
          if (cur.id) { parts.unshift(s + '#' + CSS.escape(cur.id)); break; }
          let nth = 1, sib = cur.previousElementSibling;
          while (sib) { if (sib.tagName === cur.tagName) nth++; sib = sib.previousElementSibling; }
          parts.unshift(s + ':nth-of-type(' + nth + ')');
          cur = cur.parentElement;
        }
        return parts.join(' > ');
      }
      const all = document.querySelectorAll(tagFilter || '*');
      const out = [];
      for (const el of all) {
        if (out.length >= 10) break;
        if (tagFilter && el.tagName.toLowerCase() !== tagFilter) continue;
        const text = ((el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '') + '').trim();
        if (!text || text.length > 200) continue;
        if (!text.toLowerCase().includes(needle)) continue;
        // Filter to the deepest element that matches (skip ancestors that match because of children).
        let hasMatchingChild = false;
        for (const c of el.children) {
          const ct = ((c.innerText || c.value || '') + '').trim().toLowerCase();
          if (ct.includes(needle) && ct.length <= text.length) { hasMatchingChild = true; break; }
        }
        if (hasMatchingChild) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;  // hidden
        out.push({ tag: el.tagName.toLowerCase(), text: text.slice(0, 100), selector: cssPath(el), x: Math.round(r.x), y: Math.round(r.y) });
      }
      return out;
    })()`;
    const { result } = await ctx.cdp.send('Runtime.evaluate', { expression: code, returnByValue: true });
    const matches = result?.value || [];
    return JSON.stringify({ count: matches.length, matches });
  },
});

// ── Tier 2: persona unlocks (devtools, security, research, a11y) ───────────

// Per-CDP-session ring buffers for console + network. Installed lazily on first
// access. WeakMap keyed by CDP session so a tab switch (new session) starts fresh.
type ConsoleEntry = { ts: number; level: string; text: string; url?: string; line?: number };
type NetEntry = {
  ts: number;
  requestId: string;
  url: string;
  method: string;
  status?: number;
  statusText?: string;
  type?: string;
  duration_ms?: number;
  failed?: string;
};
const consoleBuffers = new WeakMap<CDPSession, ConsoleEntry[]>();
const networkBuffers = new WeakMap<CDPSession, Map<string, NetEntry>>();

function ensureConsoleBuffer(cdp: CDPSession): ConsoleEntry[] {
  let buf = consoleBuffers.get(cdp);
  if (buf) return buf;
  buf = [];
  consoleBuffers.set(cdp, buf);
  cdp.send('Runtime.enable').catch(() => {});
  cdp.send('Log.enable').catch(() => {});
  cdp.on('Runtime.consoleAPICalled' as any, (ev: any) => {
    const text = (ev.args || []).map((a: any) => {
      if (a.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
      if (a.description) return a.description;
      return a.type;
    }).join(' ');
    buf!.push({ ts: Date.now(), level: ev.type, text: text.slice(0, 500) });
    if (buf!.length > 500) buf!.shift();
  });
  cdp.on('Runtime.exceptionThrown' as any, (ev: any) => {
    const ex = ev.exceptionDetails;
    const text = ex?.exception?.description || ex?.text || 'exception';
    buf!.push({ ts: Date.now(), level: 'error', text: text.slice(0, 500), url: ex?.url || '', line: ex?.lineNumber });
    if (buf!.length > 500) buf!.shift();
  });
  cdp.on('Log.entryAdded' as any, (ev: any) => {
    const e = ev.entry;
    buf!.push({ ts: Date.now(), level: e.level, text: (e.text || '').slice(0, 500), url: e.url || '', line: e.lineNumber });
    if (buf!.length > 500) buf!.shift();
  });
  return buf;
}

function ensureNetworkBuffer(cdp: CDPSession): Map<string, NetEntry> {
  let buf = networkBuffers.get(cdp);
  if (buf) return buf;
  buf = new Map();
  networkBuffers.set(cdp, buf);
  // Attach listeners FIRST so we don't miss events that arrive between enable and on().
  cdp.on('Network.requestWillBeSent' as any, (ev: any) => {
    buf!.set(ev.requestId, {
      ts: Date.now(),
      requestId: ev.requestId,
      url: ev.request?.url || '',
      method: ev.request?.method || '',
      type: ev.type,
    });
    if (buf!.size > 300) {
      const firstKey = buf!.keys().next().value;
      if (firstKey) buf!.delete(firstKey);
    }
  });
  cdp.on('Network.responseReceived' as any, (ev: any) => {
    const e = buf!.get(ev.requestId);
    if (e) { e.status = ev.response?.status; e.statusText = ev.response?.statusText; }
  });
  cdp.on('Network.loadingFinished' as any, (ev: any) => {
    const e = buf!.get(ev.requestId);
    if (e) e.duration_ms = Date.now() - e.ts;
  });
  cdp.on('Network.loadingFailed' as any, (ev: any) => {
    const e = buf!.get(ev.requestId);
    if (e) { e.failed = ev.errorText || 'failed'; e.duration_ms = Date.now() - e.ts; }
  });
  cdp.send('Network.enable').catch(() => {});
  return buf;
}

register({
  def: {
    type: 'function', name: 'get_console_logs',
    description: 'Read recent console messages (log, info, warn, error) and uncaught exceptions from the active tab. The buffer starts capturing the first time this tool is called on a tab — call once early in a session, then again to read since-last-call.',
    parameters: { type: 'object', properties: {
      level: { type: 'string', description: 'Filter by level: log, info, warn, error (comma-separated for multiple). Default: all.' },
      limit: { type: 'string', description: 'Max entries to return (default 50)' },
      since_ms: { type: 'string', description: 'Only return entries newer than this many ms ago' },
    }, required: [] },
  },
  async run(args, ctx) {
    const buf = ensureConsoleBuffer(ctx.cdp);
    const limit = parseInt(String(args.limit ?? '50'), 10);
    const sinceMs = args.since_ms ? Date.now() - parseInt(String(args.since_ms), 10) : 0;
    const levels = args.level ? String(args.level).split(',').map((s) => s.trim()) : null;
    const filtered = buf.filter((e) => {
      if (sinceMs && e.ts < sinceMs) return false;
      if (levels && !levels.includes(e.level)) return false;
      return true;
    });
    const slice = filtered.slice(-limit);
    return JSON.stringify({ count: slice.length, total_buffered: buf.length, entries: slice });
  },
});

register({
  def: {
    type: 'function', name: 'get_network_requests',
    description: 'List recent HTTP requests captured from the active tab (method, URL, status, duration). The buffer starts capturing the first time this tool is called on a tab. Use filter to narrow by URL substring.',
    parameters: { type: 'object', properties: {
      filter: { type: 'string', description: 'Substring filter on URL' },
      method: { type: 'string', description: 'Filter by HTTP method (GET, POST, etc.)' },
      status: { type: 'string', description: 'Filter by status: 2xx, 3xx, 4xx, 5xx, or specific code' },
      limit: { type: 'string', description: 'Max entries (default 50)' },
      since_ms: { type: 'string', description: 'Only requests newer than this many ms ago' },
    }, required: [] },
  },
  async run(args, ctx) {
    const buf = ensureNetworkBuffer(ctx.cdp);
    const limit = parseInt(String(args.limit ?? '50'), 10);
    const filter = args.filter ? String(args.filter).toLowerCase() : null;
    const method = args.method ? String(args.method).toUpperCase() : null;
    const sinceMs = args.since_ms ? Date.now() - parseInt(String(args.since_ms), 10) : 0;
    const statusFilter = args.status ? String(args.status) : null;
    const all = Array.from(buf.values());
    const filtered = all.filter((e) => {
      if (sinceMs && e.ts < sinceMs) return false;
      if (filter && !e.url.toLowerCase().includes(filter)) return false;
      if (method && e.method !== method) return false;
      if (statusFilter) {
        if (statusFilter.endsWith('xx')) {
          const cls = parseInt(statusFilter[0], 10);
          if (!e.status || Math.floor(e.status / 100) !== cls) return false;
        } else if (String(e.status) !== statusFilter) return false;
      }
      return true;
    });
    const slice = filtered.slice(-limit);
    return JSON.stringify({ count: slice.length, total_buffered: buf.size, requests: slice });
  },
});

register({
  def: {
    type: 'function', name: 'get_cookies',
    description: 'Read cookies for the active tab (or a specific URL). Use for auth/session debugging. Note: HttpOnly cookies are visible via CDP.',
    parameters: { type: 'object', properties: {
      url: { type: 'string', description: 'Optional URL to filter cookies for. Default: current page URL.' },
    }, required: [] },
  },
  async run(args, ctx) {
    let urls: string[] | undefined = undefined;
    if (args.url) urls = [String(args.url)];
    else {
      try {
        const { result } = await ctx.cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
        if (result?.value) urls = [String(result.value)];
      } catch {}
    }
    const res = await ctx.cdp.send('Network.getCookies', urls ? { urls } : {} as any) as any;
    const cookies = (res.cookies || []).map((c: any) => ({
      name: c.name, value: c.value.length > 80 ? c.value.slice(0, 80) + '…' : c.value,
      domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
      expires: c.expires > 0 ? new Date(c.expires * 1000).toISOString() : 'session',
    }));
    return JSON.stringify({ count: cookies.length, cookies });
  },
});

register({
  def: {
    type: 'function', name: 'download_file',
    description: 'Download a URL to the local machine. Returns the saved file path. Use for PDFs, images, archives, etc.',
    parameters: { type: 'object', properties: {
      url: { type: 'string', description: 'URL to download' },
      filename: { type: 'string', description: 'Optional filename. Defaults to the URL basename.' },
      dir: { type: 'string', description: 'Optional directory. Defaults to OS Downloads folder.' },
    }, required: ['url'] },
  },
  async run(args) {
    const url = String(args.url);
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const dir = args.dir ? String(args.dir) : path.join(os.homedir(), 'Downloads');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    let filename = args.filename ? String(args.filename) : '';
    if (!filename) {
      try { filename = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || 'download'); } catch { filename = 'download'; }
    }
    const dest = path.join(dir, filename);
    const res = await fetch(url);
    if (!res.ok) return JSON.stringify({ error: `HTTP ${res.status} ${res.statusText}`, url });
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    return JSON.stringify({ success: true, path: dest, size: buf.length, content_type: res.headers.get('content-type') });
  },
});

register({
  def: {
    type: 'function', name: 'upload_file',
    description: 'Attach a local file to a file <input> element by CSS selector. Use for upload forms (job applications, support tickets, CMS).',
    parameters: { type: 'object', properties: {
      selector: { type: 'string', description: 'CSS selector for the <input type="file">' },
      path: { type: 'string', description: 'Absolute local file path to upload' },
    }, required: ['selector', 'path'] },
  },
  async run(args, ctx) {
    const selector = String(args.selector);
    const filePath = String(args.path);
    const fs = await import('fs');
    if (!fs.existsSync(filePath)) return JSON.stringify({ error: `File not found: ${filePath}` });
    // Resolve the input node via CDP, then setFileInputFiles on it.
    const doc: any = await ctx.cdp.send('DOM.getDocument', { depth: -1 } as any);
    const found: any = await ctx.cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector } as any);
    if (!found?.nodeId) return JSON.stringify({ error: `Element not found: ${selector}` });
    await ctx.cdp.send('DOM.setFileInputFiles' as any, { files: [filePath], nodeId: found.nodeId } as any);
    return JSON.stringify({ success: true, selector, path: filePath });
  },
});

register({
  def: {
    type: 'function', name: 'get_event_listeners',
    description: 'List the event listeners attached to a DOM element (click, input, etc.). Useful for debugging "why isn\'t this clickable" questions. Only available via CDP — cannot be done from page JS.',
    parameters: { type: 'object', properties: {
      selector: { type: 'string', description: 'CSS selector' },
    }, required: ['selector'] },
  },
  async run(args, ctx) {
    const selector = String(args.selector);
    const evalRes: any = await ctx.cdp.send('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
      objectGroup: 'event-listeners-tool',
    });
    if (!evalRes?.result?.objectId) return JSON.stringify({ error: `Element not found: ${selector}` });
    try {
      const listeners: any = await ctx.cdp.send('DOMDebugger.getEventListeners' as any, {
        objectId: evalRes.result.objectId, depth: 1, pierce: true,
      } as any);
      const out = (listeners.listeners || []).map((l: any) => ({
        type: l.type, useCapture: l.useCapture, passive: l.passive, once: l.once,
        scriptUrl: l.scriptId ? `script#${l.scriptId}` : undefined,
        line: l.lineNumber, column: l.columnNumber,
      }));
      return JSON.stringify({ count: out.length, listeners: out });
    } finally {
      try { await ctx.cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'event-listeners-tool' } as any); } catch {}
    }
  },
});

register({
  def: {
    type: 'function', name: 'accessibility_snapshot',
    description: 'Get a structured accessibility tree of the page (or a subtree under a selector). Compact, semantic representation — preferred for understanding page structure quickly. Returns role/name/value/state for each node.',
    parameters: { type: 'object', properties: {
      selector: { type: 'string', description: 'Optional CSS selector to root the snapshot at' },
      max_nodes: { type: 'string', description: 'Cap (default 200)' },
    }, required: [] },
  },
  async run(args, ctx) {
    const max = parseInt(String(args.max_nodes ?? '200'), 10);
    let nodes: any[] = [];
    try {
      await ctx.cdp.send('Accessibility.enable').catch(() => {});
      if (args.selector) {
        const evalRes: any = await ctx.cdp.send('Runtime.evaluate', {
          expression: `document.querySelector(${JSON.stringify(String(args.selector))})`,
          objectGroup: 'a11y-tool',
        });
        if (!evalRes?.result?.objectId) return JSON.stringify({ error: `Element not found: ${args.selector}` });
        const res: any = await ctx.cdp.send('Accessibility.getPartialAXTree' as any, {
          objectId: evalRes.result.objectId, fetchRelatives: true,
        } as any);
        nodes = res.nodes || [];
        try { await ctx.cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'a11y-tool' } as any); } catch {}
      } else {
        const res: any = await ctx.cdp.send('Accessibility.getFullAXTree' as any, { max_depth: 10 } as any);
        nodes = res.nodes || [];
      }
    } catch (e: any) {
      return JSON.stringify({ error: String(e?.message || e) });
    }
    const compact = nodes.slice(0, max).map((n) => ({
      role: n.role?.value,
      name: n.name?.value,
      value: n.value?.value,
      description: n.description?.value,
      ignored: n.ignored || undefined,
      properties: (n.properties || []).reduce((acc: any, p: any) => { acc[p.name] = p.value?.value; return acc; }, {} as any),
    })).filter((n) => n.role || n.name);
    return JSON.stringify({ count: compact.length, total: nodes.length, nodes: compact });
  },
});

// ── Tier 3: high-value, narrower scope ─────────────────────────────────────

register({
  def: {
    type: 'function', name: 'get_storage',
    description: 'Inspect the active page\'s storage: localStorage, sessionStorage, and a summary of IndexedDB databases. Useful for auth/state debugging.',
    parameters: { type: 'object', properties: {
      kind: { type: 'string', description: 'Filter to one of: local, session, indexeddb, all (default all)' },
    }, required: [] },
  },
  async run(args, ctx) {
    const kind = String(args.kind ?? 'all');
    const code = `(async () => {
      const out = {};
      const want = ${JSON.stringify(kind)};
      function dump(s) {
        const o = {};
        try {
          for (let i = 0; i < s.length; i++) {
            const k = s.key(i); if (k === null) continue;
            const v = s.getItem(k) || '';
            o[k] = v.length > 200 ? v.slice(0, 200) + '…' : v;
          }
        } catch (e) { return { error: String(e) }; }
        return o;
      }
      if (want === 'all' || want === 'local') out.localStorage = dump(localStorage);
      if (want === 'all' || want === 'session') out.sessionStorage = dump(sessionStorage);
      if (want === 'all' || want === 'indexeddb') {
        try {
          const dbs = await indexedDB.databases();
          out.indexedDB = dbs.map(d => ({ name: d.name, version: d.version }));
        } catch (e) { out.indexedDB = { error: String(e) }; }
      }
      return out;
    })()`;
    const { result, exceptionDetails } = await ctx.cdp.send('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) return JSON.stringify({ error: exceptionDetails.exception?.description || exceptionDetails.text });
    return JSON.stringify(result?.value || {});
  },
});

register({
  def: {
    type: 'function', name: 'replay_request',
    description: 'Re-fire an HTTP request from the active page context with custom method/headers/body. Useful for API debugging — tweak an Authorization header, change a payload, retry an endpoint. Runs as fetch() in the page so cookies & origin are preserved.',
    parameters: { type: 'object', properties: {
      url: { type: 'string', description: 'Request URL' },
      method: { type: 'string', description: 'HTTP method (default GET)' },
      headers: { type: 'string', description: 'JSON object of headers' },
      body: { type: 'string', description: 'Request body (string)' },
      include_response: { type: 'string', description: '"true" to include response body (truncated to 4000 chars)' },
    }, required: ['url'] },
  },
  async run(args, ctx) {
    const url = String(args.url);
    const method = String(args.method ?? 'GET');
    const headers = args.headers ? String(args.headers) : '{}';
    const body = args.body !== undefined ? String(args.body) : null;
    const includeBody = String(args.include_response ?? 'true') !== 'false';
    const code = `(async () => {
      try {
        const t0 = performance.now();
        const init = { method: ${JSON.stringify(method)}, headers: ${headers} };
        ${body !== null ? `init.body = ${JSON.stringify(body)};` : ''}
        const r = await fetch(${JSON.stringify(url)}, init);
        const t1 = performance.now();
        const headerObj = {}; r.headers.forEach((v, k) => headerObj[k] = v);
        let txt = '';
        if (${includeBody}) {
          txt = await r.text().catch(() => '');
          if (txt.length > 4000) txt = txt.slice(0, 4000) + '…';
        }
        return { status: r.status, statusText: r.statusText, ok: r.ok, duration_ms: Math.round(t1 - t0), headers: headerObj, body: txt };
      } catch (e) { return { error: String(e) }; }
    })()`;
    const { result, exceptionDetails } = await ctx.cdp.send('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) return JSON.stringify({ error: exceptionDetails.exception?.description || exceptionDetails.text });
    return JSON.stringify(result?.value || { error: 'No result' });
  },
});

register({
  def: {
    type: 'function', name: 'set_viewport',
    description: 'Override the viewport dimensions and device pixel ratio (responsive testing, mobile emulation). Pass reset=true to clear the override.',
    parameters: { type: 'object', properties: {
      width: { type: 'string', description: 'Viewport width in px' },
      height: { type: 'string', description: 'Viewport height in px' },
      device_scale_factor: { type: 'string', description: 'Device pixel ratio (default 1)' },
      mobile: { type: 'string', description: '"true" to emulate mobile (touch events, viewport scaling)' },
      reset: { type: 'string', description: '"true" to clear the override' },
    }, required: [] },
  },
  async run(args, ctx) {
    if (String(args.reset ?? '') === 'true') {
      await ctx.cdp.send('Emulation.clearDeviceMetricsOverride' as any).catch(() => {});
      return JSON.stringify({ success: true, reset: true });
    }
    const width = parseInt(String(args.width ?? '1280'), 10);
    const height = parseInt(String(args.height ?? '800'), 10);
    const dsf = parseFloat(String(args.device_scale_factor ?? '1'));
    const mobile = String(args.mobile ?? '') === 'true';
    await ctx.cdp.send('Emulation.setDeviceMetricsOverride' as any, {
      width, height, deviceScaleFactor: dsf, mobile,
    } as any);
    return JSON.stringify({ success: true, width, height, device_scale_factor: dsf, mobile });
  },
});

register({
  def: {
    type: 'function', name: 'pdf_export',
    description: 'Export the active page as a PDF file saved locally. Returns the saved path.',
    parameters: { type: 'object', properties: {
      filename: { type: 'string', description: 'Optional filename (default: page-title.pdf)' },
      dir: { type: 'string', description: 'Optional directory (default: OS Downloads folder)' },
      landscape: { type: 'string', description: '"true" for landscape orientation' },
    }, required: [] },
  },
  async run(args, ctx) {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const dir = args.dir ? String(args.dir) : path.join(os.homedir(), 'Downloads');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    let filename = args.filename ? String(args.filename) : '';
    if (!filename) {
      try {
        const { result } = await ctx.cdp.send('Runtime.evaluate', { expression: 'document.title || "page"', returnByValue: true });
        filename = String(result?.value || 'page').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) + '.pdf';
      } catch { filename = 'page.pdf'; }
    }
    if (!filename.toLowerCase().endsWith('.pdf')) filename += '.pdf';
    const dest = path.join(dir, filename);
    const res: any = await ctx.cdp.send('Page.printToPDF' as any, {
      landscape: String(args.landscape ?? '') === 'true',
      printBackground: true,
    } as any);
    const buf = Buffer.from(res.data, 'base64');
    fs.writeFileSync(dest, buf);
    return JSON.stringify({ success: true, path: dest, size: buf.length });
  },
});

register({
  def: {
    type: 'function', name: 'set_cookie',
    description: 'Set a cookie. Use for security testing or session manipulation. Required: name, value, url (or domain).',
    parameters: { type: 'object', properties: {
      name: { type: 'string', description: 'Cookie name' },
      value: { type: 'string', description: 'Cookie value' },
      url: { type: 'string', description: 'URL associated with the cookie (sets domain/path/secure automatically)' },
      domain: { type: 'string', description: 'Cookie domain (alternative to url)' },
      path: { type: 'string', description: 'Cookie path (default /)' },
      secure: { type: 'string', description: '"true" for Secure flag' },
      http_only: { type: 'string', description: '"true" for HttpOnly flag' },
      same_site: { type: 'string', description: 'Strict | Lax | None' },
      expires_sec: { type: 'string', description: 'Unix timestamp seconds (omit for session cookie)' },
    }, required: ['name', 'value'] },
  },
  async run(args, ctx) {
    const params: any = {
      name: String(args.name),
      value: String(args.value),
      path: args.path ? String(args.path) : '/',
    };
    if (args.url) params.url = String(args.url);
    if (args.domain) params.domain = String(args.domain);
    if (args.secure) params.secure = String(args.secure) === 'true';
    if (args.http_only) params.httpOnly = String(args.http_only) === 'true';
    if (args.same_site) params.sameSite = String(args.same_site);
    if (args.expires_sec) params.expires = parseInt(String(args.expires_sec), 10);
    if (!params.url && !params.domain) {
      // Default to current page URL
      try {
        const { result } = await ctx.cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
        if (result?.value) params.url = String(result.value);
      } catch {}
    }
    const res: any = await ctx.cdp.send('Network.setCookie', params);
    return JSON.stringify({ success: !!res?.success, ...params });
  },
});

// ── Disk: sandboxed data root ─────────────────────────────────────────────
//
// All paths are relative to ~/.browy/data/files/. The agent CANNOT escape
// this root via "../" or absolute paths (validated in data-root.ts).
// For arbitrary filesystem access, the user has run_script (Node).

import {
  saveFile as _saveFile, readFile as _readFile, listFiles as _listFiles, deleteFile as _deleteFile,
  noteSet as _noteSet, noteGet as _noteGet, noteList as _noteList, noteDelete as _noteDelete,
  DATA_ROOT, FILES_DIR,
} from '../data-root.js';

register({
  def: {
    type: 'function', name: 'save_file',
    description: `Save a file to Browy's persistent scratch disk at ~/.browy/data/files/. Use this for: caching extracted data, saving downloaded content for later, persisting work-in-progress between turns. Filename is RELATIVE to the data root (no absolute paths, no "../"). Subdirectories are auto-created. Use encoding="base64" for binary files.`,
    parameters: { type: 'object', properties: {
      filename: { type: 'string', description: 'Relative path inside ~/.browy/data/files/ (e.g. "scrape/results.json", "screenshots/page1.png").' },
      content: { type: 'string', description: 'File content (utf8 text by default; pass base64-encoded data with encoding="base64" for binary).' },
      encoding: { type: 'string', description: '"utf8" (default) or "base64"' },
    }, required: ['filename', 'content'] },
  },
  async run(args) {
    const enc = args.encoding === 'base64' ? 'base64' : 'utf8';
    const r = _saveFile(String(args.filename), String(args.content), enc);
    return JSON.stringify({ success: true, ...r, root: FILES_DIR });
  },
});

register({
  def: {
    type: 'function', name: 'read_file',
    description: `Read a file from Browy's scratch disk (~/.browy/data/files/). Returns content as utf8 text by default; pass encoding="base64" for binary files. Path is RELATIVE to the data root.`,
    parameters: { type: 'object', properties: {
      filename: { type: 'string', description: 'Relative path inside ~/.browy/data/files/.' },
      encoding: { type: 'string', description: '"utf8" (default) or "base64"' },
    }, required: ['filename'] },
  },
  async run(args) {
    try {
      const enc = args.encoding === 'base64' ? 'base64' : 'utf8';
      const r = _readFile(String(args.filename), enc);
      return JSON.stringify(r);
    } catch (e) {
      return JSON.stringify({ error: String((e as Error).message || e) });
    }
  },
});

register({
  def: {
    type: 'function', name: 'list_files',
    description: `List files in Browy's scratch disk (~/.browy/data/files/), optionally filtered by a path prefix. Returns up to 500 entries with size and modified timestamp. Use this to find previously-saved work between turns/sessions.`,
    parameters: { type: 'object', properties: {
      prefix: { type: 'string', description: 'Optional subdirectory prefix to limit the listing.' },
    }, required: [] },
  },
  async run(args) {
    try {
      const entries = _listFiles(args.prefix ? String(args.prefix) : undefined);
      return JSON.stringify({ root: FILES_DIR, count: entries.length, entries });
    } catch (e) {
      return JSON.stringify({ error: String((e as Error).message || e) });
    }
  },
});

register({
  def: {
    type: 'function', name: 'delete_file',
    description: `Delete a file from ~/.browy/data/files/. Recursively deletes if it's a directory. Use cautiously.`,
    parameters: { type: 'object', properties: {
      filename: { type: 'string', description: 'Relative path inside ~/.browy/data/files/.' },
    }, required: ['filename'] },
  },
  async run(args) {
    try { return JSON.stringify(_deleteFile(String(args.filename))); }
    catch (e) { return JSON.stringify({ error: String((e as Error).message || e) }); }
  },
});

// ── Notes: persistent key-value memory ────────────────────────────────────

register({
  def: {
    type: 'function', name: 'note_set',
    description: `Persist a small piece of structured memory under a key (stored in ~/.browy/data/notes.json). Use for: user preferences, todos, facts learned across sessions, intermediate results that fit in <4KB. Keys are unique — same key overwrites. Optional category lets you group related notes.`,
    parameters: { type: 'object', properties: {
      key: { type: 'string', description: 'Unique key (e.g. "user.preferred_browser", "todo.fix-css").' },
      value: { type: 'string', description: 'String value (JSON-stringify objects yourself if you need structure).' },
      category: { type: 'string', description: 'Optional grouping (e.g. "todo", "preference", "fact").' },
    }, required: ['key', 'value'] },
  },
  async run(args) {
    try { return JSON.stringify(_noteSet(String(args.key), String(args.value), args.category ? String(args.category) : undefined)); }
    catch (e) { return JSON.stringify({ error: String((e as Error).message || e) }); }
  },
});

register({
  def: {
    type: 'function', name: 'note_get',
    description: `Retrieve a note by key. Returns { key, value, updated, category } or value:null if missing.`,
    parameters: { type: 'object', properties: {
      key: { type: 'string', description: 'The note key.' },
    }, required: ['key'] },
  },
  async run(args) { return JSON.stringify(_noteGet(String(args.key))); },
});

register({
  def: {
    type: 'function', name: 'note_list',
    description: `List all notes (newest first), optionally filtered by category. Returns key, 100-char preview, updated timestamp, category. Use this at the start of a session to recall what you've learned about the user.`,
    parameters: { type: 'object', properties: {
      category: { type: 'string', description: 'Optional category filter.' },
    }, required: [] },
  },
  async run(args) {
    const list = _noteList(args.category ? String(args.category) : undefined);
    return JSON.stringify({ count: list.length, notes: list });
  },
});

register({
  def: {
    type: 'function', name: 'note_delete',
    description: `Delete a note by key.`,
    parameters: { type: 'object', properties: {
      key: { type: 'string', description: 'The note key to delete.' },
    }, required: ['key'] },
  },
  async run(args) { return JSON.stringify(_noteDelete(String(args.key))); },
});

// ── focus_index: trigger native focus (e.g. so password autofill fires) ───

register({
  def: {
    type: 'function', name: 'focus_index',
    description: `Focus the input at index [N] using a real CDP-driven focus. Unlike type_index (which uses a setter that bypasses Chrome autofill), this triggers native focus events — useful when you want the browser's saved-password autofill to kick in. Follow with press_key("Tab") to commit autofill, then re-inspect the page.`,
    parameters: { type: 'object', properties: {
      index: { type: 'number', description: 'The [N] index from the page snapshot.' },
    }, required: ['index'] },
  },
  async run(args, ctx) {
    const idx = Number(args.index);
    if (!Number.isFinite(idx) || idx < 1) return JSON.stringify({ error: 'index must be a positive integer' });
    const cdp = ctx.cdp as unknown as { send: (m: string, p?: unknown) => Promise<unknown> };
    const resolved = await resolveIndex(cdp, idx);
    if (!resolved.found || !resolved.rect) {
      return JSON.stringify({ success: false, error: resolved.reason || `index ${idx} not found — call inspect_page` });
    }
    // Real mouse-click at element center triggers Chrome's autofill flow,
    // unlike el.focus() which the saved-password manager ignores.
    const { cx, cy } = resolved.rect;
    await ctx.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'none', clickCount: 0 });
    await ctx.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
    await ctx.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
    return JSON.stringify({ success: true, focused: idx, tag: resolved.tag, hint: 'If a saved password exists, autofill should populate within ~500ms — call inspect_page to verify.' });
  },
});

// ── await_user: pause and ask for human action (sign-in, 2FA, captcha) ───

register({
  def: {
    type: 'function', name: 'await_user',
    description: `Pause the run and ask the user to do something in the browser themselves — sign in, approve 2FA, solve a captcha, anything you cannot or should not do for them. Use this INSTEAD of typing into password fields or guessing at OAuth flows. The message is shown to the user; they continue the conversation when ready.`,
    parameters: { type: 'object', properties: {
      message: { type: 'string', description: 'What you need the user to do, in one short sentence (e.g. "Please sign in to GitHub on the new tab I opened, then say continue.").' },
    }, required: ['message'] },
  },
  async run(args) {
    const msg = String(args.message || 'Please complete the action in your browser, then continue.');
    return JSON.stringify({ awaiting_user: true, message: msg, hint: 'Stop here. Do not call more tools until the user replies.' });
  },
});
