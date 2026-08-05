import { readdirSync, statSync, readFileSync, unlinkSync } from 'fs';
import { resolve, join } from 'path';
import { createHash } from 'crypto';

export type BackupKind = 'user' | 'org';
export type BackupFileType = 'encrypted' | 'encrypted_pass' | 'meta' | 'other';

export interface BackupFile {
  path: string;
  filename: string;
  targetKey: string;
  kind: BackupKind;
  timestamp: string; // YYYYMMDD_HHMMSS
  fileType: BackupFileType;
  sizeBytes: number;
}

export interface BackupSet {
  targetKey: string;
  kind: BackupKind;
  timestamp: string;
  files: BackupFile[];
  sizeBytes: number;
  meta?: BackupMeta;
}

export interface BackupMeta {
  target: string;
  kind: BackupKind;
  timestamp: string;
  itemCount?: number;
  folderCount?: number;
  collectionCount?: number | null;
  sourceServer?: string;
  cliVersion?: string;
  exportFile?: string;
  sizeBytes?: number;
  sha256?: string;
}

const USER_FILE_RE =
  /^bitwarden_export_([^_]+(?:_[^_]+)*)_(\d{8}_\d{6})_(encrypted(?:_pass)?)\.json$/;
const ORG_FILE_RE =
  /^bitwarden_org_export_([^_]+(?:_[^_]+)*)_(\d{8}_\d{6})_(encrypted(?:_pass)?)\.json$/;
const USER_META_RE =
  /^bitwarden_export_([^_]+(?:_[^_]+)*)_(\d{8}_\d{6})\.meta\.json$/;
const ORG_META_RE =
  /^bitwarden_org_export_([^_]+(?:_[^_]+)*)_(\d{8}_\d{6})\.meta\.json$/;

export function parseBackupFilename(
  filename: string,
): { targetKey: string; kind: BackupKind; timestamp: string; fileType: BackupFileType } | null {
  let m: RegExpMatchArray | null;

  m = filename.match(USER_FILE_RE);
  if (m) {
    return {
      targetKey: m[1],
      kind: 'user',
      timestamp: m[2],
      fileType: m[3] === 'encrypted_pass' ? 'encrypted_pass' : 'encrypted',
    };
  }

  m = filename.match(ORG_FILE_RE);
  if (m) {
    return {
      targetKey: m[1],
      kind: 'org',
      timestamp: m[2],
      fileType: m[3] === 'encrypted_pass' ? 'encrypted_pass' : 'encrypted',
    };
  }

  m = filename.match(USER_META_RE);
  if (m) {
    return { targetKey: m[1], kind: 'user', timestamp: m[2], fileType: 'meta' };
  }

  m = filename.match(ORG_META_RE);
  if (m) {
    return { targetKey: m[1], kind: 'org', timestamp: m[2], fileType: 'meta' };
  }

  return null;
}

export function buildBackupFilename(
  targetKey: string,
  kind: BackupKind,
  timestamp: string,
  fileType: BackupFileType,
): string {
  const prefix = kind === 'org' ? 'bitwarden_org_export_' : 'bitwarden_export_';
  if (fileType === 'meta') {
    return `${prefix}${targetKey}_${timestamp}.meta.json`;
  }
  const suffix = fileType === 'encrypted_pass' ? 'encrypted_pass' : 'encrypted';
  return `${prefix}${targetKey}_${timestamp}_${suffix}.json`;
}

export interface BackupInventory {
  managed: BackupSet[];
  unmanaged: string[];
}

