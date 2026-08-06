import { listItems } from './session.js';
import { LogCallback } from './bwCli.js';
import { BackupMeta } from './backups.js';

export interface DiffItem {
  type: number;
  name: string;
  username?: string | null;
}

export interface DiffResult {
  sourceCount: number | 'unknown';
  destCount: number;
  added: DiffItem[];
  removed: DiffItem[];
  unchanged: number;
  guardTripped: boolean;
  guardReason?: string;
}

export interface ImportGuardConfig {
  minSourceRatio: number;
  blockOnEmptySource: boolean;
}

function toTuple(item: Record<string, unknown>): string {
  const type = item['type'] as number ?? 0;
  const name = (item['name'] as string ?? '').toLowerCase();
  const login = item['login'] as Record<string, unknown> | undefined;
  const username = (login?.['username'] as string | null | undefined) ?? null;
  return `${type}|${name}|${username}`;
}

function toDiffItem(item: Record<string, unknown>): DiffItem {
  const login = item['login'] as Record<string, unknown> | undefined;
  return {
    type: item['type'] as number ?? 0,
    name: item['name'] as string ?? '',
    username: (login?.['username'] as string | null | undefined) ?? null,
  };
}

export async function computeDiff(opts: {
  sourceProfileDir?: string;
  sourceSessionKey?: string;
  sourceOrgId?: string;
  destProfileDir: string;
  destSessionKey: string;
  destOrgId?: string;
  meta?: BackupMeta;
  log?: LogCallback;
}): Promise<DiffResult> {
  const { destProfileDir, destSessionKey, destOrgId, meta, log } = opts;

  // Destination count (live)
  const destItems = await listItems(destProfileDir, destSessionKey, { organizationId: destOrgId }, log);
  const filteredDest = destOrgId
    ? (destItems as Array<Record<string, unknown>>).filter((i) => i['organizationId'] === destOrgId)
    : (destItems as Array<Record<string, unknown>>).filter((i) => !i['organizationId']);
  const destCount = filteredDest.length;

  // Source count
  let sourceCount: number | 'unknown' = 'unknown';
  let sourceItems: DiffItem[] | null = null;

  if (meta?.itemCount !== undefined) {
    sourceCount = meta.itemCount;
  } else if (opts.sourceProfileDir && opts.sourceSessionKey) {
    const sourceVaultItems = await listItems(opts.sourceProfileDir, opts.sourceSessionKey, { organizationId: opts.sourceOrgId }, log);
    const filtered = opts.sourceOrgId
      ? (sourceVaultItems as Array<Record<string, unknown>>).filter((i) => i['organizationId'] === opts.sourceOrgId)
      : (sourceVaultItems as Array<Record<string, unknown>>).filter((i) => !i['organizationId']);
    sourceCount = filtered.length;
    sourceItems = filtered.slice(0, 200).map(toDiffItem);
  }

  // Name-level diff
  const destSet = new Map<string, DiffItem>();
  for (const item of filteredDest.slice(0, 200)) {
    const di = toDiffItem(item as Record<string, unknown>);
    destSet.set(toTuple(item as Record<string, unknown>), di);
  }

  const added: DiffItem[] = [];
  const removed: DiffItem[] = [];
  let unchanged = 0;

  if (sourceItems) {
    const srcTuples = new Set(sourceItems.map((i) => `${i.type}|${i.name.toLowerCase()}|${i.username ?? null}`));
    const dstTuples = new Map(
      filteredDest.slice(0, 200).map((i) => {
        const di = toDiffItem(i as Record<string, unknown>);
        return [`${di.type}|${di.name.toLowerCase()}|${di.username ?? null}`, di];
      }),
    );

    for (const src of sourceItems) {
      const k = `${src.type}|${src.name.toLowerCase()}|${src.username ?? null}`;
      if (dstTuples.has(k)) {
        unchanged++;
      } else {
        added.push(src);
      }
    }
    for (const [k, dst] of dstTuples) {
      if (!srcTuples.has(k)) removed.push(dst);
    }
  }

  // Guard evaluation
  let guardTripped = false;
  let guardReason: string | undefined;

  if (sourceCount === 'unknown') {
    guardTripped = true;
    guardReason = 'Source item count is unknown';
  } else if (sourceCount === 0) {
    guardTripped = true;
    guardReason = 'Source is empty (0 items)';
  } else if (destCount > 0) {
    const ratio = sourceCount / destCount;
    if (ratio < 0.5) {
      guardTripped = true;
      guardReason = `Source count (${sourceCount}) is less than ${Math.round(ratio * 100)}% of destination count (${destCount})`;
    }
  }

  return {
    sourceCount,
    destCount,
    added: added.slice(0, 50),
    removed: removed.slice(0, 50),
    unchanged,
    guardTripped,
    guardReason,
  };
}

export function evaluateGuard(
  result: DiffResult,
  config: ImportGuardConfig,
): { blocked: boolean; reason?: string } {
  if (result.sourceCount === 'unknown') {
    return { blocked: true, reason: 'Source item count is unknown' };
  }
  if (config.blockOnEmptySource && result.sourceCount === 0) {
    return { blocked: true, reason: 'Source is empty (blockOnEmptySource=true)' };
  }
  if (
    result.destCount > 0 &&
    result.sourceCount < result.destCount * config.minSourceRatio
  ) {
    return {
      blocked: true,
      reason: `Source count (${result.sourceCount}) < ${Math.round(config.minSourceRatio * 100)}% of destination (${result.destCount})`,
    };
  }
  return { blocked: false };
}
