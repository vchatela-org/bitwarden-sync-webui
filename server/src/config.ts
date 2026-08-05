import { z } from 'zod';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const userSchema = z.object({
  key: z.string().min(1),
  email: z.string().email(),
  displayName: z.string().optional(),
});

const orgSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  owner: z.string().min(1),
  saasId: z.string().uuid(),
  homeId: z.string().uuid(),
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
  cloudServerUrl: z.string().url(),
  homeServerUrl: z.string().url(),
  backupFolder: z.string().min(1),
  bitwardenConfigDir: z.string().min(1),
  users: z.array(userSchema).min(1),
  orgs: z.array(orgSchema).default([]),
  retention: retentionSchema.default({}),
  importGuard: importGuardSchema.default({}),
  homeLogoutAfterImport: z.boolean().default(true),
});

export type Config = z.infer<typeof configSchema>;
export type UserConfig = z.infer<typeof userSchema>;
export type OrgConfig = z.infer<typeof orgSchema>;

export type ConfigLoadResult =
  | { ok: true; config: Config }
  | { ok: false; error: string };

/** Capitalise only the first character, same as bash's ${key^} */
export function capitaliseFirst(s: string): string {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1);
}

/** Cloud profile dir for a user key */
export function cloudProfileDir(configDir: string, userKey: string): string {
  return resolve(configDir, capitaliseFirst(userKey));
}

/** Home profile dir for a user key */
export function homeProfileDir(configDir: string, userKey: string): string {
  return resolve(configDir, `Home_${capitaliseFirst(userKey)}`);
}

function validateOrgs(config: Config): string | null {
  const userKeys = new Set(config.users.map((u) => u.key));
  for (const org of config.orgs) {
    if (!org.owner) {
      return `Organization '${org.key}' has no owner configured`;
    }
    if (!userKeys.has(org.owner)) {
      return `Organization '${org.key}' owner '${org.owner}' is not in users`;
    }
    if (!org.saasId) {
      return `Organization '${org.key}' is missing saasId (cloud org id)`;
    }
    if (!org.homeId) {
      return `Organization '${org.key}' is missing homeId (home-server org id)`;
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

  const orgError = validateOrgs(result.data);
  if (orgError) {
    return { ok: false, error: orgError };
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

/** Return all valid target keys (users first, then orgs, sorted) */
export function allTargetKeys(config: Config): string[] {
  const users = config.users.map((u) => u.key).sort();
  const orgs = config.orgs.map((o) => o.key).sort();
  return [...users, ...orgs];
}
