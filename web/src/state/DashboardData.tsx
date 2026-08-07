import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  BackupSet,
  CredentialPrompt,
  Job,
  JobState,
  Prompt,
  TargetStatus,
} from '../types.js';
import {
  createJob,
  getBackups,
  getLiveCounts,
  getStatus,
  openJobStream,
  LiveCountEntry,
  LiveCountUpdate,
} from '../api.js';
import { CredentialModal } from '../components/CredentialModal.js';
import { isActive } from '../lib/status.js';

export type LiveCounts = Record<string, LiveCountEntry>;

interface DashboardData {
  /** Vault status per target. Only refreshed on demand — it unlocks vaults. */
  status: Record<string, TargetStatus>;
  statusLoading: boolean;
  refreshStatus: () => Promise<void>;

  /** Live vault item counts with per-side timestamps, persisted server-side across reloads. */
  liveCounts: LiveCounts;
  countLoading: boolean;
  startCounts: (targets: string[]) => Promise<void>;

  /**
   * Starts a backup/import job and follows it, so the counts it takes along the way land in
   * `liveCounts`. Resolves with the new job id; rejects if the job could not be created.
   */
  startJob: (targets: string[], operations: string[]) => Promise<string>;

  backupSets: BackupSet[];
  refreshBackups: () => Promise<void>;

  selectedTargets: Set<string>;
  setSelectedTargets: React.Dispatch<React.SetStateAction<Set<string>>>;

  error: string;
  setError: (message: string) => void;
}

const DashboardDataContext = createContext<DashboardData | null>(null);

export function useDashboardData(): DashboardData {
  const value = useContext(DashboardDataContext);
  if (!value) throw new Error('useDashboardData must be used inside <DashboardDataProvider>');
  return value;
}

/**
 * Holds the dashboard's expensive-to-rebuild state above the page switch, so
 * moving between Dashboard/Jobs/Backups keeps live counts, vault status and the
 * target selection — and lets a running count job survive the navigation.
 */
