import { listItems } from './session.js';
import { LogCallback } from './bwCli.js';
import { BackupMeta } from './backups.js';

export interface DiffItem {
  type: number;
  name: string;
  username?: string | null;
}

/** Where `sourceCount` came from — surfaced so a tripped guard can be judged in context. */
export type SourceCountOrigin = 'live' | 'captured' | 'meta' | 'export';

export interface DiffResult {
  sourceCount: number | 'unknown';
  sourceCountOrigin?: SourceCountOrigin;
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

/** Identity used to match a source item against a destination one. */
function toTuple(item: DiffItem): string {
  return `${item.type}|${item.name.toLowerCase()}|${item.username ?? null}`;
}

export function toDiffItem(item: Record<string, unknown>): DiffItem {
  const login = item['login'] as Record<string, unknown> | undefined;
  return {
    type: item['type'] as number ?? 0,
    name: item['name'] as string ?? '',
    username: (login?.['username'] as string | null | undefined) ?? null,
  };
}

export async function computeDiff(opts: {
  /**
   * Items the source vault held, listed during the backup phase of this same run.
   * The richest input — it yields the name-level added/removed lists as well as the count.
   */
  sourceItems?: DiffItem[];
  /** Count alone, for an export this run did not produce (sidecar or export envelope). */
  sourceCount?: number;
  sourceCountOrigin?: SourceCountOrigin;
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

  // Source count, best input first: items captured this run, a count read off the
  // backup on disk, the sidecar, then a live listing of a still-unlocked source.
  let sourceCount: number | 'unknown' = 'unknown';
  let sourceCountOrigin: SourceCountOrigin | undefined;
  let sourceItems: DiffItem[] | null = null;

  if (opts.sourceItems) {
    sourceItems = opts.sourceItems;
    sourceCount = opts.sourceItems.length;
    sourceCountOrigin = opts.sourceCountOrigin ?? 'captured';
  } else if (opts.sourceCount !== undefined) {
    sourceCount = opts.sourceCount;
    sourceCountOrigin = opts.sourceCountOrigin ?? 'export';
  } else if (meta?.itemCount !== undefined) {
    sourceCount = meta.itemCount;
    sourceCountOrigin = 'meta';
  } else if (opts.sourceProfileDir && opts.sourceSessionKey) {
    const sourceVaultItems = await listItems(opts.sourceProfileDir, opts.sourceSessionKey, { organizationId: opts.sourceOrgId }, log);
    const filtered = opts.sourceOrgId
      ? (sourceVaultItems as Array<Record<string, unknown>>).filter((i) => i['organizationId'] === opts.sourceOrgId)
      : (sourceVaultItems as Array<Record<string, unknown>>).filter((i) => !i['organizationId']);
    sourceCount = filtered.length;
    sourceItems = filtered.map(toDiffItem);
    sourceCountOrigin = 'live';
  }

  // Name-level diff. Runs over the full sets — capping either side would invent
  // additions and removals out of whatever order `bw list` happened to return.
  const added: DiffItem[] = [];
  const removed: DiffItem[] = [];
  let unchanged = 0;

  if (sourceItems) {
    const srcTuples = new Set(sourceItems.map(toTuple));
    const dstTuples = new Map<string, DiffItem>();
    for (const item of filteredDest) {
      const di = toDiffItem(item);
      dstTuples.set(toTuple(di), di);
    }

    for (const src of sourceItems) {
      if (dstTuples.has(toTuple(src))) {
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
    ...(sourceCountOrigin ? { sourceCountOrigin } : {}),
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
