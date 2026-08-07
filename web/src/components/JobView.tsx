import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, Ban, AlertCircle, X, Minus, Plus, GitCompareArrows, ShieldCheck, ShieldAlert } from 'lucide-react';
import { Job, Prompt, CredentialPrompt, ConfirmationPrompt, Step, LogLine, DiffItem, SecureDiffResult } from '../types.js';
import { getJob, cancelJob, openJobStream } from '../api.js';
import { StepGraph } from './StepGraph.js';
import { Terminal } from './Terminal.js';
import { CredentialModal } from './CredentialModal.js';
import { ConfirmModal } from './ConfirmModal.js';
import { Button } from './ui/Button.js';
import { Card } from './ui/Card.js';
import { Badge, StatusLabel } from './ui/Badge.js';
import { Alert } from './ui/Input.js';
import { LoadingPane, Tooltip } from './ui/Feedback.js';
import { MaskToggle } from './ui/MaskToggle.js';
import { JOB_TONE, JOB_LABEL, isActive, formatDuration } from '../lib/status.js';
import { maskValue } from '../lib/mask.js';

interface Props {
  jobId: string;
  onBack: () => void;
  /** When true, redact emails and vault item details — for taking screenshots. */
  masked?: boolean;
  onToggleMask?: () => void;
}

export function JobView({ jobId, onBack, masked, onToggleMask }: Props) {
  const [job, setJob] = useState<Job | null>(null);
  const [selectedStep, setSelectedStep] = useState<string | undefined>();
  const [error, setError] = useState('');
  const [terminalHeight, setTerminalHeight] = useState(340);

  const loadJob = useCallback(async () => {
    try {
      const j = await getJob(jobId);
      setJob(j);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load job');
    }
  }, [jobId]);

  useEffect(() => {
    loadJob();
  }, [loadJob]);

  useEffect(() => {
    let cancelled = false;
    const ws = openJobStream(jobId);

    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data as string) as { type: string; data?: unknown; job?: Job };
      if (msg.type === 'snapshot' && msg.job) {
        setJob(msg.job);
      } else if (msg.type === 'log' && msg.data) {
        setJob((prev) => prev ? { ...prev, logs: [...prev.logs, msg.data as LogLine] } : prev);
      } else if (msg.type === 'step' && msg.data) {
        const step = msg.data as Step;
        setJob((prev) => {
          if (!prev) return prev;
          return { ...prev, steps: prev.steps.map((s) => s.id === step.id ? step : s) };
        });
      } else if (msg.type === 'job' && msg.data) {
        const jUpdate = msg.data as { state?: string; secureDiffResults?: Job['secureDiffResults'] };
        setJob((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            ...(jUpdate.state !== undefined ? { state: jUpdate.state as Job['state'] } : {}),
            ...(jUpdate.secureDiffResults !== undefined ? { secureDiffResults: jUpdate.secureDiffResults } : {}),
          };
        });
      } else if (msg.type === 'prompt') {
        const prompt = msg.data as Prompt | null;
        setJob((prev) => prev ? { ...prev, prompt: prompt ?? undefined } : prev);
      }
    };

    // In dev, React StrictMode mounts this effect twice: the first WebSocket is
    // closed by cleanup before it finishes connecting, which fires onerror on a
    // connection we already discarded. Ignore errors once cleanup has run.
    ws.onerror = () => { if (!cancelled) setError('Lost the live connection to this job. Reload to reconnect.'); };

    return () => {
      cancelled = true;
      ws.close();
    };
  }, [jobId]);

  async function handleCancel() {
    try {
      await cancelJob(jobId);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to cancel job');
    }
  }

  if (!job) return <LoadingPane label="Loading job…" />;

  const prompt = job.prompt;
  const running = isActive(job.state);
  const duration = formatDuration(job.startedAt, job.endedAt);
  const selectedLabel = job.steps.find((s) => s.id === selectedStep)?.label;

  return (
    <section className="space-y-5">
      {/* ── Job header ──────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" icon={<ArrowLeft />} onClick={onBack}>
          All jobs
        </Button>

        <div className="h-4 w-px bg-line-strong" />

        <StatusLabel tone={JOB_TONE[job.state]} pulse={running} className="text-[13px]">
          {JOB_LABEL[job.state]}
        </StatusLabel>

        <Tooltip content={job.id}>
          <span className="font-mono text-[11px] text-fg-faint">{job.id.slice(0, 8)}</span>
        </Tooltip>

        <div className="flex flex-wrap items-center gap-1.5">
          {job.operations.map((op) => (
            <Badge key={op} tone="accent">{op}</Badge>
          ))}
          {job.targets.map((t) => (
            <Badge key={t}>{masked ? maskValue(t) : t}</Badge>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-3">
          {onToggleMask && <MaskToggle masked={!!masked} onToggle={onToggleMask} />}
          {duration && <span className="text-xs tabular-nums text-fg-subtle">{duration}</span>}
          {running && (
            <Button variant="dangerSoft" size="sm" icon={<Ban />} onClick={handleCancel}>
              Cancel
            </Button>
          )}
        </div>
      </div>

      {error && <Alert icon={<AlertCircle />}>{error}</Alert>}

      {/* ── Steps ───────────────────────────────────────────────────────── */}
      {job.steps.length > 0 && (
        <Card className="p-4">
          <StepGraph steps={job.steps} onSelectStep={setSelectedStep} selectedStep={selectedStep} />
        </Card>
      )}

      {/* ── Log ─────────────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[13px] font-semibold text-fg">Output</h3>

          {selectedStep && (
            <button
              onClick={() => setSelectedStep(undefined)}
              className="inline-flex items-center gap-1 rounded-full border border-accent-line bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent transition-colors hover:bg-accent/20"
            >
              {selectedLabel ?? selectedStep}
              <X className="size-3" />
            </button>
          )}

          <div className="ml-auto flex items-center gap-1">
            <Tooltip content="Shrink log panel">
              <Button
                size="icon"
                variant="ghost"
                aria-label="Shrink log panel"
                onClick={() => setTerminalHeight((h) => Math.max(160, h - 100))}
              >
                <Minus className="size-3.5" />
              </Button>
            </Tooltip>
            <Tooltip content="Grow log panel">
              <Button
                size="icon"
                variant="ghost"
                aria-label="Grow log panel"
                onClick={() => setTerminalHeight((h) => Math.min(900, h + 100))}
              >
                <Plus className="size-3.5" />
              </Button>
            </Tooltip>
          </div>
        </div>

        <Terminal logs={job.logs} filterStep={selectedStep} height={terminalHeight} masked={masked} />
      </div>

      {prompt?.kind === 'credentials' && (
        <CredentialModal
          jobId={jobId}
          prompt={prompt as CredentialPrompt}
          onSubmitted={() => setJob((prev) => prev ? { ...prev, prompt: undefined } : prev)}
          masked={masked}
        />
      )}
      {prompt?.kind === 'confirmation' && (
        <ConfirmModal
          jobId={jobId}
          prompt={prompt as ConfirmationPrompt}
          onSubmitted={() => setJob((prev) => prev ? { ...prev, prompt: undefined } : prev)}
          masked={masked}
        />
      )}

      {/* ── Secure diff results ──────────────────────────────────────────── */}
      {job.secureDiffResults && Object.keys(job.secureDiffResults).length > 0 && (
        <SecureDiffPanel results={job.secureDiffResults} masked={!!masked} />
      )}
    </section>
  );
}

