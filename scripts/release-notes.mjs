#!/usr/bin/env node
// Prints one version's section of CHANGELOG.md, for its GitHub release.
// People who watch the repo's releases get this as their update email.
//
//   node scripts/release-notes.mjs 0.1.13           the release notes (Markdown)
//   node scripts/release-notes.mjs 0.1.13 --title   "v0.1.13: <the section's headline>"
//
// Exits 1 if CHANGELOG.md has no section for that version.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [version, flag] = process.argv.slice(2);
if (!version) {
  console.error('usage: node scripts/release-notes.mjs <version> [--title]');
  process.exit(2);
}

const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');
const heading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]:?[ \\t]*(.*)$`, 'm');
const match = heading.exec(changelog);
if (!match) {
  console.error(`CHANGELOG.md has no section for ${version}`);
  process.exit(1);
}

if (flag === '--title') {
  const headline = match[1].replace(/`/g, '').trim();
  console.log(headline ? `v${version}: ${headline}` : `v${version}`);
  process.exit(0);
}

const rest = changelog.slice(match.index + match[0].length);
const next = rest.search(/^## \[/m);
const body = (next === -1 ? rest : rest.slice(0, next))
  .replace(/^\s*\*Released [^*\n]+\*\s*/, '')
  .trim();
console.log(`${body}\n\n**Install or update:** https://browyhq.github.io/install/`);
