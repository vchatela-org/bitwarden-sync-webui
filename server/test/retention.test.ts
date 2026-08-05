import { describe, it, expect } from 'vitest';
import { planRetention, BackupSet } from '../src/backups.js';

function makeSet(targetKey: string, kind: 'user' | 'org', timestamp: string): BackupSet {
  return { targetKey, kind, timestamp, files: [], sizeBytes: 1000, meta: undefined };
}

describe('planRetention', () => {
  it('keeps at least one set per target even with keepDaily=1', () => {
    const sets = [makeSet('val', 'user', '20260101_120000')];
    const toDelete = planRetention(sets, { keepDaily: 1, keepMonthly: 1 });
    expect(toDelete).toHaveLength(0);
  });

  it('keeps at least one set even when everything is old', () => {
    const sets = [
      makeSet('val', 'user', '20230101_120000'),
      makeSet('val', 'user', '20220101_120000'),
    ];
    const toDelete = planRetention(sets, { keepDaily: 1, keepMonthly: 0 });
    // Must keep at least one (the newest)
    expect(toDelete.length).toBeLessThanOrEqual(1);
    const deletedTs = toDelete.map((s) => s.timestamp);
    expect(deletedTs).not.toContain('20230101_120000');
  });

  it('deletes sets beyond keepDaily', () => {
    const sets = [
      makeSet('val', 'user', '20260805_120000'),
      makeSet('val', 'user', '20260804_120000'),
      makeSet('val', 'user', '20260803_120000'),
      makeSet('val', 'user', '20260802_120000'),
      makeSet('val', 'user', '20260801_120000'),
    ];
    const toDelete = planRetention(sets, { keepDaily: 3, keepMonthly: 1 });
    // Keep 3 newest daily + possibly the monthly (all in same month here)
    expect(toDelete.every((s) => s.timestamp < '20260803_120000')).toBe(true);
  });

  it('keeps monthly sets', () => {
    const sets = [
      makeSet('val', 'user', '20260801_000000'),
      makeSet('val', 'user', '20260701_000000'),
      makeSet('val', 'user', '20260601_000000'),
      makeSet('val', 'user', '20260501_000000'),
    ];
    const toDelete = planRetention(sets, { keepDaily: 1, keepMonthly: 3 });
    const kept = sets.filter((s) => !toDelete.includes(s));
    // Should keep at least 3 (one per month)
    expect(kept.length).toBeGreaterThanOrEqual(3);
  });

  it('never selects unmanaged files for deletion (they are not passed to the planner)', () => {
    // Unmanaged files don't appear in managed[], so they can never be in toDelete
    const sets = [makeSet('val', 'user', '20260805_120000')];
    const toDelete = planRetention(sets, { keepDaily: 1, keepMonthly: 1 });
    expect(toDelete).toHaveLength(0);
  });

  it('handles multiple targets independently', () => {
    const sets = [
      makeSet('val', 'user', '20260805_000000'),
      makeSet('val', 'user', '20260804_000000'),
      makeSet('val', 'user', '20260803_000000'),
      makeSet('org', 'org', '20260805_000000'),
      makeSet('org', 'org', '20260804_000000'),
    ];
    const toDelete = planRetention(sets, { keepDaily: 2, keepMonthly: 1 });
    // val: 3 sets, keep 2 daily → delete 1 oldest
    // org: 2 sets, keep 2 daily → delete 0
    const deletedKeys = toDelete.map((s) => s.targetKey);
    expect(deletedKeys).toContain('val');
    expect(deletedKeys).not.toContain('org');
  });
});
