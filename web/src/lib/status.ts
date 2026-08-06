import type { JobState, StepState } from '../types.js';
import type { Tone } from '../components/ui/Badge.js';

/** Job states the runner can still move out of on its own. */
export const ACTIVE_JOB_STATES: JobState[] = [
  'queued',
  'running',
  'awaiting-credentials',
  'awaiting-confirmation',
];

export function isActive(state: JobState): boolean {
  return ACTIVE_JOB_STATES.includes(state);
}

export const JOB_TONE: Record<JobState, Tone> = {
  queued: 'neutral',
  running: 'info',
  'awaiting-credentials': 'violet',
  'awaiting-confirmation': 'warn',
  succeeded: 'ok',
  failed: 'danger',
  partial: 'warn',
  aborted: 'neutral',
};

export const JOB_LABEL: Record<JobState, string> = {
  queued: 'Queued',
  running: 'Running',
  'awaiting-credentials': 'Needs credentials',
  'awaiting-confirmation': 'Needs confirmation',
  succeeded: 'Succeeded',
  failed: 'Failed',
  partial: 'Partial',
  aborted: 'Aborted',
};

export const STEP_TONE: Record<StepState, Tone> = {
  pending: 'neutral',
  running: 'info',
  succeeded: 'ok',
  failed: 'danger',
  skipped: 'neutral',
  warning: 'warn',
  'awaiting-input': 'violet',
};

/** Tailwind background used for the step dots in the job list. */
export const STEP_DOT_BG: Record<StepState, string> = {
  pending: 'bg-fg-faint',
  running: 'bg-info',
  succeeded: 'bg-ok',
  failed: 'bg-danger',
  skipped: 'bg-fg-faint',
  warning: 'bg-warn',
  'awaiting-input': 'bg-violet',
};

/** Vault lock state reported by `bw status`. */
export function vaultTone(status: string): Tone {
  switch (status) {
    case 'unlocked':
      return 'ok';
    case 'locked':
      return 'warn';
    case 'unauthenticated':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Backup timestamps are `YYYYMMDD_HHMMSS` in UTC. */
export function parseTimestamp(ts: string): Date {
  return new Date(
    `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(9, 11)}:${ts.slice(11, 13)}:00Z`,
  );
}

export function formatTimestamp(ts: string): string {
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(9, 11)}:${ts.slice(11, 13)}`;
}

/** Relative age of a backup, with a freshness tone: green < 2d, amber < 8d, red beyond. */
export function backupAge(ts: string): { label: string; tone: Tone } {
  const days = (Date.now() - parseTimestamp(ts).getTime()) / 86_400_000;
  if (days < 1 / 24) return { label: 'just now', tone: 'ok' };
  if (days < 2) return { label: `${Math.round(days * 24)}h ago`, tone: 'ok' };
  if (days < 8) return { label: `${Math.floor(days)}d ago`, tone: 'warn' };
  return { label: `${Math.floor(days)}d ago`, tone: 'danger' };
}

/** Relative age of an arbitrary ISO timestamp, e.g. "12m ago", "3h ago", "2d ago". */
export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatDuration(startedAt?: string, endedAt?: string): string | null {
  if (!startedAt || !endedAt) return null;
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}
