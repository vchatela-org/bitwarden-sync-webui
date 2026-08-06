import { runBw, LogCallback } from './bwCli.js';
import { listOrgCollections, syncProfile } from './session.js';

export interface BwCollection {
  id: string;
  name: string;
  organizationId: string;
}

export interface BwItem {
  id: string;
  collectionIds: string[];
  organizationId?: string;
}

export interface MergePlan {
  duplicateId: string;
  originalId: string;
  name: string;
}

/** Pure planner: given current collections and pre-import ids, produce a merge plan */
export function planCollectionMerge(
  allCollections: BwCollection[],
  preImportIds: string[],
): MergePlan[] {
  const preSet = new Set(preImportIds);

  // Map lowercased name → original collection id
  const origByName = new Map<string, string>();
  for (const col of allCollections) {
    if (preSet.has(col.id)) {
      origByName.set(col.name.toLowerCase(), col.id);
    }
  }

  const plan: MergePlan[] = [];
  for (const col of allCollections) {
    if (preSet.has(col.id)) continue; // not a new collection
    const origId = origByName.get(col.name.toLowerCase());
    if (origId && origId !== col.id) {
      plan.push({ duplicateId: col.id, originalId: origId, name: col.name });
    }
  }
  return plan;
}

export interface DedupeResult {
  merged: number;
  needsReview: number;
}

export async function dedupeOrgCollections(opts: {
  profileDir: string;
  sessionKey: string;
  orgId: string;
  preImportIds: string[];
  log?: LogCallback;
}): Promise<DedupeResult> {
  const { profileDir, sessionKey, orgId, preImportIds, log } = opts;

  log?.('app' as never, `[collections] Reconciling org collections for org ${orgId}...`);
  await syncProfile(profileDir, sessionKey, log);

  const rawCols = await listOrgCollections(profileDir, sessionKey, orgId, log);
  const cols = rawCols as BwCollection[];

  const plan = planCollectionMerge(cols, preImportIds);
  if (plan.length === 0) {
    log?.('app' as never, '[collections] ✅ No duplicate collections — importer reused existing ones.');
    return { merged: 0, needsReview: 0 };
  }

  let merged = 0;
  let needsReview = 0;

  for (const { duplicateId, originalId, name } of plan) {
    log?.('app' as never, `[collections] Merging duplicate '${name}' (${duplicateId}) → (${originalId})`);

    // Get items in duplicate (full item contents incl. passwords — keep stdout out of the log)
    const listResult = await runBw(
      ['list', 'items', '--collectionid', duplicateId, '--session', sessionKey],
      { profileDir, timeout: 30000, silenceStdout: true },
      log,
    );
    let dupItems: BwItem[] = [];
    try {
      dupItems = JSON.parse(listResult.stdout) as BwItem[];
    } catch { /* empty */ }

    if (dupItems.length === 0) {
      log?.('app' as never, `[collections] ⚠️ Duplicate '${name}' had no movable items; left in place`);
      needsReview++;
      continue;
    }

    let moveFailed = false;
    let moved = 0;

    for (const item of dupItems) {
      const getResult = await runBw(['get', 'item', item.id, '--session', sessionKey], { profileDir, timeout: 10000, silenceStdout: true }, log);
      let fullItem: BwItem;
      try {
        fullItem = JSON.parse(getResult.stdout) as BwItem;
      } catch {
        log?.('app' as never, `[collections] ⚠️ Failed to get item ${item.id}`);
        moveFailed = true;
        continue;
      }

      // Replace duplicateId with originalId in collectionIds
      const newCollIds = [...new Set(
        (fullItem.collectionIds ?? []).map((id) => (id === duplicateId ? originalId : id)),
      )];
      const updatedItem = { ...fullItem, collectionIds: newCollIds };

      // Encode and edit
      const encoded = Buffer.from(JSON.stringify(updatedItem)).toString('base64');
      const editResult = await runBw(
        ['edit', 'item', item.id, '--session', sessionKey],
        { profileDir, stdin: encoded, timeout: 10000, silenceStdout: true },
        log,
      );
      if (editResult.exitCode !== 0) {
        log?.('app' as never, `[collections] ⚠️ Failed to move item ${item.id}`);
        moveFailed = true;
      } else {
        moved++;
      }
    }

    if (moveFailed) {
      log?.('app' as never, `[collections] ⚠️ Some items could not be moved; keeping duplicate ${duplicateId}`);
      needsReview++;
      continue;
    }

    if (moved === 0) {
      log?.('app' as never, `[collections] ⚠️ No items moved from ${duplicateId}; left in place`);
      needsReview++;
      continue;
    }

    // Delete duplicate
    const delResult = await runBw(
      ['delete', 'org-collection', duplicateId, '--organizationid', orgId, '--session', sessionKey],
      { profileDir, timeout: 10000 },
      log,
    );
    if (delResult.exitCode !== 0) {
      log?.('app' as never, `[collections] ⚠️ Items moved but failed to delete duplicate ${duplicateId}`);
      needsReview++;
    } else {
      merged++;
    }
  }

  if (needsReview > 0) {
    log?.('app' as never, `[collections] ⚠️ Merged ${merged}, ${needsReview} need manual review`);
  } else {
    log?.('app' as never, `[collections] ✅ Merged ${merged} duplicate collection(s)`);
  }

  return { merged, needsReview };
}
