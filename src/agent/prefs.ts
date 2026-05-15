// User preferences persisted across native-host restarts.
//
//   ~/.browy/data/prefs.json    { model: string, ... }
//
// Tiny, JSON-only, best-effort. Read at startup, written whenever the user
// changes a setting from the side panel, options page, or DevTools panel.
// Environment variables (BA_MODEL etc.) still win — power users keep their
// override. The prefs file is just a fallback over the bundled default.

import fs from 'fs';
import path from 'path';
import os from 'os';

const PREFS_DIR = path.join(os.homedir(), '.browy', 'data');
const PREFS_PATH = path.join(PREFS_DIR, 'prefs.json');

export interface UserPrefs {
  model?: string;
}

export function loadPrefs(): UserPrefs {
  try {
    const raw = fs.readFileSync(PREFS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function savePrefs(patch: Partial<UserPrefs>): void {
  try {
    fs.mkdirSync(PREFS_DIR, { recursive: true });
    const current = loadPrefs();
    const next = { ...current, ...patch };
    fs.writeFileSync(PREFS_PATH, JSON.stringify(next, null, 2));
  } catch {
    // best-effort; never crash the host because prefs failed to persist.
  }
}