export function DashboardDataProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Record<string, TargetStatus>>({});
  const [statusLoading, setStatusLoading] = useState(false);
  const [backupSets, setBackupSets] = useState<BackupSet[]>([]);
  const [liveCounts, setLiveCounts] = useState<LiveCounts>({});
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [countJobId, setCountJobId] = useState<string | null>(null);
  const [countJob, setCountJob] = useState<Job | null>(null);
  const [countLoading, setCountLoading] = useState(false);
  const [runJobId, setRunJobId] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    setStatusLoading(true);
    setError('');
    try {
      setStatus(await getStatus());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to refresh status');
    } finally {
      setStatusLoading(false);
    }
  }, []);

  const refreshBackups = useCallback(async () => {
    try {
      const inv = await getBackups();
      setBackupSets(inv.managed);
    } catch { /* non-fatal */ }
  }, []);

  // Live counts are persisted server-side (server/src/liveCounts.ts), so the last known count
  // and when it was taken survive a page reload or a server restart.
  useEffect(() => {
    getLiveCounts().then(setLiveCounts).catch(() => { /* non-fatal — dashboard still works without it */ });
  }, []);

  /**
   * Folds one reading pushed by a running job into the table. Every job that lists a vault
   * reports what it saw — a backup its source, an import its destination after the fact — so
   * the numbers move as the job runs rather than only when a 'count' job is asked for.
   */
  const applyLiveCount = useCallback((u: LiveCountUpdate) => {
    setLiveCounts((prev) => ({
      ...prev,
      [u.target]: {
        ...prev[u.target],
        [u.role]: u.count,
        [u.role === 'source' ? 'sourceAt' : 'destAt']: u.at,
      },
    }));
  }, []);

  const startCounts = useCallback(async (targets: string[]) => {
    setError('');
    setCountLoading(true);
    try {
      const r = await createJob(targets, ['count']);
      setCountJobId(r.jobId);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to fetch live item counts');
      setCountLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!countJobId) return;
    const ws = openJobStream(countJobId);
    let finished = false;
    let cancelled = false;

    async function finish() {
      if (finished) return;
      finished = true;
      try {
        // Re-read from the server rather than the job's in-memory `results`: each side is
        // persisted as soon as it succeeds (see runner.ts), so this also picks up whatever
        // targets finished counting even if the job as a whole ended up partial/failed.
        setLiveCounts(await getLiveCounts());
      } catch {
        setError('Failed to load live item count results');
      } finally {
        setCountLoading(false);
        setCountJobId(null);
        setCountJob(null);
      }
    }

    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data as string) as { type: string; data?: unknown; job?: Job };
      if (msg.type === 'counts' && msg.data) {
        applyLiveCount(msg.data as LiveCountUpdate);
      } else if (msg.type === 'snapshot' && msg.job) {
        setCountJob(msg.job);
        if (!isActive(msg.job.state)) finish();
      } else if (msg.type === 'prompt') {
        const prompt = msg.data as Prompt | null;
        setCountJob((prev) => prev ? { ...prev, prompt: prompt ?? undefined } : prev);
      } else if (msg.type === 'job' && msg.data) {
        const upd = msg.data as { state: JobState };
        setCountJob((prev) => prev ? { ...prev, state: upd.state } : prev);
        if (!isActive(upd.state)) finish();
      }
    };
    // In dev, React StrictMode mounts this effect twice: the first WebSocket is
    // closed by cleanup before it finishes connecting, which fires onerror on a
    // connection we already discarded. Ignore errors once cleanup has run.
    ws.onerror = () => { if (!cancelled) setError('WebSocket error while fetching live item counts'); };

    return () => {
      cancelled = true;
      ws.close();
    };
  }, [countJobId, applyLiveCount]);

  const startJob = useCallback(async (targets: string[], operations: string[]) => {
    const r = await createJob(targets, operations);
    setRunJobId(r.jobId);
    return r.jobId;
  }, []);

  // A backup/import job takes live readings of its own — the source listing behind the backup
  // sidecar, the destination listing behind the import verify — so follow the one this
  // dashboard started and let its counts land here directly. Prompts are deliberately not
  // handled: the user is sent to the job view, which owns the modals for these jobs.
  useEffect(() => {
    if (!runJobId) return;
    const ws = openJobStream(runJobId);
    let settled = false;

    async function settle() {
      if (settled) return;
      settled = true;
      setRunJobId(null);
      // Re-read the store on the way out: it is authoritative, and it recovers any reading
      // pushed while this socket was down (or before the page was open).
      try {
        setLiveCounts(await getLiveCounts());
      } catch { /* the counts streamed in above still stand */ }
      // The run just changed what is on disk, so the "last backup" column has to move with it.
      refreshBackups();
    }

    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data as string) as { type: string; data?: unknown; job?: Job };
      if (msg.type === 'counts' && msg.data) {
        applyLiveCount(msg.data as LiveCountUpdate);
      } else if (msg.type === 'snapshot' && msg.job) {
        if (!isActive(msg.job.state)) settle();
      } else if (msg.type === 'job' && msg.data) {
        if (!isActive((msg.data as { state: JobState }).state)) settle();
      }
    };
    // No error banner here: this stream only keeps the dashboard's numbers current, and the
    // job view the user was sent to reports connection trouble already.
    ws.onerror = () => { /* ignored */ };

    return () => ws.close();
  }, [runJobId, applyLiveCount, refreshBackups]);

  const value = useMemo<DashboardData>(() => ({
    status,
    statusLoading,
    refreshStatus,
    liveCounts,
    countLoading,
    startCounts,
    startJob,
    backupSets,
    refreshBackups,
    selectedTargets,
    setSelectedTargets,
    error,
    setError,
  }), [
    status, statusLoading, refreshStatus,
    liveCounts, countLoading, startCounts, startJob,
    backupSets, refreshBackups,
    selectedTargets, error,
  ]);

  const countPrompt: Prompt | undefined = countJob?.prompt;

  return (
    <DashboardDataContext.Provider value={value}>
      {children}
      {/* Rendered here rather than in Dashboard so the count job stays answerable
          from any page. */}
      {countPrompt?.kind === 'credentials' && countJobId && (
        <CredentialModal
          jobId={countJobId}
          prompt={countPrompt as CredentialPrompt}
          onSubmitted={() => setCountJob((prev) => prev ? { ...prev, prompt: undefined } : prev)}
        />
      )}
    </DashboardDataContext.Provider>
  );
}
