import { describe, it, expect, vi, beforeEach } from 'vitest';

const { runBwMock } = vi.hoisted(() => ({ runBwMock: vi.fn() }));

vi.mock('../src/bwCli.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/bwCli.js')>();
  return { ...actual, runBw: runBwMock };
});

const { bwInit } = await import('../src/session.js');
const { cachePassword, clearAllPasswords, hasPassword } = await import('../src/secrets.js');

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

  it('offers the code as optional when the profile only needs unlocking', async () => {
    // `bw unlock` takes no code, but the saved sign-in behind it may have expired — then the
    // unlock becomes a full login, and a code collected now saves a second prompt.
    runBwMock.mockImplementation(fakeBw({ serverUrl: EU, status: 'locked' }));

    const result = await init({ otpRequired: true });

    expect(result).toMatchObject({ ok: false, reason: 'needs-password', otpExpected: false, otpOptional: true });
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

    const result = await init({ otpRequired: true, otp: '123456' });

    expect(result).toMatchObject({ ok: false, reason: 'needs-password', otpExpected: true });
    expect(hasPassword('demo')).toBe(false);
  });

  it('asks only for the code when the password is cached but a configured login has none', async () => {
    // e.g. the password came from "use this password for … too" — the CLI is certain to answer
    // "Code is required.", so no login attempt is spent finding that out.
    runBwMock.mockImplementation(fakeBw({ serverUrl: EU, status: 'unauthenticated' }));
    cachePassword('demo', 'correct-horse');

    const result = await init({ otpRequired: true });

    expect(result).toMatchObject({ ok: false, reason: 'needs-otp', passwordCached: true });
    expect(runBwMock.mock.calls.some((c) => (c[0] as string[])[0] === 'login')).toBe(false);
  });

  it('keeps the password when only the two-step code was wrong', async () => {
    runBwMock.mockImplementation(fakeBw({ serverUrl: EU, status: 'unauthenticated' }, 'Two-step token is invalid. Try again.'));
    cachePassword('demo', 'correct-horse');

    const result = await init({ otpRequired: true, otp: '000000' });

    expect(result).toMatchObject({ ok: false, reason: 'needs-otp', passwordCached: true });
    expect(hasPassword('demo')).toBe(true);
  });
});

/**
 * A profile that reports `locked` whose stored sign-in the server no longer accepts: `bw unlock`
 * dies on an unhandled invalid_grant and the CLI drops the profile to unauthenticated. This is
 * what a cloud account looks like after a few weeks between runs.
 */
function expiredSignInBw(loginOutput?: string) {
  let status = 'locked';
  return (args: string[]) => {
    if (args[0] === 'status') {
      return Promise.resolve({
        stdout: JSON.stringify({ success: true, data: { object: 'template', template: { serverUrl: EU, status } } }),
        stderr: '',
        exitCode: 0,
      });
    }
    if (args[0] === 'unlock') {
      status = 'unauthenticated';
      return Promise.resolve({
        stdout: '',
        stderr: "  response: { error: 'invalid_grant' },\n  statusCode: 400\n  code: 'ERR_UNHANDLED_REJECTION'",
        exitCode: 1,
      });
    }
    if (args[0] === 'login') {
      if (loginOutput !== undefined) return Promise.resolve({ stdout: '', stderr: loginOutput, exitCode: 1 });
      status = 'unlocked';
      return Promise.resolve({ stdout: SESSION_KEY, stderr: '', exitCode: 0 });
    }
    return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
  };
}

describe('expired saved sign-in', () => {
  beforeEach(() => {
    runBwMock.mockReset();
    clearAllPasswords();
    cachePassword('demo', 'correct-horse');
  });

  it('logs in again in the same call when the prompt already collected the code', async () => {
    runBwMock.mockImplementation(expiredSignInBw());

    const result = await init({ otpRequired: true, otp: '123456', otpMethod: 0 });

    expect(result).toEqual({ ok: true, sessionKey: SESSION_KEY });
    const verbs = runBwMock.mock.calls.map((c) => (c[0] as string[])[0]);
    expect(verbs.indexOf('unlock')).toBeLessThan(verbs.indexOf('login'));
    const loginArgs = runBwMock.mock.calls.map((c) => c[0] as string[]).find((a) => a[0] === 'login')!;
    expect(loginArgs[loginArgs.indexOf('--code') + 1]).toBe('123456');
  });

  it('keeps the (correct) password and asks only for the code when none was given', async () => {
    // Regression: the unlock failure was read as a wrong password — the password was dropped
    // and the user prompted twice more (password, then password + code).
    runBwMock.mockImplementation(expiredSignInBw());

    const result = await init({ otpRequired: true });

    expect(result).toMatchObject({ ok: false, reason: 'needs-otp', passwordCached: true });
    expect(hasPassword('demo')).toBe(true);
  });

  it('discovers two-step reactively for an account the config does not record', async () => {
    runBwMock.mockImplementation(expiredSignInBw('Code is required.'));

    const result = await init();

    expect(result).toMatchObject({ ok: false, reason: 'needs-otp', passwordCached: true });
    expect(hasPassword('demo')).toBe(true);
  });

  it('still treats a plain unlock failure as a wrong password', async () => {
    runBwMock.mockImplementation((args: string[]) => {
      if (args[0] === 'unlock') return Promise.resolve({ stdout: '', stderr: 'Invalid master password.', exitCode: 1 });
      return fakeBw({ serverUrl: EU, status: 'locked' })(args);
    });

    const result = await init({ otpRequired: true });

    expect(result).toMatchObject({ ok: false, reason: 'needs-password', otpExpected: false });
    expect(hasPassword('demo')).toBe(false);
    expect(runBwMock.mock.calls.some((c) => (c[0] as string[])[0] === 'login')).toBe(false);
  });
});
