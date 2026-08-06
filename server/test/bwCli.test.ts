import { describe, it, expect, beforeAll } from 'vitest';
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
