// Indexed-element page snapshot — the SeeAct/browser-use observation pattern.
//
// One Runtime.evaluate per snapshot tags every visible interactive element
// with data-browy-id="N" so subsequent click/type/select tools can refer to
// elements by N and target them deterministically (no brittle CSS selectors,
// no LLM-hallucinated XPaths).
//
// The serialized form fed to the LLM looks like:
//
//   <page_stats>14 interactive, 23 links, 0 iframes, 312 total elements</page_stats>
//   <page_info>0.2 pages above, 1.8 pages below — scroll down to reveal more</page_info>
//   [Start of page]
//   [1]<a href=/login>Sign in</a>
//   [2]<button aria-label=Search />
//   [3]<input type=search placeholder="Search docs" />
//
// Modeled on browser-use's DomService + DOMTreeSerializer.

export interface IndexedElement {
  index: number;
  tag: string;
  type?: string;
  role?: string;
  name?: string;
  ariaLabel?: string;
  /** Computed accessible name (label/aria-labelledby/aria-label/text/title chain).
   *  Often differs from raw `text` or `ariaLabel` and is what a screen reader
   *  would actually announce. Higher-signal target for the LLM. */
  axName?: string;
  placeholder?: string;
  href?: string;
  value?: string;
  text?: string;
  /** Native checkbox/radio checked state. */
  checked?: boolean;
  /** True when document.activeElement === this element at snapshot time. */
  focused?: boolean;
  /** aria-expanded — disclosure widgets, comboboxes, menus. */
  expanded?: boolean;
  /** aria-pressed — toggle buttons. */
  pressed?: boolean;
  /** aria-selected — tabs, options, treeitems. */
  ariaSelected?: boolean;
  /** True when element is disabled (aria-disabled or DOM disabled). */
  disabled?: boolean;
  /** aria-current — "page", "step", "true", etc. */
  current?: string;
  /** For <select>: the currently selected option text. */
  selected?: string;
  /** For <select>: list of option labels (capped). */
  options?: string[];
  inViewport: boolean;
  /** True when this element wasn't present in the immediately-prior snapshot
   *  (same URL). Surface as `*N` in serialized form so the LLM notices new
   *  popovers / modals / autocomplete results. */
  isNew?: boolean;
  rect: { x: number; y: number; w: number; h: number };
}

/** Screen-reader-style page announcement. Captured by an in-page MutationObserver
 *  on aria-live regions + focus changes since the previous snapshot. */
export interface PageAnnouncement {
  /** ms since epoch, set by the in-page collector. */
  t: number;
  /** What kind of event fired. */
  kind: 'live' | 'alert' | 'status' | 'log' | 'focus' | 'expand' | 'route';
  /** The text the assistive tech would have read (already trimmed). */
  text: string;
  /** Source role/region/element tag for context. */
  source?: string;
}

export interface PageStats {
  interactive: number;
  links: number;
  inputs: number;
  buttons: number;
  iframes: number;
  total: number;
  textChars: number;
}

export interface PageInfo {
  url: string;
  title: string;
  vw: number; vh: number;
  scrollX: number; scrollY: number;
  docHeight: number;
  pagesAbove: number;
  pagesBelow: number;
  readyState: string;
  isPlaceholder: boolean;
  isEmpty: boolean;
}

export interface PageSnapshot {
  capturedAt: number;
  info: PageInfo;
  stats: PageStats;
  elements: IndexedElement[];
  /** Recent announcements collected since the previous snapshot
   *  (focus changes + aria-live region updates). */
  announcements: PageAnnouncement[];
}

interface CdpLike {
  send: (method: string, params?: unknown) => Promise<unknown>;
}

/** In-page: `__browyDisabled(el)` is true when the browser itself won't let
 *  anyone use `el`: its disabled property, or :disabled, which also covers a
 *  control inside a disabled <fieldset>. aria-disabled doesn't count, since
 *  clicks on such an element still go through. */
const DISABLED_JS = `
const __browyDisabled = (el) => { try { return el.disabled === true || el.matches(':disabled'); } catch (_) { return false; } };
`;

