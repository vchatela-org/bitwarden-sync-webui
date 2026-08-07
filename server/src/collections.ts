import { runBw, LogCallback } from './bwCli.js';
import { listOrgCollections, syncProfile } from './session.js';

export interface BwCollection {
  id: string;
  name: string;
  organizationId: string;
}

export interface StaleCollection {
  /** Pre-existing collection, emptied by the purge and superseded by the import. */
  staleId: string;
  /** Same-named collection the importer just created, holding this run's items. */
  replacementId: string;
  name: string;
}

/**
 * Pure planner: which pre-import collections the import has superseded.
 *
 * The import phase purges the destination org before importing, and the purge API clears
 * ciphers but leaves collections standing. `bw import` never reuses a collection by name,
 * so every collection in the export comes back as a second, freshly-created one holding all
 * the items, next to the emptied original. Those originals are what this plans to remove.
 *
 * A pre-import collection with no same-named replacement is left alone — it is a collection
 * the export simply doesn't cover (an org's `Default collection`, typically), not a leftover.
 */
export function planStaleCollections(
  allCollections: BwCollection[],
  preImportIds: string[],
): StaleCollection[] {
  const preSet = new Set(preImportIds);

  // Map lowercased name → id of a collection the importer created this run
  const replacementByName = new Map<string, string>();
  for (const col of allCollections) {
    if (!preSet.has(col.id)) {
      replacementByName.set(col.name.toLowerCase(), col.id);
    }
  }

  const plan: StaleCollection[] = [];
  for (const col of allCollections) {
    if (!preSet.has(col.id)) continue; // created by this import, keep it
    const replacementId = replacementByName.get(col.name.toLowerCase());
    if (replacementId && replacementId !== col.id) {
      plan.push({ staleId: col.id, replacementId, name: col.name });
    }
  }
  return plan;
}

export interface ReconcileResult {
  removed: number;
  needsReview: number;
}

/**
 * Number of items in a collection, or null when that can't be established — a failed
 * command or unparseable output must not be read as "empty", since the count is what
 * authorises a delete.
 */
async function collectionItemCount(opts: {
  profileDir: string;
  sessionKey: string;
  collectionId: string;
  log?: LogCallback;
}): Promise<number | null> {
  const { profileDir, sessionKey, collectionId, log } = opts;
  // Full item contents (names, usernames, passwords) — keep stdout out of the job log.
  const result = await runBw(
    ['list', 'items', '--collectionid', collectionId, '--session', sessionKey],
    { profileDir, timeout: 30000, silenceStdout: true },
    log,
  );
  if (result.exitCode !== 0) return null;
  try {
    const items = JSON.parse(result.stdout) as unknown[];
    return Array.isArray(items) ? items.length : null;
  } catch {
    return null;
  }
}

/**
 * Removes the collections the import superseded, leaving one collection per name.
 *
 * The superseded collection is deleted rather than drained into: post-purge it is empty and
 * the imported one holds every item, so draining would mean moving the whole vault back
 * across two `bw` invocations per item. The trade-off is that a collection's id changes on
 * every sync, so group and member access assignments bound to the old id do not survive.
 */
export async function reconcileOrgCollections(opts: {
  profileDir: string;
  sessionKey: string;
  orgId: string;
  preImportIds: string[];
  log?: LogCallback;
  /** Polled between collections so a cancelled job stops at the next one. */
  shouldAbort?: () => boolean;
}): Promise<ReconcileResult> {
  const { profileDir, sessionKey, orgId, preImportIds, log, shouldAbort } = opts;

  log?.('app' as never, `[collections] Reconciling org collections for org ${orgId}...`);
  await syncProfile(profileDir, sessionKey, log);

  const cols = (await listOrgCollections(profileDir, sessionKey, orgId, log)) as BwCollection[];

  const plan = planStaleCollections(cols, preImportIds);
  if (plan.length === 0) {
    log?.('app' as never, '[collections] ✅ No superseded collections — nothing to reconcile.');
    return { removed: 0, needsReview: 0 };
  }

  let removed = 0;
  let needsReview = 0;

  for (const { staleId, replacementId, name } of plan) {
    if (shouldAbort?.()) {
      log?.('app' as never, '[collections] ⏹️ Cancelled — remaining collections left in place');
      needsReview = plan.length - removed; // everything not already deleted is unresolved
      break;
    }

    // The purge should have emptied this one. Confirm before deleting: if the purge was
    // partial, or this is somehow the collection holding the imported items, deleting it
    // would take real data with it.
    const remaining = await collectionItemCount({ profileDir, sessionKey, collectionId: staleId, log });
    if (remaining === null) {
      log?.('app' as never, `[collections] ⚠️ Could not count items in superseded '${name}' (${staleId}); left in place`);
      needsReview++;
      continue;
    }
    if (remaining > 0) {
      log?.('app' as never, `[collections] ⚠️ Superseded '${name}' (${staleId}) still holds ${remaining} item(s); left in place`);
      needsReview++;
      continue;
    }

    log?.('app' as never, `[collections] Removing superseded '${name}' (${staleId}) — replaced by (${replacementId})`);
    const delResult = await runBw(
      ['delete', 'org-collection', staleId, '--organizationid', orgId, '--session', sessionKey],
      { profileDir, timeout: 10000 },
      log,
    );
    if (delResult.exitCode !== 0) {
      log?.('app' as never, `[collections] ⚠️ Failed to delete superseded collection ${staleId}`);
      needsReview++;
    } else {
      removed++;
    }
  }

  if (needsReview > 0) {
    log?.('app' as never, `[collections] ⚠️ Removed ${removed}, ${needsReview} need manual review`);
  } else {
    log?.('app' as never, `[collections] ✅ Removed ${removed} superseded collection(s)`);
  }

  return { removed, needsReview };
}
