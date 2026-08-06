import { useState, useEffect } from 'react';
import { Inbox, ChevronRight, Trash2, AlertCircle } from 'lucide-react';
import { Job } from '../types.js';
import { listJobs, deleteJobs } from '../api.js';
import { Card } from './ui/Card.js';
import { StatusLabel } from './ui/Badge.js';
import { Checkbox } from './ui/Checkbox.js';
import { Button } from './ui/Button.js';
import { Modal } from './ui/Modal.js';
import { Alert } from './ui/Input.js';
import { LoadingPane, EmptyState, Tooltip } from './ui/Feedback.js';
import { cn } from '../lib/cn.js';
import { JOB_TONE, JOB_LABEL, STEP_DOT_BG, isActive, formatDuration, relativeTime } from '../lib/status.js';

interface Props {
  onSelectJob: (jobId: string) => void;
  activeJobId?: string;
  /** Rendered beneath an open job — trims the heading and caps the height. */
  compact?: boolean;
  /** Called with ids that were actually deleted, so a parent can clear an open job that's gone. */
  onJobsDeleted?: (ids: string[]) => void;
}

export function JobList({ onSelectJob, activeJobId, compact, onJobsDeleted }: Props) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    loadJobs();
    const t = setInterval(loadJobs, 5000);
    return () => clearInterval(t);
  }, []);

  async function loadJobs() {
    try {
      const j = await listJobs();
      setJobs(j);
      setSelected((prev) => {
        const ids = new Set(j.map((job) => job.id));
        const next = new Set([...prev].filter((id) => ids.has(id)));
        return next.size === prev.size ? prev : next;
      });
    } catch { /* ignore — the poll will retry */ }
    finally { setLoading(false); }
  }

  const deletableJobs = jobs.filter((j) => !isActive(j.state));
  const selectableCount = deletableJobs.length;
  const allSelected = selectableCount > 0 && selected.size === selectableCount;
  const someSelected = selected.size > 0 && !allSelected;

  function toggleJob(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === selectableCount ? new Set() : new Set(deletableJobs.map((j) => j.id)),
    );
  }

  async function handleDelete() {
    setDeleting(true);
    setError('');
    try {
      const ids = [...selected];
      const result = await deleteJobs(ids);
      setJobs((prev) => prev.filter((j) => !result.deleted.includes(j.id)));
      setSelected(new Set());
      setConfirming(false);
      onJobsDeleted?.(result.deleted);
      if (result.skipped.length > 0) {
        setError(`${result.skipped.length} job${result.skipped.length === 1 ? '' : 's'} could not be deleted (still running).`);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to delete jobs');
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return <LoadingPane label="Loading jobs…" />;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className={cn('font-semibold tracking-tight text-fg', compact ? 'text-[13px]' : 'text-base')}>
            {compact ? 'Recent jobs' : 'Job history'}
          </h2>
          {jobs.length > 0 && (
            <span className="text-xs text-fg-subtle">{jobs.length}</span>
          )}
        </div>

        {!compact && jobs.length > 0 && (
          <div className="ml-auto flex items-center gap-2">
            {selected.size > 0 && (
              <span className="text-xs text-fg-subtle">{selected.size} selected</span>
            )}
            <Tooltip content={selectableCount === 0 ? 'No finished jobs to delete' : undefined}>
              <span>
                <Button
                  size="sm"
                  variant="dangerSoft"
                  icon={<Trash2 />}
                  disabled={selected.size === 0}
                  onClick={() => setConfirming(true)}
                >
                  Delete
                </Button>
              </span>
            </Tooltip>
          </div>
        )}
      </div>

      {error && <Alert icon={<AlertCircle />}>{error}</Alert>}

      {!compact && jobs.length > 0 && (
        <label className="flex items-center gap-2 px-1 text-xs text-fg-subtle">
          <Checkbox
            checked={someSelected ? 'indeterminate' : allSelected}
            onCheckedChange={toggleAll}
            disabled={selectableCount === 0}
            aria-label="Select all finished jobs"
          />
          Select all finished jobs
        </label>
      )}

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
              <div
                key={job.id}
                className={cn(
                  'group flex items-stretch rounded-xl border bg-surface',
                  'transition-[border-color,background-color] duration-150',
                  active
                    ? 'border-accent-line bg-accent-soft'
                    : 'border-line hover:border-line-strong hover:bg-surface-2',
                )}
              >
                {!compact && (
                  <div
                    className="flex items-start pl-3.5 pt-3.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Checkbox
                      checked={selected.has(job.id)}
                      onCheckedChange={() => toggleJob(job.id)}
                      disabled={running}
                      aria-label={`Select job ${job.id.slice(0, 8)}`}
                    />
                  </div>
                )}
                <button
                  onClick={() => onSelectJob(job.id)}
                  className={cn('min-w-0 flex-1 px-4 py-3 text-left', !compact && 'pl-2.5')}
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
              </div>
            );
          })}
        </div>
      )}

      <Modal
        open={confirming}
        onOpenChange={setConfirming}
        dismissible
        icon={<Trash2 />}
        iconTone="danger"
        title={`Delete ${selected.size} job${selected.size === 1 ? '' : 's'}?`}
        description="This permanently removes the job record and its logged output. Backup files on disk are not affected."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" icon={<Trash2 />} loading={deleting} onClick={handleDelete}>
              Delete
            </Button>
          </>
        }
      />
    </section>
  );
}