/** In-page helpers, prepended to an expression: `__browyFind(n)` returns the
 *  element the last snapshot indexed as [n], wherever it lives (the document,
 *  an open shadow root or a same-origin iframe), or null. The snapshot keeps
 *  a direct reference in window.__browyIdx; the attribute search is the
 *  fallback. `__browyDeepActive()` is the focused element, looking through
 *  shadow roots and same-origin iframes. `__browyDisabled(el)` comes from
 *  DISABLED_JS. */
export const FIND_JS = `
const __browyFind = (n) => {
  const want = String(n);
  const reg = window.__browyIdx;
  const hit = reg && reg[n];
  if (hit && hit.isConnected && hit.getAttribute('data-browy-id') === want) return hit;
  const sel = '[data-browy-id="' + want + '"]';
  const stack = [document];
  while (stack.length) {
    const root = stack.pop();
    let found = null;
    try { found = root.querySelector(sel); } catch (_) {}
    if (found) return found;
    let all = [];
    try { all = root.querySelectorAll('*'); } catch (_) {}
    for (const x of all) {
      if (x.shadowRoot) stack.push(x.shadowRoot);
      if (x.tagName === 'IFRAME' || x.tagName === 'FRAME') { try { if (x.contentDocument) stack.push(x.contentDocument); } catch (_) {} }
    }
  }
  return null;
};
const __browyDeepActive = () => {
  let a = document.activeElement;
  for (let i = 0; a && i < 32; i++) {
    let inner = null;
    if (a.shadowRoot) inner = a.shadowRoot.activeElement;
    else if (a.tagName === 'IFRAME' || a.tagName === 'FRAME') { try { inner = a.contentDocument && a.contentDocument.activeElement; } catch (_) {} }
    if (!inner) break;
    a = inner;
  }
  return a;
};
${DISABLED_JS}`;

const SNAPSHOT_CACHE = new WeakMap<object, PageSnapshot>();

/** Build a fresh page snapshot. Tags interactive elements with data-browy-id
 *  in the live DOM so action tools can resolve N → element later. */
