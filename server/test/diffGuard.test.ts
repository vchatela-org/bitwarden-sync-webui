import { describe, it, expect } from 'vitest';
import { evaluateGuard, DiffResult } from '../src/diff.js';

function makeDiff(overrides: Partial<DiffResult> = {}): DiffResult {
  return {
    sourceCount: 100,
    destCount: 100,
    added: [],
    removed: [],
    unchanged: 100,
    guardTripped: false,
    ...overrides,
  };
}

describe('evaluateGuard', () => {
  const defaultConfig = { minSourceRatio: 0.5, blockOnEmptySource: true };

  it('does not block a healthy case', () => {
    const result = evaluateGuard(makeDiff({ sourceCount: 100, destCount: 100 }), defaultConfig);
    expect(result.blocked).toBe(false);
  });

  it('blocks when sourceCount is unknown', () => {
    const result = evaluateGuard(makeDiff({ sourceCount: 'unknown' }), defaultConfig);
    expect(result.blocked).toBe(true);
  });

  it('blocks when source is empty and blockOnEmptySource=true', () => {
    const result = evaluateGuard(makeDiff({ sourceCount: 0, destCount: 10 }), { ...defaultConfig, blockOnEmptySource: true });
    expect(result.blocked).toBe(true);
  });

  it('does not block when source is empty and blockOnEmptySource=false', () => {
    const result = evaluateGuard(makeDiff({ sourceCount: 0, destCount: 0 }), { ...defaultConfig, blockOnEmptySource: false });
    expect(result.blocked).toBe(false);
  });

  it('blocks when source count is below ratio', () => {
    // 40 < 0.5 * 100
    const result = evaluateGuard(makeDiff({ sourceCount: 40, destCount: 100 }), defaultConfig);
    expect(result.blocked).toBe(true);
  });

  it('does not block when source count is at ratio boundary', () => {
    // 50 >= 0.5 * 100
    const result = evaluateGuard(makeDiff({ sourceCount: 50, destCount: 100 }), defaultConfig);
    expect(result.blocked).toBe(false);
  });

  it('does not block when dest is 0 (nothing to compare against)', () => {
    const result = evaluateGuard(makeDiff({ sourceCount: 10, destCount: 0 }), defaultConfig);
    expect(result.blocked).toBe(false);
  });

  it('blocks when source is way below ratio', () => {
    const result = evaluateGuard(makeDiff({ sourceCount: 1, destCount: 400 }), defaultConfig);
    expect(result.blocked).toBe(true);
  });
});
