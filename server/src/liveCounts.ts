import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * Live item counts pulled straight from the vault (cloud/home) by a 'count' job, as opposed to
 * the counts recovered from an export sidecar (see backupCounts.ts). These only change when a
 * count job runs, so each side carries its own timestamp — cloud and home are fetched at
 * different points during the job and a stale count read days apart from a fresh one otherwise
 * looks identical in the UI.
 */
export interface LiveCountEntry {
  cloud?: number;
  cloudAt?: string;
  home?: number;
  homeAt?: string;
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

/** Records a fresh count for one side of one target and persists it immediately. */
export function recordLiveCount(target: string, side: 'cloud' | 'home', count: number): void {
  const map = load();
  const at = side === 'cloud' ? 'cloudAt' : 'homeAt';
  map[target] = { ...map[target], [side]: count, [at]: new Date().toISOString() };
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(storeFile(), JSON.stringify(map, null, 2));
  } catch { /* best-effort — never fail the count job over persistence */ }
}

/** Test seam — forget everything held in memory. */
export function resetLiveCountsCache(): void {
  cache = null;
}