export async function capturePageSnapshot(cdp: CdpLike): Promise<PageSnapshot> {
  // The script returns a JSON string to keep the round-trip cheap.
  const script = `(() => {
    const INTERACTIVE_TAGS = new Set(['a','button','input','select','textarea','details','summary','label']);
    const INTERACTIVE_ROLES = new Set(['button','link','checkbox','radio','tab','menuitem','combobox','option','switch','textbox','searchbox','listbox','menuitemcheckbox','menuitemradio','treeitem','slider','spinbutton']);
    const SKIP_INPUTS = new Set(['hidden']);

    // ── Aria-live + focus observer (install once per document) ─────────────
    // We stash a small ring buffer on window.__browy_ax. Each capture drains
    // it and ships entries up alongside the snapshot — the agent gets the
    // equivalent of NVDA's recent announcements.
    if (!window.__browy_ax) {
      const ring = [];
      const MAX = 50;
      const push = (entry) => {
        try {
          if (!entry || !entry.text) return;
          entry.text = String(entry.text).replace(/\\s+/g, ' ').trim().slice(0, 240);
          if (!entry.text) return;
          ring.push(entry);
          if (ring.length > MAX) ring.shift();
        } catch (_) {}
      };
      const ax = {
        ring,
        drain() { const out = ring.slice(); ring.length = 0; return out; },
      };
      window.__browy_ax = ax;

      // Live regions: aria-live, role=status|alert|log
      const liveSel = '[aria-live],[role="status"],[role="alert"],[role="log"]';
      const isLive = (n) => n && n.nodeType === 1 && (
        n.matches?.(liveSel) || n.closest?.(liveSel)
      );
      const liveText = (n) => {
        const host = n.matches?.(liveSel) ? n : n.closest?.(liveSel);
        if (!host) return '';
        const role = (host.getAttribute('role') || '').toLowerCase();
        const live = (host.getAttribute('aria-live') || '').toLowerCase();
        const kind = role === 'alert' ? 'alert'
                   : role === 'log' ? 'log'
                   : role === 'status' || live === 'polite' || live === 'assertive' ? (role === 'status' ? 'status' : 'live')
                   : 'live';
        return { text: (host.innerText || '').slice(0, 400), kind, source: role || ('aria-live=' + live) };
      };
      try {
        new MutationObserver((muts) => {
          for (const m of muts) {
            const target = m.target;
            if (!isLive(target) && !(m.addedNodes && Array.from(m.addedNodes).some(isLive))) continue;
            const info = liveText(target);
            if (info && info.text) push({ t: Date.now(), kind: info.kind, text: info.text, source: info.source });
          }
        }).observe(document.documentElement || document, {
          subtree: true, childList: true, characterData: true, attributes: true,
          attributeFilter: ['aria-live', 'aria-atomic', 'aria-hidden'],
        });
      } catch (_) {}

      // Focus changes
      try {
        document.addEventListener('focusin', (e) => {
          const el = e.target;
          if (!el || el === document.body) return;
          const name = (el.getAttribute?.('aria-label') || el.textContent || el.getAttribute?.('placeholder') || '').trim().slice(0, 100);
          const role = (el.getAttribute?.('role') || el.tagName || '').toLowerCase();
          push({ t: Date.now(), kind: 'focus', text: 'focus → ' + role + (name ? ' "' + name + '"' : ''), source: role });
        }, true);
      } catch (_) {}

      // aria-expanded toggles (menu / disclosure / combobox open-close)
      try {
        new MutationObserver((muts) => {
          for (const m of muts) {
            if (m.type !== 'attributes' || m.attributeName !== 'aria-expanded') continue;
            const el = m.target;
            const v = el.getAttribute?.('aria-expanded');
            const name = (el.getAttribute?.('aria-label') || el.textContent || '').trim().slice(0, 80);
            push({ t: Date.now(), kind: 'expand', text: (v === 'true' ? 'expanded' : 'collapsed') + (name ? ' "' + name + '"' : ''), source: el.tagName?.toLowerCase() });
          }
        }).observe(document.documentElement || document, {
          subtree: true, attributes: true, attributeFilter: ['aria-expanded'],
        });
      } catch (_) {}

      // Route changes (SPA pushState/replaceState/popstate)
      try {
        const announceRoute = () => push({ t: Date.now(), kind: 'route', text: 'navigation → ' + location.pathname + location.search });
        window.addEventListener('popstate', announceRoute);
        const wrap = (name) => {
          const orig = history[name];
          if (typeof orig !== 'function') return;
          history[name] = function () { const r = orig.apply(this, arguments); try { announceRoute(); } catch(_){} return r; };
        };
        wrap('pushState'); wrap('replaceState');
      } catch (_) {}
    }

    // ── Computed-ish accessible name (label / aria-labelledby / aria-label / text / title) ──
    function axNameFor(el) {
      try {
        // 1) aria-labelledby — concatenate referenced elements' text
        const lb = el.getAttribute && el.getAttribute('aria-labelledby');
        if (lb) {
          const ids = lb.split(/\\s+/).filter(Boolean);
          // The ids live in the element's own tree: a shadow root has its own.
          const root = el.getRootNode();
          const byId = (id) => (root && root.getElementById ? root.getElementById(id) : null) || document.getElementById(id);
          const txt = ids.map(id => (byId(id)?.textContent || '').trim()).filter(Boolean).join(' ');
          if (txt) return txt.slice(0, 120);
        }
        // 2) aria-label (cheap — already on raw attrs but include here for fallthrough)
        const al = el.getAttribute && el.getAttribute('aria-label');
        if (al && al.trim()) return al.trim().slice(0, 120);
        // 3) <label for=> + label parents (HTMLInputElement.labels)
        if (el.labels && el.labels.length) {
          const t = Array.from(el.labels).map(l => (l.textContent || '').trim()).filter(Boolean).join(' ');
          if (t) return t.slice(0, 120);
        }
        // 4) For buttons/links/option/menuitem: use innerText (handled elsewhere via .text but include explicitly)
        const tag = el.tagName.toLowerCase();
        if (tag === 'button' || tag === 'a' || tag === 'option' || tag === 'summary') {
          const t = (el.innerText || el.textContent || '').trim();
          if (t) return t.slice(0, 120);
        }
        // 5) For <input type=image>: alt
        if (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'image') {
          const alt = el.getAttribute('alt');
          if (alt) return alt.trim().slice(0, 120);
        }
        // 6) <img alt=…> — when delegated as the labelling element
        if (tag === 'img') {
          const alt = el.getAttribute('alt');
          if (alt) return alt.trim().slice(0, 120);
        }
        // 7) title
        const ti = el.getAttribute && el.getAttribute('title');
        if (ti && ti.trim()) return ti.trim().slice(0, 120);
      } catch (_) {}
      return undefined;
    }

    function isInteractive(el) {
      // nodeType, not instanceof Element: an element in a same-origin iframe
      // comes from that frame's realm and fails the instanceof check.
      if (!el || el.nodeType !== 1) return false;
      if (el.hasAttribute('disabled')) return false;
      const tag = el.tagName.toLowerCase();
      if (INTERACTIVE_TAGS.has(tag)) {
        if (tag === 'input' && SKIP_INPUTS.has((el.getAttribute('type') || '').toLowerCase())) return false;
        return true;
      }
      if (el.hasAttribute('onclick')) return true;
      const ce = el.getAttribute('contenteditable');
      if (ce && ce !== 'false') return true;
      const ti = el.getAttribute('tabindex');
      if (ti != null && parseInt(ti, 10) >= 0) return true;
      const role = (el.getAttribute('role') || '').toLowerCase();
      if (role && INTERACTIVE_ROLES.has(role)) return true;
      return false;
    }

    function isVisible(el) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (parseFloat(cs.opacity || '1') < 0.05) return false;
      if (cs.pointerEvents === 'none' && el.tagName.toLowerCase() !== 'input') return false;
      return true;
    }

    function nearViewport(el, margin) {
      const r = el.getBoundingClientRect();
      return r.bottom > -margin && r.top < window.innerHeight + margin
          && r.right  > -margin && r.left < window.innerWidth + margin;
    }

    // Strip stale tags from a previous snapshot, including shadow trees.
    function clearStale(root) {
      try {
        const tagged = root.querySelectorAll('[data-browy-id]');
        tagged.forEach(el => el.removeAttribute('data-browy-id'));
      } catch (_) {}
    }
    clearStale(document);

    // Collect candidates: walk the entire DOM including same-origin iframes
    // and shadow roots. Use a custom recursive walk because TreeWalker doesn't
    // descend into shadow DOM.
    const candidates = [];
    let totalElements = 0;
    let textChars = 0;
    let iframeCount = 0;

    function walk(root) {
      if (!root) return;
      try { clearStale(root); } catch (_) {}
      // A document starts at <html>. A shadow root has no documentElement and
      // isn't an element itself, so start from its children: up to 0.1.13
      // the walk stopped right there and skipped every shadow tree.
      const stack = [];
      if (root.nodeType === 9) { if (root.documentElement) stack.push(root.documentElement); }
      else if (root.children) { for (let i = root.children.length - 1; i >= 0; i--) stack.push(root.children[i]); }
      while (stack.length) {
        const node = stack.pop();
        if (!node) continue;
        if (node.nodeType === 1) {
          totalElements++;
          const tag = node.tagName ? node.tagName.toLowerCase() : '';
          if (tag === 'iframe' || tag === 'frame') {
            iframeCount++;
            try {
              if (node.contentDocument) walk(node.contentDocument);
            } catch (_) { /* cross-origin */ }
          }
          if (isInteractive(node) && isVisible(node) && nearViewport(node, 2000)) {
            candidates.push(node);
          }
          if (node.shadowRoot) walk(node.shadowRoot);
          // Text nodes aren't in .children, so count this element's own text here.
          if (tag !== 'script' && tag !== 'style' && tag !== 'noscript' && tag !== 'template') {
            for (let c = node.firstChild; c; c = c.nextSibling) {
              if (c.nodeType === 3) textChars += (c.nodeValue || '').trim().length;
            }
          }
          for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
        }
      }
    }
    walk(document);

    // Sort by visual order (top-to-bottom, left-to-right) so the indices
    // align with how a human reads the page.
    candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      if (Math.abs(ar.top - br.top) > 8) return ar.top - br.top;
      return ar.left - br.left;
    });

    // Containment filter: drop elements ≥99% contained inside another
    // already-indexed interactive element (e.g. an inner <span> inside an
    // <a> tag). browser-use uses the same heuristic. Text fields are always
    // kept: a focusable wrapper (often a custom element hosting a composer in
    // its shadow root) must not swallow the field the agent has to type in.
    const isField = (el) => {
      const t = el.tagName.toLowerCase();
      if (t === 'input' || t === 'textarea' || t === 'select') return true;
      const ce = el.getAttribute('contenteditable');
      return ce != null && ce !== 'false';
    };
    const kept = [];
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      let contained = false;
      for (const kr of kept) {
        const k = kr.r;
        const overlapW = Math.max(0, Math.min(r.right, k.right) - Math.max(r.left, k.left));
        const overlapH = Math.max(0, Math.min(r.bottom, k.bottom) - Math.max(r.top, k.top));
        const elArea = r.width * r.height;
        if (elArea > 0 && (overlapW * overlapH) / elArea >= 0.99) {
          contained = true; break;
        }
      }
      if (!contained || isField(el)) kept.push({ el, r });
    }

    // Cap to a reasonable number to keep prompts bounded.
    const MAX_ELEMENTS = 150;
    const final = kept.slice(0, MAX_ELEMENTS);

    // The focused element, looking through shadow roots (document.activeElement
    // stops at the outermost shadow host).
    let deepActive = document.activeElement;
    while (deepActive && deepActive.shadowRoot && deepActive.shadowRoot.activeElement) deepActive = deepActive.shadowRoot.activeElement;

    // Direct references, so the action tools find [N] without searching every
    // shadow root and iframe again.
    const registry = [];

    let links = 0, inputs = 0, buttons = 0;
    const items = final.map(({ el, r }, i) => {
      const idx = i + 1;
      el.setAttribute('data-browy-id', String(idx));
      registry[idx] = el;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a') links++;
      if (tag === 'input' || tag === 'textarea' || tag === 'select') inputs++;
      if (tag === 'button' || el.getAttribute('role') === 'button') buttons++;

      const text = (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
      const ariaLabel = el.getAttribute('aria-label') || undefined;
      const placeholder = el.getAttribute('placeholder') || undefined;
      const value = (tag === 'input' || tag === 'textarea') && typeof el.value === 'string'
        ? String(el.value).slice(0, 100)
        : undefined;

      // Checkbox / radio state — high signal for the agent ("is this already on?")
      let checked;
      const inputType = (el.getAttribute('type') || '').toLowerCase();
      if (tag === 'input' && (inputType === 'checkbox' || inputType === 'radio')) {
        checked = !!el.checked;
      } else {
        const ariaChecked = el.getAttribute('aria-checked');
        if (ariaChecked === 'true') checked = true;
        else if (ariaChecked === 'false') checked = false;
      }

      // <select> options + currently-selected
      let selected, options;
      if (tag === 'select') {
        try {
          const opts = Array.from(el.options || []);
          options = opts.slice(0, 12).map(o => (o.label || o.text || o.value || '').trim().slice(0, 40)).filter(Boolean);
          if (opts.length > 12) options.push('… +' + (opts.length - 12) + ' more');
          const sel = opts[el.selectedIndex];
          if (sel) selected = (sel.label || sel.text || sel.value || '').trim().slice(0, 60);
        } catch (_) {}
      }

      // Accessibility states — high-signal, what a screen reader would say.
      const focused = (deepActive === el);
      const expandedAttr = el.getAttribute('aria-expanded');
      const expanded = expandedAttr === 'true' ? true : expandedAttr === 'false' ? false : undefined;
      const pressedAttr = el.getAttribute('aria-pressed');
      const pressed = pressedAttr === 'true' ? true : pressedAttr === 'false' ? false : undefined;
      const selectedAttr = el.getAttribute('aria-selected');
      const ariaSelected = selectedAttr === 'true' ? true : selectedAttr === 'false' ? false : undefined;
      const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' || undefined;
      const current = el.getAttribute('aria-current') || undefined;
      const axName = axNameFor(el);

      const inVp = (r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth);

      return {
        index: idx,
        tag,
        type: el.getAttribute('type') || undefined,
        role: el.getAttribute('role') || undefined,
        name: el.getAttribute('name') || undefined,
        ariaLabel,
        axName: axName && axName !== ariaLabel && axName !== text ? axName : undefined,
        placeholder,
        href: tag === 'a' ? (el.getAttribute('href') || undefined) : undefined,
        text: text || undefined,
        value,
        checked,
        focused: focused || undefined,
        expanded,
        pressed,
        ariaSelected,
        disabled,
        current,
        selected,
        options,
        inViewport: inVp,
        rect: {
          x: Math.round(r.left), y: Math.round(r.top),
          w: Math.round(r.width), h: Math.round(r.height),
        },
      };
    });
    try {
      Object.defineProperty(window, '__browyIdx', { value: registry, configurable: true, writable: true, enumerable: false });
    } catch (_) {}

    const docHeight = Math.max(
      document.documentElement?.scrollHeight || 0,
      document.body?.scrollHeight || 0,
      window.innerHeight
    );

    const stats = {
      interactive: items.length,
      links, inputs, buttons,
      iframes: iframeCount,
      total: totalElements,
      textChars,
    };

    // A short page with real text on it isn't empty; an app shell still
    // waiting for its script has next to none.
    const isEmpty = totalElements < 10 && textChars < 20;
    const isPlaceholder = !isEmpty && totalElements > 30 && textChars < totalElements * 4;

    const info = {
      url: location.href,
      title: document.title,
      vw: window.innerWidth, vh: window.innerHeight,
      scrollX: window.scrollX, scrollY: window.scrollY,
      docHeight,
      readyState: document.readyState,
      isEmpty, isPlaceholder,
    };

    // Drain accumulated a11y announcements since the last snapshot.
    let announcements = [];
    try {
      announcements = (window.__browy_ax && window.__browy_ax.drain()) || [];
    } catch (_) {}

    return JSON.stringify({ info, stats, items, announcements });
  })()`;

  const { result } = await cdp.send('Runtime.evaluate', {
    expression: script,
    returnByValue: true,
    timeout: 5000,
  }) as { result: { value?: string } };

  const raw = String(result?.value ?? '{}');
  let parsed: { info?: any; stats?: any; items?: IndexedElement[]; announcements?: PageAnnouncement[] };
  try { parsed = JSON.parse(raw); } catch { parsed = {}; }

  const info: PageInfo = {
    url: parsed.info?.url || '',
    title: parsed.info?.title || '',
    vw: parsed.info?.vw || 0,
    vh: parsed.info?.vh || 0,
    scrollX: parsed.info?.scrollX || 0,
    scrollY: parsed.info?.scrollY || 0,
    docHeight: parsed.info?.docHeight || 0,
    pagesAbove: parsed.info?.vh ? (parsed.info.scrollY / parsed.info.vh) : 0,
    pagesBelow: parsed.info?.vh
      ? Math.max(0, (parsed.info.docHeight - parsed.info.vh - parsed.info.scrollY) / parsed.info.vh)
      : 0,
    readyState: parsed.info?.readyState || '',
    isEmpty: !!parsed.info?.isEmpty,
    isPlaceholder: !!parsed.info?.isPlaceholder,
  };

  const stats: PageStats = {
    interactive: parsed.stats?.interactive || 0,
    links: parsed.stats?.links || 0,
    inputs: parsed.stats?.inputs || 0,
    buttons: parsed.stats?.buttons || 0,
    iframes: parsed.stats?.iframes || 0,
    total: parsed.stats?.total || 0,
    textChars: parsed.stats?.textChars || 0,
  };

  const snap: PageSnapshot = {
    capturedAt: Date.now(),
    info, stats,
    elements: parsed.items || [],
    announcements: Array.isArray(parsed.announcements) ? parsed.announcements as PageAnnouncement[] : [],
  };

  // Diff against the immediately-prior snapshot (same URL only). Mark elements
  // whose signature wasn't in the previous set as `isNew`. browser-use uses the
  // same `*N` convention so the LLM notices popovers / modals / autocomplete
  // results that just appeared.
  const prev = SNAPSHOT_CACHE.get(cdp as object);
  if (prev && prev.info.url === info.url) {
    const prevSigs = new Set(prev.elements.map(elementSignature));
    for (const el of snap.elements) {
      if (!prevSigs.has(elementSignature(el))) el.isNew = true;
    }
  }

  SNAPSHOT_CACHE.set(cdp as object, snap);
  return snap;
}

