import { useState, useEffect } from 'react';
import { Inbox, ChevronRight } from 'lucide-react';
import { Job } from '../types.js';
import { listJobs } from '../api.js';
import { Card } from './ui/Card.js';
import { StatusLabel } from './ui/Badge.js';
import { LoadingPane, EmptyState, Tooltip } from './ui/Feedback.js';
import { cn } from '../lib/cn.js';
import { JOB_TONE, JOB_LABEL, STEP_DOT_BG, isActive, formatDuration } from '../lib/status.js';

interface Props {
  onSelectJob: (jobId: string) => void;
  activeJobId?: string;
  /** Rendered beneath an open job — trims the heading and caps the height. */
  compact?: boolean;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function JobList({ onSelectJob, activeJobId, compact }: Props) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadJobs();
    const t = setInterval(loadJobs, 5000);
    return () => clearInterval(t);
  }, []);

  async function loadJobs() {
    try {
      const j = await listJobs();
      setJobs(j);
    } catch { /* ignore — the poll will retry */ }
    finally { setLoading(false); }
  }

  if (loading) return <LoadingPane label="Loading jobs…" />;

  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-2">
        <h2 className={cn('font-semibold tracking-tight text-fg', compact ? 'text-[13px]' : 'text-base')}>
          {compact ? 'Recent jobs' : 'Job history'}
        </h2>
        {jobs.length > 0 && (
          <span className="text-xs text-fg-subtle">{jobs.length}</span>
        )}
      </div>

      {jobs.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Inbox />}
            title="No jobs yet"
            description="Start a backup or import from the dashboard and it will show up here with live progress."
          />
        </Card>
      ) : (
        <div className={cn('space-y-2', compact && 'scrollbar-thin max-h-96 overflow-y-auto pr-1')}>
          {jobs.map((job) => {
            const active = activeJobId === job.id;
            const running = isActive(job.state);
            const duration = formatDuration(job.startedAt, job.endedAt);
            const done = job.steps.filter((s) => s.state === 'succeeded').length;

            return (
              <button
                key={job.id}
                onClick={() => onSelectJob(job.id)}
                className={cn(
                  'group block w-full rounded-xl border bg-surface px-4 py-3 text-left',
                  'transition-[border-color,background-color] duration-150',
                  active
                    ? 'border-accent-line bg-accent-soft'
                    : 'border-line hover:border-line-strong hover:bg-surface-2',
                )}
              >
                <div className="flex items-center gap-3">
                  <StatusLabel tone={JOB_TONE[job.state]} pulse={running}>
                    {JOB_LABEL[job.state]}
                  </StatusLabel>

                  <span className="font-mono text-[11px] text-fg-faint">{job.id.slice(0, 8)}</span>

                  <span className="ml-auto flex items-center gap-2 text-[11px] text-fg-subtle">
                    <Tooltip content={new Date(job.createdAt).toLocaleString()}>
                      <span>{relativeTime(job.createdAt)}</span>
                    </Tooltip>
                    {duration && (
                      <>
                        <span className="text-fg-faint">·</span>
                        <span className="tabular-nums">{duration}</span>
                      </>
                    )}
                    <ChevronRight
                      className={cn(
                        'size-3.5 transition-transform duration-150',
                        active ? 'text-accent' : 'text-fg-faint group-hover:translate-x-0.5',
                      )}
                    />
                  </span>
                </div>

                <div className="mt-1.5 flex items-center gap-2 text-xs text-fg-muted">
                  <span className="font-medium capitalize">{job.operations.join(' + ')}</span>
                  <span className="text-fg-faint">·</span>
                  <span className="truncate">{job.targets.join(', ')}</span>
                </div>

                {job.steps.length > 0 && (
                  <div className="mt-2.5 flex items-center gap-2">
                    <div className="flex flex-1 flex-wrap gap-1">
                      {job.steps.map((s) => (
                        <Tooltip key={s.id} content={`${s.label} — ${s.state}`}>
                          <span
                            className={cn(
                              'h-1 flex-1 min-w-1.5 rounded-full transition-colors',
                              STEP_DOT_BG[s.state],
                              s.state === 'pending' && 'opacity-40',
                              s.state === 'running' && 'animate-pulse',
                            )}
                          />
                        </Tooltip>
                      ))}
                    </div>
                    <span className="shrink-0 text-[10px] tabular-nums text-fg-faint">
                      {done}/{job.steps.length}
                    </span>
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
