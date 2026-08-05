import { runBw, isValidSessionKey, BwResult, LogCallback } from './bwCli.js';
import { getPassword, forgetPassword, cachePassword, passwordKey } from './secrets.js';

export type ProfileSide = 'cloud' | 'home';

export interface BwStatus {
  status: 'unauthenticated' | 'locked' | 'unlocked' | string;
  serverUrl: string;
  userEmail?: string;
  lastSync?: string;
}

export interface SessionState {
  sessionKey: string;
  email: string;
  profileDir: string;
}

export type InitResult =
  | { ok: true; sessionKey: string }
  | { ok: false; reason: 'needs-password' | 'needs-otp' | 'failed' | 'max-attempts'; message: string };

export async function getBwStatus(profileDir: string, log?: LogCallback): Promise<BwStatus> {
  const result = await runBw(['status', '--response'], { profileDir, timeout: 10000 }, log);
  try {
    const parsed = JSON.parse(result.stdout.trim()) as { success: boolean; data: BwStatus };
    if (parsed.success && parsed.data) return parsed.data;
  } catch { /* ignore */ }
  // Fallback: try to parse as direct status object
  try {
    return JSON.parse(result.stdout.trim()) as BwStatus;
  } catch {
    return { status: 'unauthenticated', serverUrl: '' };
  }
}

/**
 * bw-init: bring a profile to usable state.
 * Returns { ok: true, sessionKey } on success.
 * Returns { ok: false, reason: 'needs-password' } if no password is cached and one is needed.
 * Returns { ok: false, reason: 'needs-otp' } if OTP is required.
 * Returns { ok: false, reason: 'max-attempts' } after 3 failures.
 */
