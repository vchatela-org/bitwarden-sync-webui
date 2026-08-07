import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * Live item counts pulled straight from a target's vaults by a 'count' job, as opposed to
 * the counts recovered from an export sidecar (see backupCounts.ts). These only change when a
 * count job runs, so each role carries its own timestamp — source and dest are fetched at
 * different points during the job and a stale count read days apart from a fresh one otherwise
 * looks identical in the UI.
 */
export interface LiveCountEntry {
  source?: number;
  sourceAt?: string;
  dest?: number;
  destAt?: string;
}

export type LiveCountsMap = Record<string, LiveCountEntry>;

/** Read at call time, not module load, so tests can redirect it. */
function dataDir(): string {
  return process.env['DATA_DIR'] ?? '/data';
}

function storeFile(): string {
  return join(dataDir(), 'live-counts.json');
}

let cache: LiveCountsMap | null = null;

function load(): LiveCountsMap {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync(storeFile(), 'utf-8')) as LiveCountsMap;
  } catch {
    cache = {};
  }
  return cache;
}

export function getLiveCounts(): LiveCountsMap {
  // Return a copy — callers must not be able to mutate the in-memory cache directly.
  return JSON.parse(JSON.stringify(load())) as LiveCountsMap;
}

/**
 * Records a fresh count for one role of one target and persists it immediately.
 * Returns the timestamp it was stamped with, so the caller can push the same reading
 * to connected clients without re-reading the store.
 */
export function recordLiveCount(target: string, role: 'source' | 'dest', count: number): string {
  const map = load();
  const at = new Date().toISOString();
  const atKey = role === 'source' ? 'sourceAt' : 'destAt';
  map[target] = { ...map[target], [role]: count, [atKey]: at };
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(storeFile(), JSON.stringify(map, null, 2));
  } catch { /* best-effort — never fail the count job over persistence */ }
  return at;
}

/** Test seam — forget everything held in memory. */
export function resetLiveCountsCache(): void {
  cache = null;
}
