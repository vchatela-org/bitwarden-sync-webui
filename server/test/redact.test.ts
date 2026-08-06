import { describe, it, expect } from 'vitest';
import { redact, registerSecret, unregisterSecret, clearAllSecrets } from '../src/redact.js';

describe('redact', () => {
  afterEach(() => {
    clearAllSecrets();
  });

  it('redacts a session key after --session flag', () => {
    const line = 'bw sync --session ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890+/=';
    const out = redact(line);
    expect(out).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890+/=');
  });

  it('redacts a bare session key with nothing preceding it (bw login/unlock --raw output)', () => {
    const line = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890+/=';
    const out = redact(line);
    expect(out).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890+/=');
  });

  it('redacts Bearer tokens', () => {
    const line = 'Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature';
    const out = redact(line);
    expect(out).toContain('[TOKEN]');
    expect(out).not.toContain('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9');
  });

  it('redacts JWTs', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SIGNATURESIG';
    const line = `token: ${jwt}`;
    const out = redact(line);
    expect(out).not.toContain('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9');
  });

  it('redacts a registered password', () => {
    registerSecret('my-super-secret-pw');
    const line = 'Unlocking vault with password: my-super-secret-pw OK';
    const out = redact(line);
    expect(out).not.toContain('my-super-secret-pw');
    expect(out).toContain('[REDACTED]');
  });

  it('does not touch benign log lines', () => {
    const line = '✅ Backup completed for user val';
    expect(redact(line)).toBe(line);
  });

  it('redacts multiple secrets in one line', () => {
    registerSecret('secretA');
    registerSecret('secretB');
    const line = 'Using secretA and then secretB in the same line';
    const out = redact(line);
    expect(out).not.toContain('secretA');
    expect(out).not.toContain('secretB');
  });

  it('does not redact short tokens (< 3 chars) to avoid false positives', () => {
    registerSecret('ab');
    const line = 'some ab line';
    const out = redact(line);
    expect(out).toBe(line);
  });

  it('unregisters a secret after unregisterSecret', () => {
    registerSecret('tempSecret');
    unregisterSecret('tempSecret');
    const line = 'showing tempSecret now';
    const out = redact(line);
    expect(out).toContain('tempSecret');
  });
});
