import { z } from 'zod';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Account keys become bw CLI profile directory names verbatim, so the charset is
 * restricted to what is safe as a single path segment and must start with an
 * alphanumeric — which also rules out '.'/'..' and anything with a separator in it.
 */
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.@-]*$/;
const keySchema = z.string().min(1).regex(KEY_RE, 'must start with a letter or digit and contain only letters, digits, and _ . @ -');

const vaultSchema = z.object({
  key: keySchema,
  name: z.string().min(1),
  serverUrl: z.url(),
  /** Overrides the top-level logoutAfterImport for this vault when it is an import destination. */
  logoutAfterImport: z.boolean().optional(),
});

/**
 * One Bitwarden identity on one vault. Two accounts for the same human on two vaults are
 * separate entries with separate keys — they may have different emails, different master
 * passwords and different two-step settings, and each gets its own CLI profile directory.
 */
const accountSchema = z.object({
  key: keySchema,
  vault: z.string().min(1),
  email: z.email(),
  displayName: z.string().optional(),
  /**
   * 'required' means "prompt for a two-step code up front, don't make the user submit the
   * form twice". 'unknown' (the default) does NOT mean the account has no two-step login —
   * only that it is not recorded here, so the reactive path still applies and the user may
   * be prompted a second time once the CLI asks for a code.
   */
  otp: z.enum(['unknown', 'required']).default('unknown'),
  /** bw CLI --method: 0 = authenticator, 1 = email, 3 = YubiKey. */
  otpMethod: z.number().int().min(0).optional(),
});

/**
 * An organisation as it exists across vaults. `ids` maps a vault key to the org's id on that
 * vault; an org that only lives on some vaults simply omits the others.
 */
const orgSchema = z.object({
  key: keySchema,
  name: z.string().min(1),
  ids: z.record(z.string().min(1), z.guid()),
});

/**
 * One directed backup+import route, and the unit of work everything else is keyed on: a sync
 * key is the target key used by jobs, backup filenames and the dashboard. `from`/`to` name
 * accounts (each of which pins a vault), so the two sides need not share an email — and
 * whichever account sits on a side is the one that logs in there, which is also what makes an
 * org's owner per-vault rather than global.
 */
const syncSchema = z.object({
  key: keySchema,
  displayName: z.string().optional(),
  from: z.string().min(1),
  to: z.string().min(1),
  /** Org key — when set, this route syncs that org's collection instead of the personal vault. */
  org: z.string().min(1).optional(),
});

const retentionSchema = z.object({
  keepDaily: z.number().int().positive().default(7),
  keepMonthly: z.number().int().positive().default(12),
});

const importGuardSchema = z.object({
  minSourceRatio: z.number().min(0).max(1).default(0.5),
  blockOnEmptySource: z.boolean().default(true),
});

const configSchema = z.object({
  vaults: z.array(vaultSchema).min(2),
  backupFolder: z.string().min(1),
  bitwardenConfigDir: z.string().min(1),
  accounts: z.array(accountSchema).min(1),
  orgs: z.array(orgSchema).default([]),
  syncs: z.array(syncSchema).min(1),
  retention: retentionSchema.prefault({}),
  importGuard: importGuardSchema.prefault({}),
  /** Default for every destination vault; a vault may override it with its own flag. */
  logoutAfterImport: z.boolean().default(true),
});

export type Config = z.infer<typeof configSchema>;
export type VaultConfig = z.infer<typeof vaultSchema>;
export type AccountConfig = z.infer<typeof accountSchema>;
export type OrgConfig = z.infer<typeof orgSchema>;
export type SyncConfig = z.infer<typeof syncSchema>;

export type ConfigLoadResult =
  | { ok: true; config: Config }
  | { ok: false; error: string };

/**
 * bw CLI profile dir for one account. An account already pins a vault, so the key alone is
 * enough — and it is validated against KEY_RE, so it is always a single safe path segment.
 */
export function profileDir(configDir: string, accountKey: string): string {
  return resolve(configDir, accountKey);
}

/**
 * Lookups for keys that config validation has already proven exist. Any key reaching these
 * came out of a validated config, so a miss is an internal error — throw, don't fall back.
 */
