import { registerSecret, unregisterSecret } from './redact.js';

const IDLE_TTL_MS = parseInt(process.env['PASSWORD_TTL_MS'] ?? '900000', 10); // 15 min default

interface PasswordEntry {
  password: string;
  expiresAt: number;
}

const passwords = new Map<string, PasswordEntry>();

/** Store a password in RAM for a given account key */
export function cachePassword(accountKey: string, password: string): void {
  // Unregister old if present
  const old = passwords.get(accountKey);
  if (old) {
    unregisterSecret(old.password);
  }
  passwords.set(accountKey, { password, expiresAt: Date.now() + IDLE_TTL_MS });
  registerSecret(password);
}

/** Retrieve a cached password, or undefined if not present/expired */
export function getPassword(accountKey: string): string | undefined {
  const entry = passwords.get(accountKey);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    forgetPassword(accountKey);
    return undefined;
  }
  return entry.password;
}

/** Remove a cached password (e.g. after failed login) */
export function forgetPassword(accountKey: string): void {
  const entry = passwords.get(accountKey);
  if (entry) {
    unregisterSecret(entry.password);
    // Zero out the password string (best-effort in JS — V8 may have already copied it)
    passwords.delete(accountKey);
  }
}

/** Remove all cached passwords */
export function clearAllPasswords(): void {
  for (const [key] of passwords) {
    forgetPassword(key);
  }
}

/** Check if a password is cached */
export function hasPassword(accountKey: string): boolean {
  return getPassword(accountKey) !== undefined;
}

/** Refresh the TTL for an existing password */
export function refreshPassword(accountKey: string): void {
  const entry = passwords.get(accountKey);
  if (entry) {
    entry.expiresAt = Date.now() + IDLE_TTL_MS;
  }
}