const ITEM_TYPE: Record<number, string> = { 1: 'Login', 2: 'Note', 3: 'Card', 4: 'Identity' };

function DiffSection({ title, items, tone, masked }: {
  title: string;
  items: DiffItem[];
  tone: 'source' | 'dest' | 'mismatch';
  masked: boolean;
}) {
  const colors = {
    source: 'text-blue-400',
    dest: 'text-orange-400',
    mismatch: 'text-yellow-400',
  };
  return (
    <div>
      <p className={`mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] ${colors[tone]}`}>
        {title} ({items.length})
      </p>
      <ul className="space-y-0.5">
        {items.map((item, i) => (
          <li key={i} className="flex items-center gap-2 rounded px-2 py-0.5 text-[12px] text-fg-muted hover:bg-surface-2">
            <span className="font-mono text-[10px] text-fg-faint w-10 shrink-0">{ITEM_TYPE[item.type] ?? `#${item.type}`}</span>
            <span className="truncate">{masked ? '••••••' : item.name}</span>
            {item.username && (
              <span className="truncate text-fg-subtle text-[11px]">{masked ? '••' : item.username}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SecureDiffPanel({ results, masked }: { results: Record<string, SecureDiffResult>; masked: boolean }) {
  const targets = Object.keys(results);
  const allIdentical = targets.every((t) => {
    const r = results[t]!;
    return r.onlyInSource.length === 0 && r.onlyInDest.length === 0 && r.credentialsDiffer.length === 0;
  });

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line bg-surface-2/60 px-4 py-3">
        <GitCompareArrows className="size-4 text-fg-subtle" />
        <h3 className="text-[13px] font-semibold text-fg">Credential Diff</h3>
        {allIdentical ? (
          <span className="ml-auto flex items-center gap-1 text-[11px] text-green-400">
            <ShieldCheck className="size-3.5" /> All vaults identical
          </span>
        ) : (
          <span className="ml-auto flex items-center gap-1 text-[11px] text-yellow-400">
            <ShieldAlert className="size-3.5" /> Differences found
          </span>
        )}
      </div>
      <div className="divide-y divide-line">
        {targets.map((target) => {
          const r = results[target]!;
          const hasDiffs = r.onlyInSource.length + r.onlyInDest.length + r.credentialsDiffer.length > 0;
          return (
            <div key={target} className="px-4 py-3 space-y-3">
              <div className="flex items-center gap-3">
                <span className="font-medium text-[13px] text-fg">{target}</span>
                <span className="text-[11px] text-fg-subtle">{r.sourceCount} source · {r.destCount} dest · {r.identical} identical</span>
                {!hasDiffs && <span className="ml-auto text-[11px] text-green-400">✓ identical</span>}
              </div>
              {r.onlyInSource.length > 0 && (
                <DiffSection title="Only in source" items={r.onlyInSource} tone="source" masked={masked} />
              )}
              {r.onlyInDest.length > 0 && (
                <DiffSection title="Only in destination" items={r.onlyInDest} tone="dest" masked={masked} />
              )}
              {r.credentialsDiffer.length > 0 && (
                <DiffSection title="Credentials differ" items={r.credentialsDiffer} tone="mismatch" masked={masked} />
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