/** Stable-ish identity for an element — used for diffing snapshots.
 *  Indices change every snapshot (sort order can shift); identity is the
 *  combination of structural attributes that the LLM would actually use to
 *  recognise the element. Intentionally NOT including position or text-with-
 *  state to avoid spurious "new" marks on every keystroke. */
function elementSignature(el: IndexedElement): string {
  return [
    el.tag,
    el.type || '',
    el.role || '',
    el.name || '',
    el.href || '',
    el.ariaLabel || '',
    el.placeholder || '',
    (el.text || '').slice(0, 40),
  ].join('|');
}

/** Returns the most recent snapshot for this cdp session, if any. */
export function getCachedSnapshot(cdp: CdpLike): PageSnapshot | undefined {
  return SNAPSHOT_CACHE.get(cdp as object);
}

/** Returns either the cached snapshot or a freshly-captured one. */
export async function ensureSnapshot(cdp: CdpLike, maxAgeMs = 1500): Promise<PageSnapshot> {
  const cached = getCachedSnapshot(cdp);
  if (cached && Date.now() - cached.capturedAt < maxAgeMs) return cached;
  return capturePageSnapshot(cdp);
}

/** Format a snapshot for an LLM prompt. */
export function serializeSnapshot(snap: PageSnapshot, opts?: { maxChars?: number }): string {
  const max = opts?.maxChars ?? 12_000;
  const lines: string[] = [];

  // <page_stats>
  let hint = '';
  if (snap.info.isEmpty) hint = 'Page appears empty (SPA not loaded?) — ';
  else if (snap.info.isPlaceholder) hint = 'Page appears to show skeleton/placeholder content (still loading?) — ';
  lines.push(
    `<page_stats>${hint}${snap.stats.interactive} interactive, ${snap.stats.links} links, ` +
    `${snap.stats.buttons} buttons, ${snap.stats.inputs} inputs, ${snap.stats.iframes} iframes, ` +
    `${snap.stats.total} total elements</page_stats>`
  );

  // <page_info>
  const above = snap.info.pagesAbove.toFixed(1);
  const below = snap.info.pagesBelow.toFixed(1);
  let scrollHint = '';
  if (snap.info.pagesBelow > 0.2) scrollHint = ' — scroll down to reveal more';
  else if (snap.info.pagesAbove > 0.2 && snap.info.pagesBelow < 0.05) scrollHint = ' — at end of page';
  lines.push(`<page_info>${above} pages above, ${below} pages below${scrollHint}</page_info>`);

  // <page_announcements> — what a screen reader heard between turns.
  // High-signal evidence of "did my last action work" without a screenshot.
  if (snap.announcements && snap.announcements.length) {
    const items = snap.announcements.slice(-12); // newest 12
    const annLines = items.map(a => `  [${a.kind}] ${truncate(a.text, 160)}`);
    lines.push('<page_announcements>');
    lines.push(...annLines);
    lines.push('</page_announcements>');
  }

  // Sentinels
  if (snap.info.pagesAbove < 0.05) lines.push('[Start of page]');

  // Elements
  for (const el of snap.elements) {
    lines.push(formatElement(el));
  }

  if (snap.info.pagesBelow < 0.05) lines.push('[End of page]');

  let out = lines.join('\n');
  if (out.length > max) out = out.slice(0, max) + `\n… (truncated, ${snap.elements.length} elements total)`;
  return out;
}

