import { z } from 'zod';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const vaultSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  serverUrl: z.string().url(),
});

const userSchema = z.object({
  key: z.string().min(1),
  email: z.string().email(),
  displayName: z.string().optional(),
  from: z.string().min(1),
  to: z.string().min(1),
});

const orgSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  owner: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  orgIds: z.record(z.string().min(1), z.guid()),
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
  users: z.array(userSchema).min(1),
  orgs: z.array(orgSchema).default([]),
  retention: retentionSchema.prefault({}),
  importGuard: importGuardSchema.prefault({}),
  homeLogoutAfterImport: z.boolean().default(true),
});

export type Config = z.infer<typeof configSchema>;
export type VaultConfig = z.infer<typeof vaultSchema>;
export type UserConfig = z.infer<typeof userSchema>;
export type OrgConfig = z.infer<typeof orgSchema>;

export type ConfigLoadResult =
  | { ok: true; config: Config }
  | { ok: false; error: string };

/**
 * Filesystem-safe, vault-aware bw CLI profile dir for a (user, vault) pair.
 * Clean break from the old Alice/Home_Alice scheme — no back-compat shim; users
 * re-enter their master password once post-upgrade (already handled gracefully
 * by the existing credential-prompt flow).
 */
export function profileDir(configDir: string, userKey: string, vaultKey: string): string {
  return resolve(configDir, `${userKey}__${vaultKey}`);
}

/**
 * Looks up a vault by key. Config is validated at load time, so any key
 * reaching here (from a target's from/to or an org's orgIds) is guaranteed
 * present — throw, don't silently fall back.
 */
export function vaultByKey(config: Config, key: string): VaultConfig {
  const v = config.vaults.find((v) => v.key === key);
  if (!v) throw new Error(`Internal error: unknown vault key '${key}'`);
  return v;
}

function validateTargets(config: Config): string | null {
  const vaultKeys = new Set<string>();
  for (const v of config.vaults) {
    if (vaultKeys.has(v.key)) {
      return `Duplicate vault key '${v.key}'`;
    }
    vaultKeys.add(v.key);
  }

  const userKeys = new Set(config.users.map((u) => u.key));

  for (const user of config.users) {
    if (!vaultKeys.has(user.from)) {
      return `User '${user.key}' has unknown from-vault '${user.from}'`;
    }
    if (!vaultKeys.has(user.to)) {
      return `User '${user.key}' has unknown to-vault '${user.to}'`;
    }
    if (user.from === user.to) {
      return `User '${user.key}' has the same from and to vault ('${user.from}')`;
    }
  }

  for (const org of config.orgs) {
    if (!org.owner) {
      return `Organization '${org.key}' has no owner configured`;
    }
    if (!userKeys.has(org.owner)) {
      return `Organization '${org.key}' owner '${org.owner}' is not in users`;
    }
    if (!vaultKeys.has(org.from)) {
      return `Organization '${org.key}' has unknown from-vault '${org.from}'`;
    }
    if (!vaultKeys.has(org.to)) {
      return `Organization '${org.key}' has unknown to-vault '${org.to}'`;
    }
    if (org.from === org.to) {
      return `Organization '${org.key}' has the same from and to vault ('${org.from}')`;
    }
    if (!org.orgIds[org.from]) {
      return `Organization '${org.key}' is missing orgIds['${org.from}'] (from-vault org id)`;
    }
    if (!org.orgIds[org.to]) {
      return `Organization '${org.key}' is missing orgIds['${org.to}'] (to-vault org id)`;
    }
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

/** Build account groups exactly as the bash script does */
export function buildAccountGroups(
  targets: string[],
  config: Config,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  const groupOrder: string[] = [];

  for (const t of targets) {
    const org = config.orgs.find((o) => o.key === t);
    const account = org ? org.owner : t;
    if (!groups.has(account)) {
      groups.set(account, []);
      groupOrder.push(account);
    }
    groups.get(account)!.push(t);
  }

  // Return in insertion order
  const ordered = new Map<string, string[]>();
  for (const acct of groupOrder) {
    ordered.set(acct, groups.get(acct)!);
  }
  return ordered;
}

/**
 * Sub-groups one account's targets (its personal-vault target plus any orgs it
 * owns, as already produced by buildAccountGroups) by the vault each target
 * uses for the given role, so the runner logs in once per distinct vault
 * instead of once per target.
 */
export function groupTargetsByVault(
  targets: string[],
  config: Config,
  role: 'from' | 'to',
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  const order: string[] = [];
  for (const t of targets) {
    const cfg = config.orgs.find((o) => o.key === t) ?? config.users.find((u) => u.key === t);
    if (!cfg) continue; // unreachable post-validation
    const vaultKey = cfg[role];
    if (!groups.has(vaultKey)) {
      groups.set(vaultKey, []);
      order.push(vaultKey);
    }
    groups.get(vaultKey)!.push(t);
  }
  const ordered = new Map<string, string[]>();
  for (const k of order) ordered.set(k, groups.get(k)!);
  return ordered;
}

/** Return all valid target keys (users first, then orgs, sorted) */
export function allTargetKeys(config: Config): string[] {
  const users = config.users.map((u) => u.key).sort();
  const orgs = config.orgs.map((o) => o.key).sort();
  return [...users, ...orgs];
}
