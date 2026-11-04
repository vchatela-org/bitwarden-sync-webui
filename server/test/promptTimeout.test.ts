import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Config } from '../src/config.js';

// bw is not available (and must not be run) in a unit test: make the source login ask for a
// password immediately, so the run reaches the prompt and then the timeout.
vi.mock('../src/session.js', () => ({
  bwInit: vi.fn(async () => ({ ok: false, reason: 'needs-password' })),
  lockProfile: vi.fn(async () => { /* no-op */ }),
  logoutProfile: vi.fn(async () => { /* no-op */ }),
  listItems: vi.fn(async () => []),
  listOrgCollections: vi.fn(async () => []),
}));

vi.mock('../src/bwCli.js', () => ({
  runBw: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
  getCliVersion: vi.fn(async () => 'test'),
}));

// Same constraint as jobCancel.test.ts: runner.ts captures DATA_DIR at import time.
let root: string;
let runner: typeof import('../src/runner.js');
let config: Config;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'bw-prompt-timeout-'));
  mkdirSync(join(root, 'jobs'), { recursive: true });
  process.env['DATA_DIR'] = root;
  runner = await import('../src/runner.js');

  config = {
    vaults: [
      { key: 'cloud', name: 'Cloud', serverUrl: 'https://cloud.example.com' },
      { key: 'home', name: 'Home', serverUrl: 'https://home.example.com' },
    ],
    backupFolder: join(root, 'backups'),
    bitwardenConfigDir: join(root, 'bw'),
    accounts: [
      { key: 'val@cloud', vault: 'cloud', email: 'val@example.com' },
      { key: 'val@home', vault: 'home', email: 'val@example.com' },
    ],
    orgs: [],
    syncs: [{ key: 'val', from: 'val@cloud', to: 'val@home' }],
    retention: { keepDaily: 7, keepMonthly: 12 },
    importGuard: { minSourceRatio: 0.5, blockOnEmptySource: true },
    logoutAfterImport: true,
  } as Config;

  // api.ts does this at startup; without it the runner cannot hand the slot to a queued job.
  runner.setGlobalConfig(config);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env['DATA_DIR'];
});

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for condition');
}

describe('unanswered prompts', () => {
  it('stops the run and releases the queue instead of re-prompting for every account', async () => {
    // confirmTimeout floor is 1 s, so the prompt times out quickly.
    const first = runner.createJob(['val'], ['both'], { confirmTimeout: 1000 }, config);
    const second = runner.createJob(['val'], ['both'], { confirmTimeout: 1000 }, config);

    await waitFor(() => runner.getJob(first.id)!.state === 'awaiting-credentials');
    expect(runner.getJob(second.id)!.state).toBe('queued');

    await waitFor(() => runner.getJob(first.id)!.state === 'failed');

    const failed = runner.getJob(first.id)!;
    expect(failed.endedAt).toBeTruthy();
    expect(failed.logs.some((l) => /No answer to the .* credential prompt/.test(l.line))).toBe(true);
    // The destination login for the same source account must never be prompted.
    expect(failed.steps.find((s) => s.id === 'val@cloud:import:val@home:login')?.state).toBe('skipped');

    // The single runner slot was released: the queued job starts on its own.
    await waitFor(() => runner.getJob(second.id)!.state === 'awaiting-credentials');
    runner.cancelJob(second.id);
  });
});