function formatElement(el: IndexedElement): string {
  const attrs: string[] = [];
  if (el.type) attrs.push(`type=${el.type}`);
  if (el.role) attrs.push(`role=${el.role}`);
  if (el.name) attrs.push(`name=${el.name}`);
  if (el.focused) attrs.push('focused');
  if (el.disabled) attrs.push('disabled');
  if (el.expanded === true)  attrs.push('expanded');
  else if (el.expanded === false) attrs.push('collapsed');
  if (el.pressed === true)   attrs.push('pressed');
  if (el.ariaSelected === true) attrs.push('selected');
  if (el.current) attrs.push(`current=${el.current}`);
  if (el.checked === true) attrs.push('checked');
  else if (el.checked === false && (el.type === 'checkbox' || el.type === 'radio')) attrs.push('unchecked');
  if (el.placeholder) attrs.push(`placeholder=${q(el.placeholder)}`);
  if (el.ariaLabel) attrs.push(`aria-label=${q(el.ariaLabel)}`);
  if (el.axName)    attrs.push(`aria-name=${q(el.axName)}`);
  if (el.href) attrs.push(`href=${truncate(el.href, 60)}`);
  if (el.value) attrs.push(`value=${q(truncate(el.value, 40))}`);
  if (el.selected) attrs.push(`selected=${q(truncate(el.selected, 40))}`);
  if (el.options && el.options.length) attrs.push(`options=[${el.options.map(o => q(o)).join(',')}]`);
  const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
  const vp = el.inViewport ? '' : '~'; // ~ marks elements outside viewport
  const nu = el.isNew ? '*' : '';      // * marks elements new since last snapshot
  if (el.text) {
    return `[${nu}${vp}${el.index}]<${el.tag}${attrStr}>${truncate(el.text, 100)}</${el.tag}>`;
  }
  return `[${nu}${vp}${el.index}]<${el.tag}${attrStr} />`;
}

