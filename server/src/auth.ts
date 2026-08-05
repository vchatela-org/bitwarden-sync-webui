import { randomBytes, createHmac, timingSafeEqual } from 'crypto';
import { Request, Response, NextFunction } from 'express';

const SESSION_COOKIE = 'bw_session';
const CSRF_COOKIE = 'bw_csrf';

// Active sessions: token → expiry
const sessions = new Map<string, number>();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

function generateToken(len = 32): string {
  return randomBytes(len).toString('hex');
}

function isSecure(req: Request): boolean {
  const trustProxy = process.env['TRUST_PROXY'] === '1' || process.env['TRUST_PROXY'] === 'true';
  return req.secure || (trustProxy && req.headers['x-forwarded-proto'] === 'https');
}

export function createSession(res: Response, req: Request): string {
  const token = generateToken(32);
  sessions.set(token, Date.now() + SESSION_TTL_MS);

  const secure = isSecure(req);
  const csrfToken = generateToken(16);

  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
  res.cookie(CSRF_COOKIE, csrfToken, {
    httpOnly: false, // needs to be readable by JS
    sameSite: 'strict',
    secure,
    maxAge: SESSION_TTL_MS,
    path: '/',
  });

  return csrfToken;
}

export function destroySession(req: Request, res: Response): void {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    sessions.delete(token);
  }
  res.clearCookie(SESSION_COOKIE);
  res.clearCookie(CSRF_COOKIE);
}

export function isAuthenticated(req: Request): boolean {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    sessions.delete(token);
    return false;
  }
  // Refresh session on activity
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return true;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isAuthenticated(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  const csrfFromHeader = req.headers['x-csrf-token'] as string | undefined;
  const csrfFromCookie = req.cookies?.[CSRF_COOKIE];
  if (!csrfFromHeader || !csrfFromCookie) {
    res.status(403).json({ error: 'CSRF token missing' });
    return;
  }
  try {
    const a = Buffer.from(csrfFromHeader, 'hex');
    const b = Buffer.from(csrfFromCookie, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(403).json({ error: 'CSRF token mismatch' });
      return;
    }
  } catch {
    res.status(403).json({ error: 'CSRF token invalid' });
    return;
  }
  next();
}

export function getCsrfToken(req: Request): string | undefined {
  return req.cookies?.[CSRF_COOKIE];
}

/**
 * Verify UI password. Supports argon2id hash (UI_PASSWORD_HASH) or plaintext (UI_PASSWORD).
 * Uses constant-time comparison for plaintext fallback.
 */
export async function verifyUiPassword(candidate: string): Promise<boolean> {
  const hash = process.env['UI_PASSWORD_HASH'];
  if (hash) {
    // Lazy import argon2 to avoid hard dep at import time
    const { verify } = await import('argon2');
    try {
      return await verify(hash, candidate);
    } catch {
      return false;
    }
  }
  const plain = process.env['UI_PASSWORD'];
  if (!plain) return false;
  // Constant-time comparison
  const a = Buffer.from(candidate, 'utf-8');
  const b = Buffer.from(plain, 'utf-8');
  if (a.length !== b.length) {
    // Still do a comparison to avoid timing oracle on length
    timingSafeEqual(Buffer.alloc(1), Buffer.alloc(1));
    return false;
  }
  return timingSafeEqual(a, b);
}

// HMAC-based session secret sign/verify (for future use)
const SESSION_SECRET = process.env['SESSION_SECRET'] ?? createHmac('sha256', randomBytes(32)).digest('hex');

export { SESSION_SECRET };
