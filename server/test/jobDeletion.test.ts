import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// runner.ts reads DATA_DIR into a module-level const at import time, so the env var has to be
// set before the module is first loaded — a dynamic import after mkdtemp is the only way to
// point it at an isolated jobs directory instead of the real /data.
let root: string;
let jobsDir: string;
let runner: typeof import('../src/runner.js');

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'bw-job-deletion-'));
  jobsDir = join(root, 'jobs');
  mkdirSync(jobsDir, { recursive: true });
  process.env['DATA_DIR'] = root;
  runner = await import('../src/runner.js');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env['DATA_DIR'];
});

function writeJobFile(id: string, state: string): void {
  const job = {
    id,
    createdAt: new Date().toISOString(),
    state,
    targets: ['val'],
    operations: ['count'],
    options: {},
    steps: [],
    logs: [],
  };
  writeFileSync(join(jobsDir, `${id}.json`), JSON.stringify(job, null, 2));
}

describe('deleteJobs', () => {
  it('deletes a finished job from memory and disk', () => {
    const id = 'job-succeeded-1';
    writeJobFile(id, 'succeeded');
    runner.loadPersistedJobs();
    expect(runner.getJob(id)).toBeDefined();

    const result = runner.deleteJobs([id]);
    expect(result).toEqual({ deleted: [id], skipped: [] });
    expect(runner.getJob(id)).toBeUndefined();
    expect(existsSync(join(jobsDir, `${id}.json`))).toBe(false);
  });

  it('refuses to delete an active job and leaves it untouched', () => {
    const id = 'job-running-1';
    writeJobFile(id, 'running');
    runner.loadPersistedJobs();

    const result = runner.deleteJobs([id]);
    expect(result).toEqual({ deleted: [], skipped: [{ id, reason: 'active' }] });
    expect(runner.getJob(id)).toBeDefined();
    expect(existsSync(join(jobsDir, `${id}.json`))).toBe(true);
  });

  it('reports not-found for an unknown id without touching anything else', () => {
    const result = runner.deleteJobs(['does-not-exist']);
    expect(result).toEqual({ deleted: [], skipped: [{ id: 'does-not-exist', reason: 'not-found' }] });
  });

  it('handles a mixed batch: deletes the deletable ones, skips the rest', () => {
    writeJobFile('job-mix-done', 'failed');
    writeJobFile('job-mix-active', 'awaiting-confirmation');
    runner.loadPersistedJobs();

    const result = runner.deleteJobs(['job-mix-done', 'job-mix-active', 'job-mix-missing']);
    expect(result.deleted).toEqual(['job-mix-done']);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { id: 'job-mix-active', reason: 'active' },
        { id: 'job-mix-missing', reason: 'not-found' },
      ]),
    );
  });

  it('removes deleted jobs from listJobs() output', () => {
    const id = 'job-succeeded-2';
    writeJobFile(id, 'succeeded');
    runner.loadPersistedJobs();
    expect(runner.listJobs().some((j) => j.id === id)).toBe(true);

    runner.deleteJobs([id]);
    expect(runner.listJobs().some((j) => j.id === id)).toBe(false);
  });
});
