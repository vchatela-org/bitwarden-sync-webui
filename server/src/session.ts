import { runBw, isValidSessionKey, BwResult, LogCallback } from './bwCli.js';
import { getPassword, forgetPassword } from './secrets.js';
import { registerSecret } from './redact.js';

/** Server the bw CLI uses when a profile has no explicit `config server`. */
export const DEFAULT_BW_SERVER = 'https://vault.bitwarden.com';

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
  | {
      ok: false;
      reason: 'needs-password' | 'needs-otp' | 'failed' | 'max-attempts';
      message: string;
      /**
       * Set on 'needs-password' when this profile is heading for a full `bw login` (not an
       * `unlock`) and the account is configured with `otp: "required"` — i.e. the credential
       * prompt can ask for the two-step code up front instead of failing and re-prompting.
       * Never set for an `unlock`, which takes no code: asking there would burn a TOTP code
       * the CLI is going to ignore.
       */
      otpExpected?: boolean;
      /**
       * Set on 'needs-password' when the profile only needs unlocking but the account is
       * configured `otp: "required"`. The saved sign-in behind an unlock expires on the server
       * after a few weeks unused, and then the unlock turns into a full login that does need a
       * code — so the prompt offers the code field as optional: fill it and one submit covers
       * both outcomes, leave it and an expired sign-in costs a second (code-only) prompt.
       */
      otpOptional?: boolean;
      /**
       * Set on 'needs-otp': the password is already cached for this account, so the prompt
       * only has to ask for the code.
       */
      passwordCached?: boolean;
    };

