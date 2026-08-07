import { describe, it, expect } from 'vitest';
import { planStaleCollections, BwCollection } from '../src/collections.js';

function col(id: string, name: string): BwCollection {
  return { id, name, organizationId: 'org1' };
}

describe('planStaleCollections', () => {
  it('returns an empty plan when the importer created nothing new', () => {
    const cols = [col('a', 'Family'), col('b', 'Work')];
    expect(planStaleCollections(cols, ['a', 'b'])).toHaveLength(0);
  });

  it('plans removal of the pre-import collection the importer superseded', () => {
    const cols = [
      col('orig-a', 'Family'), // pre-existing, emptied by the purge
      col('new-a', 'Family'),  // created by the importer, holds this run's items
    ];
    const plan = planStaleCollections(cols, ['orig-a']);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ staleId: 'orig-a', replacementId: 'new-a', name: 'Family' });
  });

  it('leaves a pre-import collection the export does not cover', () => {
    const cols = [
      col('orig-a', 'Family'),
      col('orig-default', 'Default collection'), // no replacement — export has no such items
      col('new-a', 'Family'),
    ];
    const plan = planStaleCollections(cols, ['orig-a', 'orig-default']);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.staleId).toBe('orig-a');
  });

  it('never plans removal of a collection the importer created', () => {
    const cols = [col('orig-a', 'Family'), col('new-a', 'Family'), col('new-b', 'Brand New')];
    const plan = planStaleCollections(cols, ['orig-a']);
    expect(plan.map((p) => p.staleId)).toEqual(['orig-a']);
  });

  it('is case-insensitive for name matching', () => {
    const cols = [col('orig', 'FAMILY'), col('new', 'family')];
    const plan = planStaleCollections(cols, ['orig']);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.staleId).toBe('orig');
    expect(plan[0]!.replacementId).toBe('new');
  });

  it('handles multiple superseded collections', () => {
    const cols = [
      col('orig-a', 'Alpha'),
      col('orig-b', 'Beta'),
      col('new-a', 'Alpha'),
      col('new-b', 'Beta'),
    ];
    const plan = planStaleCollections(cols, ['orig-a', 'orig-b']);
    expect(plan.map((p) => p.staleId).sort()).toEqual(['orig-a', 'orig-b']);
  });

  it('plans both when the destination already held two same-named collections', () => {
    const cols = [col('orig-a1', 'Alpha'), col('orig-a2', 'Alpha'), col('new-a', 'Alpha')];
    const plan = planStaleCollections(cols, ['orig-a1', 'orig-a2']);
    expect(plan.map((p) => p.staleId).sort()).toEqual(['orig-a1', 'orig-a2']);
    expect(plan.every((p) => p.replacementId === 'new-a')).toBe(true);
  });

  it('plans nothing when the import produced no collections at all', () => {
    const cols = [col('orig-a', 'Alpha'), col('orig-b', 'Beta')];
    expect(planStaleCollections(cols, ['orig-a', 'orig-b'])).toHaveLength(0);
  });
});