export function vaultByKey(config: Config, key: string): VaultConfig {
  const v = config.vaults.find((v) => v.key === key);
  if (!v) throw new Error(`Internal error: unknown vault key '${key}'`);
  return v;
}

export function accountByKey(config: Config, key: string): AccountConfig {
  const a = config.accounts.find((a) => a.key === key);
  if (!a) throw new Error(`Internal error: unknown account key '${key}'`);
  return a;
}

export function syncByKey(config: Config, key: string): SyncConfig {
  const s = config.syncs.find((s) => s.key === key);
  if (!s) throw new Error(`Internal error: unknown sync key '${key}'`);
  return s;
}

export function orgByKey(config: Config, key: string): OrgConfig {
  const o = config.orgs.find((o) => o.key === key);
  if (!o) throw new Error(`Internal error: unknown org key '${key}'`);
  return o;
}

/** The vault an account lives on. */
export function vaultOfAccount(config: Config, accountKey: string): VaultConfig {
  return vaultByKey(config, accountByKey(config, accountKey).vault);
}

/** Backup filenames (and the dashboard) distinguish personal-vault routes from org routes. */
export function syncKind(sync: SyncConfig): 'user' | 'org' {
  return sync.org ? 'org' : 'user';
}

/** The org id a sync uses on one of its endpoint vaults, or undefined for a personal route. */
export function syncOrgId(config: Config, sync: SyncConfig, vaultKey: string): string | undefined {
  if (!sync.org) return undefined;
  return orgByKey(config, sync.org).ids[vaultKey];
}

/** Whether a destination vault should be logged out of after an import. */
export function logoutAfterImport(config: Config, vaultKey: string): boolean {
  return vaultByKey(config, vaultKey).logoutAfterImport ?? config.logoutAfterImport;
}

function findDuplicate(keys: string[]): string | null {
  const seen = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) return k;
    seen.add(k);
  }
  return null;
}

function validateTargets(config: Config): string | null {
  const dupVault = findDuplicate(config.vaults.map((v) => v.key));
  if (dupVault) return `Duplicate vault key '${dupVault}'`;
  const dupAccount = findDuplicate(config.accounts.map((a) => a.key));
  if (dupAccount) return `Duplicate account key '${dupAccount}'`;
  const dupOrg = findDuplicate(config.orgs.map((o) => o.key));
  if (dupOrg) return `Duplicate org key '${dupOrg}'`;
  const dupSync = findDuplicate(config.syncs.map((s) => s.key));
  if (dupSync) return `Duplicate sync key '${dupSync}'`;

  const vaultKeys = new Set(config.vaults.map((v) => v.key));
  const accountKeys = new Set(config.accounts.map((a) => a.key));
  const orgKeys = new Set(config.orgs.map((o) => o.key));

  // Job step ids interleave both ('<src>:import:<dest-account>:login' next to
  // '<src>:import:<sync>:diff'), so a name used for both would make the step list ambiguous.
  for (const sync of config.syncs) {
    if (accountKeys.has(sync.key)) {
      return `Sync '${sync.key}' has the same key as an account — give one of them a different name`;
    }
  }

  for (const account of config.accounts) {
    if (!vaultKeys.has(account.vault)) {
      return `Account '${account.key}' has unknown vault '${account.vault}'`;
    }
  }

  for (const org of config.orgs) {
    for (const vaultKey of Object.keys(org.ids)) {
      if (!vaultKeys.has(vaultKey)) {
        return `Organization '${org.key}' has an id for unknown vault '${vaultKey}'`;
      }
    }
  }

  for (const sync of config.syncs) {
    if (!accountKeys.has(sync.from)) {
      return `Sync '${sync.key}' has unknown from-account '${sync.from}'`;
    }
    if (!accountKeys.has(sync.to)) {
      return `Sync '${sync.key}' has unknown to-account '${sync.to}'`;
    }
    const fromVault = config.accounts.find((a) => a.key === sync.from)!.vault;
    const toVault = config.accounts.find((a) => a.key === sync.to)!.vault;
    if (fromVault === toVault) {
      return `Sync '${sync.key}' has both accounts on the same vault ('${fromVault}')`;
    }
    if (sync.org !== undefined) {
      if (!orgKeys.has(sync.org)) {
        return `Sync '${sync.key}' has unknown org '${sync.org}'`;
      }
      const org = config.orgs.find((o) => o.key === sync.org)!;
      if (!org.ids[fromVault]) {
        return `Organization '${org.key}' is missing ids['${fromVault}'], needed by sync '${sync.key}'`;
      }
      if (!org.ids[toVault]) {
        return `Organization '${org.key}' is missing ids['${toVault}'], needed by sync '${sync.key}'`;
      }
    }
  }
  return null;
}

