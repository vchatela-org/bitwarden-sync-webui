import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Same constraint as jobDeletion.test.ts: runner.ts captures DATA_DIR at import time.
let root: string;
let jobsDir: string;
let runner: typeof import('../src/runner.js');

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'bw-job-cancel-'));
  jobsDir = join(root, 'jobs');
  mkdirSync(jobsDir, { recursive: true });
  process.env['DATA_DIR'] = root;
  runner = await import('../src/runner.js');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env['DATA_DIR'];
});

function step(id: string, state: string) {
  return { id, label: id, state, group: 'val' };
}

function writeJobFile(id: string, state: string, steps: ReturnType<typeof step>[] = []): void {
  writeJobFileRaw(id, { state, steps });
}

function writeJobFileRaw(id: string, over: Record<string, unknown>): void {
  writeFileSync(join(jobsDir, `${id}.json`), JSON.stringify({
    id,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    targets: ['org'],
    operations: ['both'],
    options: {},
    steps: [],
    logs: [],
    ...over,
  }, null, 2));
}

function stateOf(jobId: string, stepId: string): string | undefined {
  return runner.getJob(jobId)?.steps.find((s) => s.id === stepId)?.state;
}

describe('cancelJob', () => {
  it('settles every unfinished step so nothing is left spinning', () => {
    const id = 'job-cancel-steps';
    writeJobFile(id, 'running', [
      step('val:backup:login', 'succeeded'),
      step('val:import:org:purge', 'succeeded'),
      step('val:import:org:reconcile', 'running'),
      step('val:import:org:lock', 'pending'),
    ]);
    runner.loadPersistedJobs();

    expect(runner.cancelJob(id)).toBe(true);

    expect(runner.getJob(id)!.state).toBe('aborted');
    expect(stateOf(id, 'val:import:org:reconcile')).toBe('skipped');
    expect(stateOf(id, 'val:import:org:lock')).toBe('skipped');
    // Work that actually finished keeps its result
    expect(stateOf(id, 'val:backup:login')).toBe('succeeded');
    expect(stateOf(id, 'val:import:org:purge')).toBe('succeeded');
  });

  it('records why the steps stopped', () => {
    const id = 'job-cancel-detail';
    writeJobFile(id, 'running', [step('val:import:org:run', 'running')]);
    runner.loadPersistedJobs();
    runner.cancelJob(id);

    const s = runner.getJob(id)!.steps[0]!;
    expect(s.detail).toBe('Cancelled');
    expect(s.endedAt).toBeTruthy();
  });

  it('settles a step that is waiting on the user', () => {
    const id = 'job-cancel-awaiting';
    writeJobFileRaw(id, {
      state: 'awaiting-credentials',
      steps: [step('val:backup:login', 'awaiting-input')],
    });
    runner.loadPersistedJobs();

    expect(runner.cancelJob(id)).toBe(true);
    expect(stateOf(id, 'val:backup:login')).toBe('skipped');
  });

  it('clears a pending prompt', () => {
    const id = 'job-cancel-prompt';
    writeJobFileRaw(id, {
      state: 'awaiting-confirmation',
      steps: [step('val:import:org:diff', 'running')],
      prompt: { kind: 'confirmation', target: 'org', diff: { sourceCount: 0, destCount: 5, added: [], removed: [], unchanged: 0, guardTripped: true } },
    });
    runner.loadPersistedJobs();

    runner.cancelJob(id);
    expect(runner.getJob(id)!.prompt).toBeUndefined();
  });

  it('refuses to cancel a job that already finished, leaving its steps alone', () => {
    const id = 'job-cancel-done';
    writeJobFile(id, 'succeeded', [step('val:backup:login', 'succeeded')]);
    runner.loadPersistedJobs();

    expect(runner.cancelJob(id)).toBe(false);
    expect(runner.getJob(id)!.state).toBe('succeeded');
    expect(stateOf(id, 'val:backup:login')).toBe('succeeded');
  });

  it('is not repeatable — a second cancel is a no-op', () => {
    const id = 'job-cancel-twice';
    writeJobFile(id, 'running', [step('val:import:org:run', 'running')]);
    runner.loadPersistedJobs();

    expect(runner.cancelJob(id)).toBe(true);
    expect(runner.cancelJob(id)).toBe(false);
    expect(runner.getJob(id)!.state).toBe('aborted');
  });

  it('returns false for an unknown id', () => {
    expect(runner.cancelJob('no-such-job')).toBe(false);
  });
});
