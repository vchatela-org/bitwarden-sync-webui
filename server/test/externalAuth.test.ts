import { describe, it, expect, afterEach, vi } from 'vitest';

// The switch is read when auth.ts loads, so each case re-imports the module.
async function loadAuth(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import('../src/auth.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('UI_EXTERNAL_AUTH', () => {
  it('is off by default and keeps the session check', async () => {
    const auth = await loadAuth({ UI_EXTERNAL_AUTH: '' });
    expect(auth.EXTERNAL_AUTH).toBe(false);
    expect(auth.isAuthenticated({ cookies: {} } as never)).toBe(false);
  });

  it('accepts every request when set to 1', async () => {
    const auth = await loadAuth({ UI_EXTERNAL_AUTH: '1' });
    expect(auth.EXTERNAL_AUTH).toBe(true);
    expect(auth.isAuthenticated({ cookies: {} } as never)).toBe(true);
  });

  it('refuses to start with a password configured', async () => {
    const auth = await loadAuth({ UI_EXTERNAL_AUTH: '1', UI_PASSWORD: 'x', UI_PASSWORD_HASH: '' });
    expect(() => auth.assertAuthConfig()).toThrow(/cannot be combined/);
  });

  it('starts with no password configured', async () => {
    const auth = await loadAuth({ UI_EXTERNAL_AUTH: '1', UI_PASSWORD: '', UI_PASSWORD_HASH: '' });
    expect(() => auth.assertAuthConfig()).not.toThrow();
  });
});
