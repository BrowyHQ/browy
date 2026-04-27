// Registers the Browy panel inside DevTools. The actual REPL UI lives in
// panel.html (built out in Phase D); this file only declares the panel.
chrome.devtools.panels.create(
  'Browy',
  'icons/icon32.png',
  'panel.html',
);
