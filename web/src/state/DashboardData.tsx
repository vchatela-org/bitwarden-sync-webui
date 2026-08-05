import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  BackupSet,
  CredentialPrompt,
  Job,
  JobState,
  Prompt,
  TargetStatus,
} from '../types.js';
import { createJob, getBackups, getJob, getStatus, openJobStream } from '../api.js';
import { CredentialModal } from '../components/CredentialModal.js';
import { isActive } from '../lib/status.js';

export type LiveCounts = Record<string, { cloud?: number; home?: number }>;

interface DashboardData {
  /** Vault status per target. Only refreshed on demand — it unlocks vaults. */
  status: Record<string, TargetStatus>;
  statusLoading: boolean;
  refreshStatus: () => Promise<void>;

  /** Live vault item counts, merged across every count job of this session. */
  liveCounts: LiveCounts;
  countLoading: boolean;
  startCounts: (targets: string[]) => Promise<void>;

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

    async function finish() {
      if (finished) return;
      finished = true;
      try {
        const full = await getJob(countJobId!);
        if (full.results) {
          setLiveCounts((prev) => {
            const next = { ...prev };
            for (const [key, r] of Object.entries(full.results!)) {
              next[key] = { cloud: r.cloud, home: r.home };
            }
            return next;
          });
        }
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
      if (msg.type === 'snapshot' && msg.job) {
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
    ws.onerror = () => setError('WebSocket error while fetching live item counts');

    return () => ws.close();
  }, [countJobId]);

  const value = useMemo<DashboardData>(() => ({
    status,
    statusLoading,
    refreshStatus,
    liveCounts,
    countLoading,
    startCounts,
    backupSets,
    refreshBackups,
    selectedTargets,
    setSelectedTargets,
    error,
    setError,
  }), [
    status, statusLoading, refreshStatus,
    liveCounts, countLoading, startCounts,
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