function q(s: string): string {
  if (!/[\s"'<>=]/.test(s)) return s;
  return JSON.stringify(s);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Resolve an index → element handle for action execution.
 *  Returns the bounding rect (page coordinates → for clicks via Input.dispatchMouseEvent)
 *  and the JS expression that resolves to the element. */
export interface ResolvedElement {
  found: boolean;
  reason?: string;
  rect?: { x: number; y: number; w: number; h: number; cx: number; cy: number };
  tag?: string;
  isEditable?: boolean;
  isSelect?: boolean;
  /** The browser won't let it be used (see __browyDisabled), so a click does nothing. */
  disabled?: boolean;
}

export async function resolveIndex(cdp: CdpLike, index: number): Promise<ResolvedElement> {
  const n = Math.floor(Number(index));
  const expr = `(() => {
    ${FIND_JS}
    const el = __browyFind(${n});
    if (!el) return JSON.stringify({ found: false, reason: 'no element [${n}]: the page changed since the last snapshot. Call inspect_page and use the new index.' });
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch(_) {}
    const r = el.getBoundingClientRect();
    // An element in a same-origin iframe reports coordinates inside that
    // frame; clicks need them in the top page.
    let x = r.left, y = r.top;
    try {
      let w = el.ownerDocument.defaultView;
      while (w && w.frameElement) {
        const f = w.frameElement, fr = f.getBoundingClientRect();
        x += fr.left + f.clientLeft; y += fr.top + f.clientTop;
        w = w.parent;
      }
    } catch (_) {}
    const tag = el.tagName.toLowerCase();
    const editable = tag === 'input' || tag === 'textarea' || !!el.isContentEditable;
    const isSelect = tag === 'select';
    return JSON.stringify({
      found: true,
      rect: { x, y, w: r.width, h: r.height, cx: x + r.width/2, cy: y + r.height/2 },
      tag, isEditable: editable, isSelect, disabled: __browyDisabled(el),
    });
  })()`;
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    timeout: 3000,
  }) as { result: { value?: string } };
  try { return JSON.parse(String(result?.value ?? '{"found":false}')); }
  catch { return { found: false, reason: 'resolver returned non-JSON' }; }
}
