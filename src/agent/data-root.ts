// Browy data root — sandboxed persistent disk for the agent.
//
//   ~/.browy/data/
//     files/        scratch disk (save_file/read_file/list_files)
//     notes.json    flat key-value memory (note_set/note_get/note_list)
//
// All paths are validated to stay inside the data root so the agent can't
// escape via "../" or absolute paths. This is intentionally NOT a general
// filesystem — the user has run_script for that.

import fs from 'fs';
import path from 'path';
import os from 'os';

export const DATA_ROOT = path.join(os.homedir(), '.browy', 'data');
export const FILES_DIR = path.join(DATA_ROOT, 'files');
const NOTES_PATH = path.join(DATA_ROOT, 'notes.json');

function ensureDirs() {
  fs.mkdirSync(FILES_DIR, { recursive: true });
}

/** Resolve a user-supplied filename to an absolute path inside FILES_DIR.
 *  Throws if the resulting path escapes the root. */
export function safeFilePath(filename: string): string {
  if (!filename || typeof filename !== 'string') throw new Error('filename is required');
  // Strip leading slashes / drive letters; reject any explicit traversal.
  const cleaned = filename.replace(/^[\\/]+/, '').replace(/^[a-zA-Z]:/, '');
  const resolved = path.resolve(FILES_DIR, cleaned);
  const rootWithSep = FILES_DIR.endsWith(path.sep) ? FILES_DIR : FILES_DIR + path.sep;
  if (resolved !== FILES_DIR && !resolved.startsWith(rootWithSep)) {
    throw new Error(`path escapes data root: ${filename}`);
  }
  return resolved;
}

export function saveFile(filename: string, content: string, encoding: 'utf8' | 'base64' = 'utf8'): { path: string; bytes: number } {
  ensureDirs();
  const dest = safeFilePath(filename);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const buf = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
  fs.writeFileSync(dest, buf);
  return { path: path.relative(FILES_DIR, dest).replace(/\\/g, '/'), bytes: buf.length };
}

export function readFile(filename: string, encoding: 'utf8' | 'base64' = 'utf8'): { content: string; bytes: number } {
  const src = safeFilePath(filename);
  const buf = fs.readFileSync(src);
  return { content: encoding === 'base64' ? buf.toString('base64') : buf.toString('utf8'), bytes: buf.length };
}

export interface FileEntry { name: string; size: number; modified: number; isDir: boolean }

export function listFiles(prefix?: string): FileEntry[] {
  ensureDirs();
  const start = prefix ? safeFilePath(prefix) : FILES_DIR;
  if (!fs.existsSync(start)) return [];
  const out: FileEntry[] = [];
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const stat = fs.statSync(abs);
      out.push({
        name: path.relative(FILES_DIR, abs).replace(/\\/g, '/'),
        size: stat.size,
        modified: stat.mtimeMs,
        isDir: entry.isDirectory(),
      });
      if (entry.isDirectory() && out.length < 500) walk(abs);
    }
  }
  walk(start);
  return out;
}

export function deleteFile(filename: string): { deleted: boolean } {
  const target = safeFilePath(filename);
  if (!fs.existsSync(target)) return { deleted: false };
  const stat = fs.statSync(target);
  if (stat.isDirectory()) fs.rmSync(target, { recursive: true });
  else fs.unlinkSync(target);
  return { deleted: true };
}

// ── Notes (flat KV with categories) ───────────────────────────────────────

interface NotesFile { [key: string]: { value: string; updated: number; category?: string } }

function loadNotes(): NotesFile {
  ensureDirs();
  try { return JSON.parse(fs.readFileSync(NOTES_PATH, 'utf8')); }
  catch { return {}; }
}
function saveNotes(notes: NotesFile) {
  ensureDirs();
  fs.writeFileSync(NOTES_PATH, JSON.stringify(notes, null, 2));
}

export function noteSet(key: string, value: string, category?: string): { key: string; bytes: number } {
  if (!key || typeof key !== 'string') throw new Error('key required');
  const notes = loadNotes();
  notes[key] = { value: String(value ?? ''), updated: Date.now(), category };
  saveNotes(notes);
  return { key, bytes: notes[key].value.length };
}

export function noteGet(key: string): { key: string; value: string | null; updated?: number; category?: string } {
  const notes = loadNotes();
  const e = notes[key];
  if (!e) return { key, value: null };
  return { key, value: e.value, updated: e.updated, category: e.category };
}

export function noteList(category?: string): Array<{ key: string; preview: string; updated: number; category?: string }> {
  const notes = loadNotes();
  return Object.entries(notes)
    .filter(([, e]) => !category || e.category === category)
    .sort((a, b) => b[1].updated - a[1].updated)
    .map(([key, e]) => ({ key, preview: e.value.slice(0, 100), updated: e.updated, category: e.category }));
}

export function noteDelete(key: string): { deleted: boolean } {
  const notes = loadNotes();
  if (!(key in notes)) return { deleted: false };
  delete notes[key];
  saveNotes(notes);
  return { deleted: true };
}