export function inventoryBackups(backupFolder: string, configuredTargetKeys: string[]): BackupInventory {
  const keySet = new Set(configuredTargetKeys);
  const setMap = new Map<string, BackupSet>();
  const unmanaged: string[] = [];

  let files: string[];
  try {
    files = readdirSync(backupFolder);
  } catch {
    return { managed: [], unmanaged: [] };
  }

  for (const filename of files) {
    const fullPath = join(backupFolder, filename);
    const stat = statSync(fullPath, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) continue;

    const parsed = parseBackupFilename(filename);
    if (!parsed || !keySet.has(parsed.targetKey)) {
      unmanaged.push(fullPath);
      continue;
    }

    const setKey = `${parsed.kind}:${parsed.targetKey}:${parsed.timestamp}`;
    if (!setMap.has(setKey)) {
      setMap.set(setKey, {
        targetKey: parsed.targetKey,
        kind: parsed.kind,
        timestamp: parsed.timestamp,
        files: [],
        sizeBytes: 0,
      });
    }
    const bkSet = setMap.get(setKey)!;
    const backupFile: BackupFile = {
      path: fullPath,
      filename,
      targetKey: parsed.targetKey,
      kind: parsed.kind,
      timestamp: parsed.timestamp,
      fileType: parsed.fileType,
      sizeBytes: stat.size,
    };
    bkSet.files.push(backupFile);
    bkSet.sizeBytes += stat.size;

    if (parsed.fileType === 'meta') {
      try {
        const meta = JSON.parse(readFileSync(fullPath, 'utf-8')) as BackupMeta;
        bkSet.meta = meta;
      } catch { /* ignore corrupt sidecar */ }
    }
  }

  const managed = [...setMap.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return { managed, unmanaged };
}

export interface RetentionConfig {
  keepDaily: number;
  keepMonthly: number;
}

/** Pure retention planner — returns the set keys to DELETE (not keep) */
export function planRetention(
  sets: BackupSet[],
  config: RetentionConfig,
): BackupSet[] {
  // Group by target
  const byTarget = new Map<string, BackupSet[]>();
  for (const s of sets) {
    const k = `${s.kind}:${s.targetKey}`;
    if (!byTarget.has(k)) byTarget.set(k, []);
    byTarget.get(k)!.push(s);
  }

  const toDelete: BackupSet[] = [];

  for (const [, targetSets] of byTarget) {
    // Sort newest first
    const sorted = [...targetSets].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const keep = new Set<string>();

    // Keep newest keepDaily
    for (const s of sorted.slice(0, config.keepDaily)) {
      keep.add(s.timestamp);
    }

    // Keep newest per month for keepMonthly months
    const monthsSeen = new Set<string>();
    for (const s of sorted) {
      const month = s.timestamp.slice(0, 6); // YYYYMM
      if (!monthsSeen.has(month)) {
        monthsSeen.add(month);
        keep.add(s.timestamp);
        if (monthsSeen.size >= config.keepMonthly) break;
      }
    }

    // Always keep at least one
    if (sorted.length > 0 && keep.size === 0) {
      keep.add(sorted[0].timestamp);
    }
    if (sorted.length > 0 && !keep.has(sorted[0].timestamp)) {
      // This can't happen because keepDaily >= 1, but be safe
      keep.add(sorted[0].timestamp);
    }

    for (const s of sorted) {
      if (!keep.has(s.timestamp)) {
        toDelete.push(s);
      }
    }
  }

  return toDelete;
}

export interface IntegrityResult {
  path: string;
  ok: boolean;
  reason?: string;
}

export function checkIntegrity(set: BackupSet): IntegrityResult[] {
  const results: IntegrityResult[] = [];
  for (const file of set.files) {
    if (file.fileType === 'meta') continue;
    try {
      const content = readFileSync(file.path, 'utf-8');
      JSON.parse(content); // validates JSON
      const sha = createHash('sha256').update(content).digest('hex');
      if (set.meta?.sha256 && set.meta.sha256 !== sha) {
        results.push({ path: file.path, ok: false, reason: `SHA256 mismatch: expected ${set.meta.sha256}, got ${sha}` });
      } else if (set.meta?.sizeBytes && set.meta.sizeBytes !== file.sizeBytes) {
        results.push({ path: file.path, ok: false, reason: `Size mismatch: expected ${set.meta.sizeBytes}, got ${file.sizeBytes}` });
      } else {
        results.push({ path: file.path, ok: true });
      }
    } catch (err: unknown) {
      results.push({ path: file.path, ok: false, reason: String(err) });
    }
  }
  return results;
}

export function deleteSet(set: BackupSet): void {
  for (const file of set.files) {
    unlinkSync(file.path);
  }
}

/** Find the newest password-protected export for a given target */
export function findNewestExport(backupFolder: string, targetKey: string, kind: BackupKind): string | null {
  const prefix = kind === 'org' ? `bitwarden_org_export_${targetKey}_` : `bitwarden_export_${targetKey}_`;
  const suffix = '_encrypted_pass.json';
  let files: string[];
  try {
    files = readdirSync(backupFolder);
  } catch {
    return null;
  }
  const matches = files
    .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
    .sort()
    .reverse();
  return matches.length > 0 ? join(backupFolder, matches[0]) : null;
}
