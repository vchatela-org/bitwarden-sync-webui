import { describe, it, expect, vi, beforeEach } from 'vitest';

const { runBwMock } = vi.hoisted(() => ({ runBwMock: vi.fn() }));

vi.mock('../src/bwCli.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/bwCli.js')>();
  return { ...actual, runBw: runBwMock };
});

const { bwInit } = await import('../src/session.js');
const { cachePassword, clearAllPasswords } = await import('../src/secrets.js');

const EU = 'https://vault.bitwarden.eu';
const SESSION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** Fake `bw` reporting a given status; login always fails asking for a two-step code. */
function fakeBw(status: { serverUrl: string | null; status: string }, loginOutput?: string) {
  return (args: string[]) => {
    if (args[0] === 'status') {
      return Promise.resolve({
        stdout: JSON.stringify({ success: true, data: { object: 'template', template: status } }),
        stderr: '',
        exitCode: 0,
      });
    }
    if (args[0] === 'login') {
      if (loginOutput === undefined) return Promise.resolve({ stdout: SESSION_KEY, stderr: '', exitCode: 0 });
      return Promise.resolve({ stdout: '', stderr: loginOutput, exitCode: 1 });
    }
    if (args[0] === 'unlock') return Promise.resolve({ stdout: SESSION_KEY, stderr: '', exitCode: 0 });
    return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
  };
}

const init = (extra: Record<string, unknown> = {}) => bwInit({
  accountKey: 'demo', profileLabel: 'demo@eu', email: 'demo@example.com',
  wantServer: EU, profileDir: '/tmp/demo', ...extra,
});

describe('two-step precheck', () => {
  beforeEach(() => {
    runBwMock.mockReset();
    clearAllPasswords();
  });

  it('tells the caller to ask for a code up front when a configured account must log in', async () => {
    runBwMock.mockImplementation(fakeBw({ serverUrl: EU, status: 'unauthenticated' }));

    const result = await init({ otpRequired: true });

    expect(result).toMatchObject({ ok: false, reason: 'needs-password', otpExpected: true });
    // Nothing was attempted — the hint costs only the status read.
    expect(runBwMock.mock.calls.map((c) => (c[0] as string[])[0])).toEqual(['status']);
  });

  it('does not ask for a code when the profile only needs unlocking', async () => {
    // `bw unlock` takes no code, so prompting would burn a single-use TOTP for nothing.
    runBwMock.mockImplementation(fakeBw({ serverUrl: EU, status: 'locked' }));

    const result = await init({ otpRequired: true });

    expect(result).toMatchObject({ ok: false, reason: 'needs-password', otpExpected: false });
  });

  it('asks for a code when a server switch is about to force a fresh login', async () => {
    runBwMock.mockImplementation(fakeBw({ serverUrl: 'https://vault.bitwarden.com', status: 'locked' }));

    const result = await init({ otpRequired: true });

    expect(result).toMatchObject({ ok: false, reason: 'needs-password', otpExpected: true });
  });

  it('never hints for an account that is not configured as needing two-step', async () => {
    runBwMock.mockImplementation(fakeBw({ serverUrl: EU, status: 'unauthenticated' }));

    const result = await init();

    expect(result).toMatchObject({ ok: false, reason: 'needs-password', otpExpected: false });
  });

  it('still discovers two-step reactively when the config does not record it', async () => {
    // 'unknown' means "not recorded", not "no two-step" — the CLI's own answer still governs.
    runBwMock.mockImplementation(fakeBw({ serverUrl: EU, status: 'unauthenticated' }, 'Code is required.'));
    cachePassword('demo', 'correct-horse');

    const result = await init();

    expect(result).toMatchObject({ ok: false, reason: 'needs-otp' });
  });

  it('passes a supplied code through to the CLI', async () => {
    runBwMock.mockImplementation(fakeBw({ serverUrl: EU, status: 'unauthenticated' }));
    cachePassword('demo', 'correct-horse');

    const result = await init({ otpRequired: true, otp: '123456', otpMethod: 1 });

    expect(result).toEqual({ ok: true, sessionKey: SESSION_KEY });
    const loginArgs = runBwMock.mock.calls.map((c) => c[0] as string[]).find((a) => a[0] === 'login')!;
    expect(loginArgs).toContain('--code');
    expect(loginArgs[loginArgs.indexOf('--code') + 1]).toBe('123456');
    expect(loginArgs[loginArgs.indexOf('--method') + 1]).toBe('1');
  });

  it('keeps hinting on the retry after a wrong password', async () => {
    runBwMock.mockImplementation(fakeBw({ serverUrl: EU, status: 'unauthenticated' }, 'Invalid master password.'));
    cachePassword('demo', 'wrong');

    const result = await init({ otpRequired: true });

    expect(result).toMatchObject({ ok: false, reason: 'needs-password', otpExpected: true });
  });
});
