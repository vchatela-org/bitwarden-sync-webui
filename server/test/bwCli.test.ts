import { describe, it, expect, beforeAll, vi } from 'vitest';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

beforeAll(() => {
  process.env['BW_BIN'] = join(__dirname, 'fixtures', 'fake-bw.sh');
});

describe('runBw silenceStdout', () => {
  it('keeps stdout out of onLog when silenceStdout is set, but still returns it to the caller', async () => {
    const { runBw } = await import('../src/bwCli.js');
    const logged: Array<{ stream: string; line: string }> = [];

    const result = await runBw(
      ['list', 'items', '--session', 'x'],
      { profileDir: '/tmp', silenceStdout: true },
      (stream, line) => logged.push({ stream, line }),
    );

    // The caller still gets the full output to parse (item counts, etc.)...
    expect(result.stdout).toContain('hunter2');
    // ...but nothing containing vault data was ever handed to the log/UI.
    expect(logged.some((l) => l.line.includes('hunter2'))).toBe(false);
    expect(logged.some((l) => l.stream === 'stdout')).toBe(false);
    // stderr diagnostics still flow through so failures remain debuggable.
    expect(logged.some((l) => l.stream === 'stderr' && l.line.includes('diagnostic warning'))).toBe(true);
  });

  it('forwards stdout to onLog by default (unchanged behavior for normal commands)', async () => {
    const { runBw } = await import('../src/bwCli.js');
    const logged: Array<{ stream: string; line: string }> = [];

    await runBw(['status'], { profileDir: '/tmp' }, (stream, line) => logged.push({ stream, line }));

    expect(logged.some((l) => l.stream === 'stdout')).toBe(true);
  });
});

describe('runBw noisy interactive-prompt output', () => {
  const PROMPT_BIN = join(__dirname, 'fixtures', 'fake-bw-export-prompt.sh');

  it('collapses consecutive duplicate redraw lines and strips their ANSI escapes', async () => {
    const prevBin = process.env['BW_BIN'];
    process.env['BW_BIN'] = PROMPT_BIN;
    vi.resetModules();
    try {
      const { runBw } = await import('../src/bwCli.js');
      const logged: Array<{ stream: string; line: string }> = [];

      await runBw(
        ['export', '--format', 'encrypted_json', '--password'],
        { profileDir: '/tmp', stdin: 'hunter2' },
        (stream, line) => logged.push({ stream, line }),
      );

      const stderrLines = logged.filter((l) => l.stream === 'stderr').map((l) => l.line);
      // 5 identical redraws + 1 distinct "Saved ..." line, not 6 separate log entries.
      expect(stderrLines).toHaveLength(2);
      expect(stderrLines[0]).toBe('? Export file password: [input is hidden]  (×5)');
      expect(stderrLines[0]).not.toMatch(/\x1b/);
      expect(stderrLines[1]).toBe('Saved /backups/export.json');

      // The raw stderr returned to the caller is untouched — still every line, with escapes.
      const result = await runBw(
        ['export', '--format', 'encrypted_json', '--password'],
        { profileDir: '/tmp', stdin: 'hunter2' },
      );
      expect(result.stderr.match(/\[input is hidden\]/g)).toHaveLength(5);
    } finally {
      process.env['BW_BIN'] = prevBin;
      vi.resetModules();
    }
  });
});

describe('runBw raw session key output', () => {
  const RAW_BIN = join(__dirname, 'fixtures', 'fake-bw-raw.sh');
  const FAKE_KEY = 'FakeSessionKeyThatLooksLikeBase64==';

  it('returns the unredacted key to the caller while redacting what reaches onLog', async () => {
    const prevBin = process.env['BW_BIN'];
    process.env['BW_BIN'] = RAW_BIN;
    // BW_BIN is read into a module-level const at import time, and the previous test file
    // already imported bwCli.js with fake-bw.sh baked in — force a fresh evaluation so this
    // test's env var change actually takes effect.
    vi.resetModules();
    try {
      const { runBw, isValidSessionKey } = await import('../src/bwCli.js');
      const logged: Array<{ stream: string; line: string }> = [];

      const result = await runBw(
        ['unlock', '--raw'],
        { profileDir: '/tmp' },
        (stream, line) => logged.push({ stream, line }),
      );

      // The programmatic caller (session.ts) must see the real key — it fails
      // isValidSessionKey() otherwise and the unlock is wrongly treated as failed.
      expect(result.stdout).toBe(FAKE_KEY);
      expect(isValidSessionKey(result.stdout)).toBe(true);
      // The log/UI stream must never see the raw key.
      expect(logged.some((l) => l.line.includes(FAKE_KEY))).toBe(false);
      expect(logged.some((l) => l.line.includes('[SESSION_KEY]'))).toBe(true);
    } finally {
      process.env['BW_BIN'] = prevBin;
      vi.resetModules();
    }
  });
});

describe('runBw when the child exits before reading stdin', () => {
  const EXIT_EARLY_BIN = join(__dirname, 'fixtures', 'fake-bw-exit-early.sh');

  it('reports the child\'s exit instead of dying on the EPIPE from the closed pipe', async () => {
    const prevBin = process.env['BW_BIN'];
    process.env['BW_BIN'] = EXIT_EARLY_BIN;
    vi.resetModules();
    try {
      const { runBw } = await import('../src/bwCli.js');

      // Big enough that the write cannot complete in one go, so it is still in flight
      // when the child exits and the read end of the pipe goes away.
      const result = await runBw(
        ['export', '--password'],
        { profileDir: '/tmp', stdin: 'x'.repeat(1024 * 1024) },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Not enough arguments.');
    } finally {
      process.env['BW_BIN'] = prevBin;
      vi.resetModules();
    }
  });
});