/**
 * Pre-1.6 configs declared `users[]` (each carrying one email plus from/to vault keys) and
 * gave orgs an `owner`. Zod would reject those with a pile of "required" issues that say
 * nothing about why — detect the old shape and point at the migration notes instead.
 */
function legacyConfigError(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj['users']) && obj['accounts'] === undefined) {
    return (
      'This looks like a pre-1.6 targets.json (it has "users" but no "accounts").\n' +
      '  The model is now vaults → accounts (one identity per vault) → syncs (from-account → to-account),\n' +
      '  with orgs holding one id per vault. See the "Migrating a pre-1.6 targets.json" section of the README.'
    );
  }
  return null;
}

export function loadConfig(path?: string): ConfigLoadResult {
  const configPath = path ?? process.env['CONFIG_PATH'] ?? '/config/targets.json';
  let raw: unknown;
  try {
    const content = readFileSync(configPath, 'utf-8');
    raw = JSON.parse(content);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to read config at ${configPath}: ${msg}` };
  }

  const legacy = legacyConfigError(raw);
  if (legacy) return { ok: false, error: legacy };

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    return { ok: false, error: `Config validation failed:\n${issues}` };
  }

  const targetError = validateTargets(result.data);
  if (targetError) {
    return { ok: false, error: targetError };
  }

  // Override from env if provided
  const config = result.data;
  if (process.env['BACKUP_FOLDER']) config.backupFolder = process.env['BACKUP_FOLDER'];
  if (process.env['BW_CONFIG_DIR']) config.bitwardenConfigDir = process.env['BW_CONFIG_DIR'];

  return { ok: true, config };
}

/**
 * Groups sync keys by the account that has to be unlocked for the given role — `from` for the
 * backup side, `to` for the import side. Because an account pins exactly one vault, this is
 * also the login grouping: one entry here is one `bw login`/`unlock` serving every sync in it.
 * Insertion order is preserved so the UI's step list follows the order of `syncs` in the config.
 */
export function groupSyncsByAccount(
  syncKeys: string[],
  config: Config,
  role: 'from' | 'to',
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const key of syncKeys) {
    const sync = config.syncs.find((s) => s.key === key);
    if (!sync) continue; // unreachable post-validation
    const accountKey = sync[role];
    const existing = groups.get(accountKey);
    if (existing) existing.push(key);
    else groups.set(accountKey, [key]);
  }
  return groups;
}

/**
 * The other endpoint accounts of the syncs a prompt covers — offered in the credential modal
 * as "reuse this password for …", which is what replaces the old per-account/shared cache-key
 * juggling now that every account has its own key.
 */
export function counterpartAccounts(
  syncKeys: string[],
  config: Config,
  accountKey: string,
): string[] {
  const others = new Set<string>();
  for (const key of syncKeys) {
    const sync = config.syncs.find((s) => s.key === key);
    if (!sync) continue;
    for (const endpoint of [sync.from, sync.to]) {
      if (endpoint !== accountKey) others.add(endpoint);
    }
  }
  return [...others];
}

/** Return all valid target (sync) keys — personal routes first, then org routes, each sorted. */
export function allTargetKeys(config: Config): string[] {
  const personal = config.syncs.filter((s) => !s.org).map((s) => s.key).sort();
  const orgs = config.syncs.filter((s) => s.org).map((s) => s.key).sort();
  return [...personal, ...orgs];
}
