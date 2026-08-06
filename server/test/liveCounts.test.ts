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

  it('records a cloud count with a timestamp', () => {
    recordLiveCount('val', 'cloud', 42);
    const counts = getLiveCounts();
    expect(counts['val']?.cloud).toBe(42);
    expect(counts['val']?.cloudAt).toBeTruthy();
    expect(counts['val']?.home).toBeUndefined();
  });

  it('keeps cloud and home counts independent, each with its own timestamp', () => {
    recordLiveCount('val', 'cloud', 42);
    recordLiveCount('val', 'home', 40);
    const counts = getLiveCounts();
    expect(counts['val']).toMatchObject({ cloud: 42, home: 40 });
    expect(counts['val']?.cloudAt).toBeTruthy();
    expect(counts['val']?.homeAt).toBeTruthy();
  });

  it('overwrites a stale count for the same target and side without touching the other side', () => {
    recordLiveCount('val', 'cloud', 42);
    recordLiveCount('val', 'home', 40);
    recordLiveCount('val', 'cloud', 43);
    const counts = getLiveCounts();
    expect(counts['val']).toMatchObject({ cloud: 43, home: 40 });
  });

  it('persists to disk so a restart does not lose counts', () => {
    recordLiveCount('val', 'cloud', 7);
    const onDisk = JSON.parse(readFileSync(join(root, 'live-counts.json'), 'utf-8')) as Record<string, { cloud?: number }>;
    expect(onDisk['val']?.cloud).toBe(7);

    resetLiveCountsCache();
    expect(getLiveCounts()['val']?.cloud).toBe(7);
  });

  it('does not let the caller mutate the internal cache', () => {
    recordLiveCount('val', 'cloud', 1);
    const counts = getLiveCounts();
    counts['val']!.cloud = 999;
    expect(getLiveCounts()['val']?.cloud).toBe(1);
  });

  it('tracks multiple targets independently', () => {
    recordLiveCount('val', 'cloud', 10);
    recordLiveCount('org', 'cloud', 20);
    const counts = getLiveCounts();
    expect(counts['val']?.cloud).toBe(10);
    expect(counts['org']?.cloud).toBe(20);
  });
});