export async function getBwStatus(profileDir: string, log?: LogCallback): Promise<BwStatus> {
  const result = await runBw(['status', '--response'], { profileDir, timeout: 10000 }, log);
  try {
    const parsed = JSON.parse(result.stdout.trim()) as {
      success: boolean;
      data?: (Partial<BwStatus> & { object?: string; template?: BwStatus }) | null;
    };
    if (parsed.success && parsed.data) {
      // `bw status --response` wraps the actual status one level deeper as
      // { object: "template", template: { status, serverUrl, ... } }.
      const status = parsed.data.object === 'template' && parsed.data.template
        ? parsed.data.template
        : (parsed.data as BwStatus);
      if (status && typeof status.status === 'string') return status;
    }
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
  accountKey: string; // password-cache key — opaque, never string-surgered
  profileLabel: string; // e.g. 'alice@eu' — log messages only
  email: string;
  wantServer: string;
  profileDir: string;
  /** From the account's `otp: "required"` flag — only a hint for the prompt, never a gate. */
  otpRequired?: boolean;
  otp?: string;
  otpMethod?: number;
  log?: LogCallback;
}): Promise<InitResult> {
  const { accountKey, profileLabel, email, wantServer, profileDir, log } = opts;
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // 1. Read status + server.
    // A profile that has never had `bw config server` run against it reports
    // serverUrl: null and silently uses the CLI's built-in default, so treat an
    // empty serverUrl as that default rather than as "matches whatever we want".
    // This runs before the cached-password check (and mutates nothing) so a
    // 'needs-password' result can tell the caller whether a two-step code will be
    // wanted too — that is what lets the UI ask for both in one prompt.
    const statusResult = await getBwStatus(profileDir, log);
    let currentStatus = statusResult.status;
    const configuredServer = statusResult.serverUrl?.replace(/\/$/, '') ?? '';
    const currentServer = configuredServer || DEFAULT_BW_SERVER;
    const wantServerNorm = wantServer.replace(/\/$/, '');
    const serverMismatch = currentServer !== wantServerNorm;

    const pw = getPassword(accountKey);
    if (!pw) {
      // A mismatched server forces a logout below, so this profile is headed for a
      // full login either way.
      const willLogin = serverMismatch || currentStatus === 'unauthenticated';
      return {
        ok: false,
        reason: 'needs-password',
        message: `Password required for ${accountKey}`,
        otpExpected: opts.otpRequired === true && willLogin,
        otpOptional: opts.otpRequired === true && !willLogin,
      };
    }

    // 2. Server mismatch → logout first, then reconfigure
    if (serverMismatch) {
      log?.('app' as never, `[${profileLabel}] Server is '${configuredServer || `unset (default ${DEFAULT_BW_SERVER})`}' → switching to '${wantServerNorm}'`);
      if (currentStatus !== 'unauthenticated') {
        await runBw(['logout'], { profileDir, timeout: 10000 }, log);
      }
      const cfgResult = await runBw(['config', 'server', wantServer], { profileDir, timeout: 10000 }, log);
      if (cfgResult.exitCode !== 0) {
        return { ok: false, reason: 'failed', message: `Failed to configure server: ${cfgResult.stderr}` };
      }
      currentStatus = 'unauthenticated';
    }

    log?.('app' as never, `[${profileLabel}] Status: ${currentStatus}`);

    // 3. Unlock, falling back to a fresh login when the saved sign-in has expired
    let sessionKey = '';
    let loginFailed = false;

    if (currentStatus !== 'unauthenticated' && currentStatus !== 'locked' && currentStatus !== 'unlocked') {
      return { ok: false, reason: 'failed', message: `Unknown status: ${currentStatus}` };
    }

    if (currentStatus === 'locked' || currentStatus === 'unlocked') {
      const result = await runBw(['unlock', '--raw'], { profileDir, fifoPassword: pw, timeout: 30000 }, log);
      if (result.exitCode === 0 && isValidSessionKey(result.stdout.trim())) {
        sessionKey = result.stdout.trim();
      } else if (await signInExpired(result, profileDir, log)) {
        // Not a wrong password: the server refused the stored refresh token (invalid_grant)
        // and the CLI dropped back to unauthenticated. Keep the password and log in again
        // right here, with the code if the prompt collected one — before this, the run
        // discarded the (correct) password and re-prompted twice: once for it, once for the code.
        log?.('app' as never, `[${profileLabel}] Saved sign-in has expired on the server — logging in again`);
        await runBw(['logout'], { profileDir, timeout: 10000 }, log);
        currentStatus = 'unauthenticated';
      } else {
        loginFailed = true;
      }
    }

    if (currentStatus === 'unauthenticated') {
      if (opts.otp === undefined && opts.otpRequired === true) {
        // The CLI is certain to answer "Code is required." — ask for the code without
        // spending a login attempt, and without asking for the password again.
        return { ok: false, reason: 'needs-otp', message: `OTP required for ${profileLabel}`, passwordCached: true };
      }
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
        if (!opts.otp && /two-step|2fa|code is required|no provider selected|no providers available/i.test(out)) {
          return { ok: false, reason: 'needs-otp', message: `OTP required for ${profileLabel}`, passwordCached: true };
        }
        if (opts.otp && /two-step token is invalid/i.test(out)) {
          // A mistyped or expired code says nothing about the password — ask for the code only.
          log?.('app' as never, `[${profileLabel}] Two-step code rejected (attempt ${attempt}/${MAX_ATTEMPTS})`);
          return { ok: false, reason: 'needs-otp', message: `Two-step code rejected for ${profileLabel}`, passwordCached: true };
        }
        loginFailed = true;
      }
    }

    if (loginFailed || !sessionKey) {
      log?.('app' as never, `[${profileLabel}] Login/unlock failed (attempt ${attempt}/${MAX_ATTEMPTS})`);
      forgetPassword(accountKey);
      if (attempt >= MAX_ATTEMPTS) {
        return { ok: false, reason: 'max-attempts', message: `Failed after ${MAX_ATTEMPTS} attempts` };
      }
      return {
        ok: false,
        reason: 'needs-password',
        message: `Wrong password or OTP for ${accountKey} (attempt ${attempt})`,
        // Still on the login path, so the retry prompt should keep offering the code field.
        otpExpected: opts.otpRequired === true && currentStatus === 'unauthenticated',
      };
    }

    // Register the session key for exact-match redaction (belt-and-suspenders alongside
    // the shape-based regex in redact.ts — a live session key grants full vault decrypt
    // access, so it gets the same treatment as the master password).
    registerSecret(sessionKey);

    // 4. Sync
    const syncResult = await runBw(['sync', '--session', sessionKey], { profileDir, timeout: 30000 }, log);
    if (syncResult.exitCode !== 0) {
      const out = syncResult.stdout + syncResult.stderr;
      if (/invalid_grant|unauthorized|401/i.test(out)) {
        log?.('app' as never, `[${profileLabel}] Sync rejected (invalid_grant/auth). Logging out for fresh login.`);
        await runBw(['logout'], { profileDir, timeout: 10000 }, log);
        // Keep password — login proved it correct; next attempt will do fresh login
        continue;
      }
      log?.('app' as never, `[${profileLabel}] Sync failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${out.slice(0, 200)}`);
      if (attempt >= MAX_ATTEMPTS) {
        return { ok: false, reason: 'failed', message: `Sync failed: ${out.slice(0, 200)}` };
      }
      continue;
    }

    return { ok: true, sessionKey };
  }

  return { ok: false, reason: 'max-attempts', message: 'Max attempts reached' };
}

/**
 * After a failed `bw unlock`: true when the failure is the server rejecting the stored sign-in
 * (refresh token expired or revoked) rather than a wrong password. The CLI reports it as an
 * unhandled `invalid_grant` rejection and leaves the profile unauthenticated.
 */
async function signInExpired(result: BwResult, profileDir: string, log?: LogCallback): Promise<boolean> {
  if (/invalid_grant/i.test(`${result.stdout}\n${result.stderr}`)) return true;
  return (await getBwStatus(profileDir, log)).status === 'unauthenticated';
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
  // The CLI dumps full item contents (names, usernames, passwords, TOTP, notes) as JSON
  // to stdout here — that must never reach the job log/UI, so stdout is silenced. stderr
  // (errors) still flows through `log` for diagnostics.
  const result = await runBw(args, { profileDir, timeout: 60000, silenceStdout: true }, log);
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