export async function bwInit(opts: {
  profileKey: string; // e.g. 'val', 'home-val'
  email: string;
  wantServer: string;
  profileDir: string;
  otp?: string;
  otpMethod?: number;
  log?: LogCallback;
}): Promise<InitResult> {
  const { profileKey, email, wantServer, profileDir, log } = opts;
  const pwKey = passwordKey(profileKey);
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const pw = getPassword(pwKey);
    if (!pw) {
      return { ok: false, reason: 'needs-password', message: `Password required for ${pwKey}` };
    }

    // 1. Read status + server
    const statusResult = await getBwStatus(profileDir, log);
    let currentStatus = statusResult.status;
    const currentServer = statusResult.serverUrl?.replace(/\/$/, '') ?? '';
    const wantServerNorm = wantServer.replace(/\/$/, '');

    // 2. Server mismatch → logout first, then reconfigure
    if (currentServer && currentServer !== wantServerNorm) {
      log?.('app' as never, `[${profileKey}] Server mismatch: '${currentServer}' → switching to '${wantServerNorm}'`);
      if (currentStatus !== 'unauthenticated') {
        await runBw(['logout'], { profileDir, timeout: 10000 }, log);
      }
      const cfgResult = await runBw(['config', 'server', wantServer], { profileDir, timeout: 10000 }, log);
      if (cfgResult.exitCode !== 0) {
        return { ok: false, reason: 'failed', message: `Failed to configure server: ${cfgResult.stderr}` };
      }
      currentStatus = 'unauthenticated';
    }

    log?.('app' as never, `[${profileKey}] Status: ${currentStatus}`);

    // 3. Login or unlock
    let sessionKey = '';
    let loginFailed = false;
    let needsOtp = false;

    if (currentStatus === 'unauthenticated') {
      const args = ['login', email, '--raw'];
      if (opts.otp !== undefined) {
        args.push('--method', String(opts.otpMethod ?? 0), '--code', opts.otp);
      }
      const result = await runBw(args, { profileDir, fifoPassword: pw, timeout: 30000 }, log);
      if (result.exitCode === 0 && isValidSessionKey(result.stdout.trim())) {
        sessionKey = result.stdout.trim();
      } else {
        // Check if 2FA is needed. The bw CLI does not always mention "Two-step"/"2FA" —
        // with --nointeraction and no --code it prints "Code is required." (single provider,
        // e.g. TOTP-only accounts, auto-selected) or "Login failed. No provider selected."
        // (multiple providers, no --method given).
        const out = `${result.stdout}\n${result.stderr}`;
        if (/two-step|2fa|code is required|no provider selected|no providers available/i.test(out)) {
          needsOtp = true;
        } else {
          loginFailed = true;
        }
      }
    } else if (currentStatus === 'locked' || currentStatus === 'unlocked') {
      const result = await runBw(['unlock', '--raw'], { profileDir, fifoPassword: pw, timeout: 30000 }, log);
      if (result.exitCode === 0 && isValidSessionKey(result.stdout.trim())) {
        sessionKey = result.stdout.trim();
      } else {
        loginFailed = true;
      }
    } else {
      return { ok: false, reason: 'failed', message: `Unknown status: ${currentStatus}` };
    }

    if (needsOtp && !opts.otp) {
      return { ok: false, reason: 'needs-otp', message: `OTP required for ${profileKey}` };
    }

    if (loginFailed || !sessionKey) {
      log?.('app' as never, `[${profileKey}] Login/unlock failed (attempt ${attempt}/${MAX_ATTEMPTS})`);
      forgetPassword(pwKey);
      if (attempt >= MAX_ATTEMPTS) {
        return { ok: false, reason: 'max-attempts', message: `Failed after ${MAX_ATTEMPTS} attempts` };
      }
      return { ok: false, reason: 'needs-password', message: `Wrong password or OTP for ${pwKey} (attempt ${attempt})` };
    }

    // 4. Sync
    const syncResult = await runBw(['sync', '--session', sessionKey], { profileDir, timeout: 30000 }, log);
    if (syncResult.exitCode !== 0) {
      const out = syncResult.stdout + syncResult.stderr;
      if (/invalid_grant|unauthorized|401/i.test(out)) {
        log?.('app' as never, `[${profileKey}] Sync rejected (invalid_grant/auth). Logging out for fresh login.`);
        await runBw(['logout'], { profileDir, timeout: 10000 }, log);
        // Keep password — login proved it correct; next attempt will do fresh login
        continue;
      }
      log?.('app' as never, `[${profileKey}] Sync failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${out.slice(0, 200)}`);
      if (attempt >= MAX_ATTEMPTS) {
        return { ok: false, reason: 'failed', message: `Sync failed: ${out.slice(0, 200)}` };
      }
      continue;
    }

    return { ok: true, sessionKey };
  }

  return { ok: false, reason: 'max-attempts', message: 'Max attempts reached' };
}

export async function lockProfile(profileDir: string, log?: LogCallback): Promise<void> {
  await runBw(['lock'], { profileDir, timeout: 10000 }, log);
}

export async function logoutProfile(profileDir: string, log?: LogCallback): Promise<void> {
  await runBw(['logout'], { profileDir, timeout: 10000 }, log);
}

export async function syncProfile(profileDir: string, sessionKey: string, log?: LogCallback): Promise<BwResult> {
  return runBw(['sync', '--session', sessionKey], { profileDir, timeout: 30000 }, log);
}

export async function listItems(
  profileDir: string,
  sessionKey: string,
  opts: { organizationId?: string } = {},
  log?: LogCallback,
): Promise<unknown[]> {
  const args = ['list', 'items', '--session', sessionKey];
  if (opts.organizationId) {
    args.push('--organizationid', opts.organizationId);
  }
  const result = await runBw(args, { profileDir, timeout: 60000 }, log);
  if (result.exitCode !== 0) return [];
  try {
    return JSON.parse(result.stdout) as unknown[];
  } catch {
    return [];
  }
}

export async function listOrgCollections(
  profileDir: string,
  sessionKey: string,
  orgId: string,
  log?: LogCallback,
): Promise<unknown[]> {
  const result = await runBw(
    ['list', 'org-collections', '--organizationid', orgId, '--session', sessionKey],
    { profileDir, timeout: 30000 },
    log,
  );
  if (result.exitCode !== 0) return [];
  try {
    return JSON.parse(result.stdout) as unknown[];
  } catch {
    return [];
  }
}
