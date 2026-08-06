import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, Ban, AlertCircle, X, Minus, Plus } from 'lucide-react';
import { Job, Prompt, CredentialPrompt, ConfirmationPrompt, Step, LogLine } from '../types.js';
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
        const jUpdate = msg.data as { state: string };
        setJob((prev) => prev ? { ...prev, state: jUpdate.state as Job['state'] } : prev);
      } else if (msg.type === 'prompt') {
        const prompt = msg.data as Prompt | null;
        setJob((prev) => prev ? { ...prev, prompt: prompt ?? undefined } : prev);
      }
    };

    ws.onerror = () => setError('Lost the live connection to this job. Reload to reconnect.');

    return () => ws.close();
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
    </section>
  );
}
