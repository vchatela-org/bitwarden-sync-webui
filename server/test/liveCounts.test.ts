import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getLiveCounts, recordLiveCount, resetLiveCountsCache } from '../src/liveCounts.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bw-live-counts-'));
  process.env['DATA_DIR'] = root;
  resetLiveCountsCache();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env['DATA_DIR'];
  resetLiveCountsCache();
});

describe('live counts persistence', () => {
  it('starts empty when nothing has been recorded', () => {
    expect(getLiveCounts()).toEqual({});
  });

  it('records a source count with a timestamp', () => {
    recordLiveCount('val', 'source', 42);
    const counts = getLiveCounts();
    expect(counts['val']?.source).toBe(42);
    expect(counts['val']?.sourceAt).toBeTruthy();
    expect(counts['val']?.dest).toBeUndefined();
  });

  it('keeps source and dest counts independent, each with its own timestamp', () => {
    recordLiveCount('val', 'source', 42);
    recordLiveCount('val', 'dest', 40);
    const counts = getLiveCounts();
    expect(counts['val']).toMatchObject({ source: 42, dest: 40 });
    expect(counts['val']?.sourceAt).toBeTruthy();
    expect(counts['val']?.destAt).toBeTruthy();
  });

  it('overwrites a stale count for the same target and role without touching the other role', () => {
    recordLiveCount('val', 'source', 42);
    recordLiveCount('val', 'dest', 40);
    recordLiveCount('val', 'source', 43);
    const counts = getLiveCounts();
    expect(counts['val']).toMatchObject({ source: 43, dest: 40 });
  });

  it('persists to disk so a restart does not lose counts', () => {
    recordLiveCount('val', 'source', 7);
    const onDisk = JSON.parse(readFileSync(join(root, 'live-counts.json'), 'utf-8')) as Record<string, { source?: number }>;
    expect(onDisk['val']?.source).toBe(7);

    resetLiveCountsCache();
    expect(getLiveCounts()['val']?.source).toBe(7);
  });

  it('does not let the caller mutate the internal cache', () => {
    recordLiveCount('val', 'source', 1);
    const counts = getLiveCounts();
    counts['val']!.source = 999;
    expect(getLiveCounts()['val']?.source).toBe(1);
  });

  it('tracks multiple targets independently', () => {
    recordLiveCount('val', 'source', 10);
    recordLiveCount('org', 'source', 20);
    const counts = getLiveCounts();
    expect(counts['val']?.source).toBe(10);
    expect(counts['org']?.source).toBe(20);
  });
});
