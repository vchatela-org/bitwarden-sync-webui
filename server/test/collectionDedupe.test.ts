import { describe, it, expect } from 'vitest';
import { planCollectionMerge, BwCollection } from '../src/collections.js';

function col(id: string, name: string): BwCollection {
  return { id, name, organizationId: 'org1' };
}

describe('planCollectionMerge', () => {
  it('returns empty plan when importer reused originals (no new collections)', () => {
    const cols = [col('a', 'Family'), col('b', 'Work')];
    const preIds = ['a', 'b'];
    expect(planCollectionMerge(cols, preIds)).toHaveLength(0);
  });

  it('plans a merge when importer created a duplicate same-named collection', () => {
    const cols = [
      col('orig-a', 'Family'), // pre-existing, permissioned
      col('dup-a', 'Family'),  // created by importer (duplicate)
    ];
    const preIds = ['orig-a'];
    const plan = planCollectionMerge(cols, preIds);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ duplicateId: 'dup-a', originalId: 'orig-a', name: 'Family' });
  });

  it('leaves genuinely new collections alone (no matching original)', () => {
    const cols = [
      col('orig-a', 'Family'),
      col('new-b', 'New Collection'), // truly new, no pre-existing match
    ];
    const preIds = ['orig-a'];
    const plan = planCollectionMerge(cols, preIds);
    expect(plan).toHaveLength(0); // new-b has no original to merge into
  });

  it('is case-insensitive for name matching', () => {
    const cols = [
      col('orig', 'FAMILY'),
      col('dup', 'family'),
    ];
    const preIds = ['orig'];
    const plan = planCollectionMerge(cols, preIds);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.duplicateId).toBe('dup');
    expect(plan[0]!.originalId).toBe('orig');
  });

  it('handles multiple duplicates', () => {
    const cols = [
      col('orig-a', 'Alpha'),
      col('orig-b', 'Beta'),
      col('dup-a', 'Alpha'),
      col('dup-b', 'Beta'),
    ];
    const preIds = ['orig-a', 'orig-b'];
    const plan = planCollectionMerge(cols, preIds);
    expect(plan).toHaveLength(2);
    const dupIds = plan.map((p) => p.duplicateId).sort();
    expect(dupIds).toEqual(['dup-a', 'dup-b'].sort());
  });

  it('ignores a duplicate if its name has no pre-existing match', () => {
    const cols = [
      col('orig-a', 'Alpha'),
      col('new-c', 'Gamma'), // new name, no original
    ];
    const preIds = ['orig-a'];
    const plan = planCollectionMerge(cols, preIds);
    expect(plan).toHaveLength(0);
  });
});
