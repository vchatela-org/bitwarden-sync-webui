import { registerSecret, unregisterSecret } from './redact.js';

const IDLE_TTL_MS = parseInt(process.env['PASSWORD_TTL_MS'] ?? '900000', 10); // 15 min default

interface PasswordEntry {
  password: string;
  expiresAt: number;
}

const passwords = new Map<string, PasswordEntry>();

/** Store a password in RAM for a given user key */
export function cachePassword(userKey: string, password: string): void {
  // Unregister old if present
  const old = passwords.get(userKey);
  if (old) {
    unregisterSecret(old.password);
  }
  passwords.set(userKey, { password, expiresAt: Date.now() + IDLE_TTL_MS });
  registerSecret(password);
}

/** Retrieve a cached password, or undefined if not present/expired */
export function getPassword(userKey: string): string | undefined {
  const entry = passwords.get(userKey);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    forgetPassword(userKey);
    return undefined;
  }
  return entry.password;
}

/** Remove a cached password (e.g. after failed login) */
export function forgetPassword(userKey: string): void {
  const entry = passwords.get(userKey);
  if (entry) {
    unregisterSecret(entry.password);
    // Zero out the password string (best-effort in JS — V8 may have already copied it)
    passwords.delete(userKey);
  }
}

/** Remove all cached passwords */
export function clearAllPasswords(): void {
  for (const [key] of passwords) {
    forgetPassword(key);
  }
}

/** Check if a password is cached */
export function hasPassword(userKey: string): boolean {
  return getPassword(userKey) !== undefined;
}

/** Refresh the TTL for an existing password */
export function refreshPassword(userKey: string): void {
  const entry = passwords.get(userKey);
  if (entry) {
    entry.expiresAt = Date.now() + IDLE_TTL_MS;
  }
}

/** Return the org owner's key for purposes of password lookup (same as bash's ${bw_who#home-}) */
export function passwordKey(profileKey: string): string {
  // Strip 'home-' prefix: 'home-val' → 'val', 'home-val-pro' → 'val-pro'
  return profileKey.startsWith('home-') ? profileKey.slice(5) : profileKey;
}
