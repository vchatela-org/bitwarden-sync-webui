import { readFileSync, writeFileSync, mkdirSync, openSync, fstatSync, closeSync } from 'fs';
import { join } from 'path';

/**
 * Item/folder/collection counts recovered straight from an export file.
 *
 * Sidecar `.meta.json` files only exist for backups produced by the web UI, and
 * only since sidecars were introduced — every export made by bitwarden_export.sh
 * before that has none. The account-key encrypted export (`*_encrypted.json`)
 * still carries a plain-text JSON envelope whose `items`/`folders`/`collections`
 * arrays are countable even though every field inside them is ciphertext, so the
 * counts are recoverable without the vault password.
 *
 * The password-protected export (`*_encrypted_pass.json`) is a single opaque
 * blob and yields nothing — always derive from the account-key file.
 */
export interface DerivedCounts {
  itemCount: number;
  folderCount: number;
  collectionCount: number;
}

interface CacheEntry extends DerivedCounts {
  /** Identity of the file the counts were read from. */
  size: number;
  /** Whole milliseconds — sub-ms mtime precision is not portable across filesystems. */
  mtimeMs: number;
}

/** Read at call time, not module load, so tests can redirect it. */
function dataDir(): string {
  return process.env['DATA_DIR'] ?? '/data';
}

function cacheFile(): string {
  return join(dataDir(), 'backup-counts.json');
}

/** path → counts. Exports are immutable once written, so size+mtime is a safe key. */
let cache: Map<string, CacheEntry> | null = null;
let cacheDirty = false;

function loadCache(): Map<string, CacheEntry> {
  if (cache) return cache;
  cache = new Map();
  try {
    const raw = JSON.parse(readFileSync(cacheFile(), 'utf-8')) as Record<string, CacheEntry>;
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v?.itemCount === 'number' && typeof v?.size === 'number') cache.set(k, v);
    }
  } catch { /* no cache yet, or corrupt — rebuild from scratch */ }
  return cache;
}

/** Persist the cache so a restart does not re-read every export in the folder. */
export function flushCountCache(): void {
  if (!cacheDirty || !cache) return;
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(cacheFile(), JSON.stringify(Object.fromEntries(cache), null, 2));
    cacheDirty = false;
  } catch { /* cache is an optimisation — never fail the request over it */ }
}

function countArray(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  return Array.isArray(v) ? v.length : 0;
}

/**
 * Read counts out of an account-key encrypted export, memoised on size+mtime.
 * Returns null when the file is unreadable or is not a countable export.
 */
export function deriveCounts(path: string): DerivedCounts | null {
  // Stat and read through the same fd (not by path) so the file can't be swapped
  // out between the size/mtime check and the read.
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    const mtimeMs = Math.floor(stat.mtimeMs);
    const map = loadCache();
    const hit = map.get(path);
    if (hit && hit.size === stat.size && hit.mtimeMs === mtimeMs) {
      return { itemCount: hit.itemCount, folderCount: hit.folderCount, collectionCount: hit.collectionCount };
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(fd, 'utf-8')) as Record<string, unknown>;
    } catch {
      return null;
    }
    // A password-protected export has no arrays to count, just a `data` blob.
    if (!Array.isArray(parsed['items'])) return null;

    const counts: DerivedCounts = {
      itemCount: countArray(parsed, 'items'),
      folderCount: countArray(parsed, 'folders'),
      collectionCount: countArray(parsed, 'collections'),
    };
    map.set(path, { ...counts, size: stat.size, mtimeMs });
    cacheDirty = true;
    return counts;
  } finally {
    closeSync(fd);
  }
}

/** Drop cache entries for files that no longer exist (e.g. after a prune). */
export function pruneCountCache(livePaths: Set<string>): void {
  const map = loadCache();
  for (const path of map.keys()) {
    if (!livePaths.has(path)) {
      map.delete(path);
      cacheDirty = true;
    }
  }
}

/** Test seam — forget everything held in memory. */
export function resetCountCache(): void {
  cache = null;
  cacheDirty = false;
}
