#!/usr/bin/env node
/**
 * Bumps the app version across every file that carries it, keeping them in sync.
 *
 * Deliberately hand-edits package-lock.json instead of shelling out to `npm version`
 * or `npm install`: those rewrite unrelated `peer` flags and dependency metadata as
 * noise, and the release diff should be version fields only.
 *
 * Usage:
 *   node scripts/bump-version.mjs minor      # 1.7.3 -> 1.8.0
 *   node scripts/bump-version.mjs 2.0.0      # explicit target
 *
 * Prints the resolved version to stdout so callers (CI) can capture it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const arg = process.argv[2];
if (!arg) {
  console.error('usage: bump-version.mjs <major|minor|patch|X.Y.Z>');
  process.exit(1);
}

const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));
// Re-serialise with the 2-space indent + trailing newline npm itself writes, so the
// diff stays confined to the version line.
const writeJson = (rel, data) =>
  writeFileSync(path.join(ROOT, rel), JSON.stringify(data, null, 2) + '\n');

const current = readJson('package.json').version;
const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
if (!parsed) throw new Error(`root package.json version is not X.Y.Z: ${current}`);
const [major, minor, patch] = parsed.slice(1).map(Number);

let next;
switch (arg) {
  case 'major': next = `${major + 1}.0.0`; break;
  case 'minor': next = `${major}.${minor + 1}.0`; break;
  case 'patch': next = `${major}.${minor}.${patch + 1}`; break;
  default:
    if (!/^\d+\.\d+\.\d+$/.test(arg)) throw new Error(`not a semver version: ${arg}`);
    next = arg;
}

if (next === current) throw new Error(`version is already ${next}`);

for (const rel of ['package.json', 'server/package.json', 'web/package.json']) {
  const pkg = readJson(rel);
  pkg.version = next;
  writeJson(rel, pkg);
}

// Only the four version fields in the lockfile — never the dependency tree.
const lock = readJson('package-lock.json');
lock.version = next;
for (const key of ['', 'server', 'web']) {
  if (!lock.packages?.[key]) throw new Error(`package-lock.json has no packages[${JSON.stringify(key)}]`);
  lock.packages[key].version = next;
}
writeJson('package-lock.json', lock);

// The mock dev server renders this as the version badge; keep it honest.
const mockRel = 'web/vite.mock.config.ts';
const mockPath = path.join(ROOT, mockRel);
const mock = readFileSync(mockPath, 'utf8');
const mockNext = mock.replace(/(appVersion:\s*')[^']*(')/, `$1${next}$2`);
if (mockNext === mock) throw new Error(`no appVersion field found in ${mockRel}`);
writeFileSync(mockPath, mockNext);

console.log(next);
