/**
 * Redacts secrets from log lines before they are stored, streamed, or displayed.
 *
 * Scrubs:
 *  - Session keys (long base64 strings in session-key positions)
 *  - Bearer tokens and JWTs
 *  - Any dynamically registered secret (passwords, OTPs)
 */

const SESSION_KEY_RE = /(?<=[=\s'"]|--session\s|BW_SESSION[=\s'"])([A-Za-z0-9+/=]{20,})/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9+/=._-]{10,}/gi;
const JWT_RE = /eyJ[A-Za-z0-9+/=._-]{10,}\.[A-Za-z0-9+/=._-]{10,}\.[A-Za-z0-9+/=._-]{10,}/g;

// Secrets registered at runtime (passwords, OTPs, etc.)
const registeredSecrets = new Set<string>();

export function registerSecret(secret: string): void {
  if (secret && secret.length > 0) {
    registeredSecrets.add(secret);
  }
}

export function unregisterSecret(secret: string): void {
  registeredSecrets.delete(secret);
}

export function clearAllSecrets(): void {
  registeredSecrets.clear();
}

export function redact(line: string): string {
  let out = line;

  // Redact registered secrets first (passwords, OTPs)
  for (const secret of registeredSecrets) {
    if (secret.length >= 3) {
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(escaped, 'g'), '[REDACTED]');
    }
  }

  // Redact Bearer tokens before session keys (prevents JWT header from matching session key RE)
  out = out.replace(BEARER_RE, 'Bearer [TOKEN]');

  // Redact JWTs
  out = out.replace(JWT_RE, '[JWT]');

  // Redact session keys (long base64 in session-key positions, but not after Bearer)
  out = out.replace(SESSION_KEY_RE, '[SESSION_KEY]');

  // Catch any remaining long base64 after --session / --raw
  out = out.replace(/(\b(?:--session|--raw|session[=:\s])\s*)([A-Za-z0-9+/=]{20,})/gi, '$1[SESSION_KEY]');

  return out;
}
