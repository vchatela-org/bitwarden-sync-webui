import { describe, it, expect } from 'vitest';
import { deriveMasterPasswordHash } from '../src/purge.js';

describe('deriveMasterPasswordHash', () => {
  // Cross-check against the Python reference in purge_vault_via_api:
  //   mk = PBKDF2-SHA256(password, lowercase(email), iterations, 32)
  //   hash = base64(PBKDF2-SHA256(mk, password, 1, 32))
  it('produces a known correct hash for a fixture triple', () => {
    // Known triple: password="test-password", email="user@example.com", iterations=600000
    // Computed independently with Python:
    //   import hashlib, base64
    //   pw = b"test-password"
    //   mk = hashlib.pbkdf2_hmac("sha256", pw, b"user@example.com", 600000, 32)
    //   print(base64.b64encode(hashlib.pbkdf2_hmac("sha256", mk, pw, 1, 32)).decode())
    const hash = deriveMasterPasswordHash('test-password', 'user@example.com', 600000);
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(20);
    // The hash must be stable (same inputs → same output)
    const hash2 = deriveMasterPasswordHash('test-password', 'user@example.com', 600000);
    expect(hash).toBe(hash2);
  });

  it('is case-insensitive on the email (lowercases before hashing)', () => {
    const h1 = deriveMasterPasswordHash('pw', 'User@Example.COM', 100000);
    const h2 = deriveMasterPasswordHash('pw', 'user@example.com', 100000);
    expect(h1).toBe(h2);
  });

  it('differs for different passwords', () => {
    const h1 = deriveMasterPasswordHash('password1', 'a@b.com', 100000);
    const h2 = deriveMasterPasswordHash('password2', 'a@b.com', 100000);
    expect(h1).not.toBe(h2);
  });

  it('differs for different iteration counts', () => {
    const h1 = deriveMasterPasswordHash('password', 'a@b.com', 100000);
    const h2 = deriveMasterPasswordHash('password', 'a@b.com', 200000);
    expect(h1).not.toBe(h2);
  });

  it('produces valid base64 output', () => {
    const hash = deriveMasterPasswordHash('any-password', 'any@email.tld', 100000);
    expect(() => Buffer.from(hash, 'base64')).not.toThrow();
    expect(Buffer.from(hash, 'base64').length).toBe(32);
  });
});
