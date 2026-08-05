import { pbkdf2Sync } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { LogCallback } from './bwCli.js';
import { runBw } from './bwCli.js';
import { listItems } from './session.js';

export interface KdfConfig {
  kdfType: number;
  iterations: number;
}

export interface PurgeContext {
  who: string; // user key, e.g. 'val'
  email: string;
  homeProfileDir: string;
  sessionKey: string;
  homeServerUrl: string;
  homeOrgId?: string; // set for org purge
  password: string; // master password (RAM only)
}

/**
 * Derive master password hash for Bitwarden purge API.
 * masterKey = PBKDF2-SHA256(password, salt=lowercase(email), iterations, 32)
 * hash      = base64(PBKDF2-SHA256(masterKey, salt=password, 1, 32))
 */
export function deriveMasterPasswordHash(password: string, email: string, iterations: number): string {
  const pw = Buffer.from(password, 'utf-8');
  const salt = Buffer.from(email.trim().toLowerCase(), 'utf-8');
  const masterKey = pbkdf2Sync(pw, salt, iterations, 32, 'sha256');
  const hash = pbkdf2Sync(masterKey, pw, 1, 32, 'sha256');
  return hash.toString('base64');
}

interface DataJsonAccount {
  email?: string;
}

function readDataJson(profileDir: string): Record<string, unknown> {
  const f = resolve(profileDir, 'data.json');
  const content = readFileSync(f, 'utf-8');
  return JSON.parse(content) as Record<string, unknown>;
}

function getActiveAccountId(data: Record<string, unknown>, email: string): string | null {
  const active = data['global_account_activeAccountId'] as string | undefined;
  if (active) return active;

  const accounts = data['global_account_accounts'] as Record<string, DataJsonAccount> | undefined;
  if (!accounts) return null;
  for (const [uid, acct] of Object.entries(accounts)) {
    if ((acct.email ?? '').toLowerCase() === email.toLowerCase()) {
      return uid;
    }
  }
  return null;
}

export function readTokenAndKdf(
  profileDir: string,
  email: string,
): { token: string; kdfType: number; iterations: number } {
  const data = readDataJson(profileDir);
  const uid = getActiveAccountId(data, email);
  if (!uid) throw new Error(`Cannot determine account id for ${email} in ${profileDir}`);

  const token = data[`user_${uid}_token_accessToken`] as string | undefined;
  if (!token) throw new Error(`No access token in CLI state for ${email}`);

  const kdfCfg = data[`user_${uid}_kdfConfig_kdfConfig`] as KdfConfig | undefined;
  if (!kdfCfg) throw new Error(`No KDF config in CLI state for ${email}`);
  if (kdfCfg.kdfType !== 0) {
    throw new Error(
      `${email} uses non-PBKDF2 KDF (kdfType=${kdfCfg.kdfType}); only PBKDF2 (kdfType=0) is supported`,
    );
  }

  return { token, kdfType: kdfCfg.kdfType, iterations: kdfCfg.iterations };
}

export async function purgeVault(ctx: PurgeContext, log?: LogCallback): Promise<void> {
  const { who, email, homeProfileDir, sessionKey, homeServerUrl, homeOrgId, password } = ctx;
  const scope = homeOrgId ? `org ${homeOrgId}` : 'personal vault';
  log?.('app' as never, `[purge] Purging ${scope} for home-${who}...`);

  let token: string;
  let iterations: number;
  try {
    const result = readTokenAndKdf(homeProfileDir, email);
    token = result.token;
    iterations = result.iterations;
  } catch (err: unknown) {
    throw new Error(`Cannot read CLI state: ${err instanceof Error ? err.message : String(err)}`);
  }

  const mph = deriveMasterPasswordHash(password, email, iterations);

  const apiBase = homeServerUrl.replace(/\/$/, '') + '/api';
  let purgeUrl = `${apiBase}/ciphers/purge`;
  if (homeOrgId) purgeUrl += `?organizationId=${encodeURIComponent(homeOrgId)}`;

  // token comes from the bw CLI's own local session state (data.json), previously
  // issued by this same homeServerUrl during login — not attacker-controlled file
  // data, just this app re-presenting its own access token to the server that
  // issued it, exactly as the bw CLI itself does for authenticated API calls.
  // codeql[js/file-access-to-http]
  const resp = await fetch(purgeUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ masterPasswordHash: mph }),
  });

  if (resp.status !== 200 && resp.status !== 204) {
    let body = '';
    try { body = await resp.text(); } catch { /* ignore */ }
    throw new Error(`Purge API returned HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }

  log?.('app' as never, `[purge] HTTP ${resp.status} — syncing to confirm...`);

  // Sync then verify empty
  const syncResult = await runBw(['sync', '--session', sessionKey], { profileDir: homeProfileDir, timeout: 30000 }, log);
  if (syncResult.exitCode !== 0) {
    throw new Error('Post-purge sync failed');
  }

  const items = await listItems(homeProfileDir, sessionKey, { organizationId: homeOrgId }, log);
  const remaining = homeOrgId
    ? (items as Array<{ organizationId?: string }>).filter((i) => i.organizationId === homeOrgId).length
    : (items as Array<{ organizationId?: string | null }>).filter((i) => !i.organizationId).length;

  if (remaining !== 0) {
    throw new Error(`Purge returned HTTP ${resp.status} but ${scope} still has ${remaining} item(s)`);
  }

  log?.('app' as never, `[purge] ✅ ${scope} purged and verified empty`);
}
