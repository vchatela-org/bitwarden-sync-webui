import { describe, it, expect, vi, beforeEach } from 'vitest';

const { runBwMock } = vi.hoisted(() => ({ runBwMock: vi.fn() }));

vi.mock('../src/bwCli.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/bwCli.js')>();
  return { ...actual, runBw: runBwMock };
});

const { bwInit, DEFAULT_BW_SERVER } = await import('../src/session.js');
const { cachePassword, clearAllPasswords } = await import('../src/secrets.js');

const SESSION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const EU = 'https://vault.bitwarden.eu';

/** Fake `bw` whose `status` reports the given server/status; everything else succeeds. */
function fakeBw(status: { serverUrl: string | null; status: string }) {
  return (args: string[]) => {
    if (args[0] === 'status') {
      return Promise.resolve({
        stdout: JSON.stringify({ success: true, data: { object: 'template', template: status } }),
        stderr: '',
        exitCode: 0,
      });
    }
    if (args[0] === 'login' || args[0] === 'unlock') {
      return Promise.resolve({ stdout: SESSION_KEY, stderr: '', exitCode: 0 });
    }
    return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
  };
}

/** The args of every `bw` invocation, e.g. [['status', ...], ['login', ...]]. */
function calls(): string[][] {
  return runBwMock.mock.calls.map((c) => c[0] as string[]);
}

describe('bwInit server selection', () => {
  beforeEach(() => {
    runBwMock.mockReset();
    clearAllPasswords();
    cachePassword('demo', 'correct-horse');
  });

  it('configures the server on a fresh profile that reports no serverUrl', async () => {
    // Regression: a never-configured profile reports serverUrl: null and silently
    // uses vault.bitwarden.com, so an EU account was told "Invalid master password".
    runBwMock.mockImplementation(fakeBw({ serverUrl: null, status: 'unauthenticated' }));

    const result = await bwInit({
      accountKey: 'demo', profileLabel: 'demo:eu', email: 'demo@example.com', wantServer: EU, profileDir: '/tmp/demo',
    });

    expect(result).toEqual({ ok: true, sessionKey: SESSION_KEY });
    expect(calls()).toContainEqual(['config', 'server', EU]);
    // Nothing to log out of yet.
    expect(calls().some((a) => a[0] === 'logout')).toBe(false);
    // …and the server is set before the login attempt.
    const cfgIdx = calls().findIndex((a) => a[0] === 'config');
    const loginIdx = calls().findIndex((a) => a[0] === 'login');
    expect(cfgIdx).toBeGreaterThanOrEqual(0);
    expect(cfgIdx).toBeLessThan(loginIdx);
  });

  it('configures a self-hosted server on a fresh profile', async () => {
    const home = 'https://bitwarden.internal.example';
    runBwMock.mockImplementation(fakeBw({ serverUrl: null, status: 'unauthenticated' }));

    await bwInit({
      accountKey: 'demo', profileLabel: 'demo:home', email: 'demo@example.com', wantServer: home, profileDir: '/tmp/home-demo',
    });

    expect(calls()).toContainEqual(['config', 'server', home]);
  });

  it('leaves an unset serverUrl alone when the default server is what we want', async () => {
    runBwMock.mockImplementation(fakeBw({ serverUrl: null, status: 'unlocked' }));

    const result = await bwInit({
      accountKey: 'demo', profileLabel: 'demo:cloud', email: 'demo@example.com', wantServer: DEFAULT_BW_SERVER, profileDir: '/tmp/demo',
    });

    expect(result).toEqual({ ok: true, sessionKey: SESSION_KEY });
    // No reconfigure, and crucially no logout of a working session.
    expect(calls().some((a) => a[0] === 'config')).toBe(false);
    expect(calls().some((a) => a[0] === 'logout')).toBe(false);
  });

  it('logs out before switching an authenticated profile to another server', async () => {
    runBwMock.mockImplementation(fakeBw({ serverUrl: DEFAULT_BW_SERVER, status: 'locked' }));

    await bwInit({
      accountKey: 'demo', profileLabel: 'demo:eu', email: 'demo@example.com', wantServer: EU, profileDir: '/tmp/demo',
    });

    const logoutIdx = calls().findIndex((a) => a[0] === 'logout');
    const cfgIdx = calls().findIndex((a) => a[0] === 'config');
    expect(logoutIdx).toBeGreaterThanOrEqual(0);
    expect(logoutIdx).toBeLessThan(cfgIdx);
    // Logged out → must do a full login, not an unlock.
    expect(calls().some((a) => a[0] === 'login')).toBe(true);
    expect(calls().some((a) => a[0] === 'unlock')).toBe(false);
  });

  it('does not reconfigure when the profile is already on the wanted server', async () => {
    runBwMock.mockImplementation(fakeBw({ serverUrl: EU, status: 'locked' }));

    await bwInit({
      accountKey: 'demo', profileLabel: 'demo:eu', email: 'demo@example.com', wantServer: `${EU}/`, profileDir: '/tmp/demo',
    });

    expect(calls().some((a) => a[0] === 'config')).toBe(false);
    expect(calls().some((a) => a[0] === 'unlock')).toBe(true);
  });
});
