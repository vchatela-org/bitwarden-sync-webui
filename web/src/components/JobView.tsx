import React, { useState, useEffect, useCallback } from 'react';
import { Job, Prompt, CredentialPrompt, ConfirmationPrompt, Step, LogLine } from '../types.js';
import { getJob, cancelJob, openJobStream } from '../api.js';
import { StepGraph } from './StepGraph.js';
import { Terminal } from './Terminal.js';
import { CredentialModal } from './CredentialModal.js';
import { ConfirmModal } from './ConfirmModal.js';

interface Props {
  jobId: string;
  onBack: () => void;
}

export function JobView({ jobId, onBack }: Props) {
  const [job, setJob] = useState<Job | null>(null);
  const [selectedStep, setSelectedStep] = useState<string | undefined>();
  const [error, setError] = useState('');
  const [terminalHeight, setTerminalHeight] = useState(320);

  const loadJob = useCallback(async () => {
    try {
      const j = await getJob(jobId);
      setJob(j);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed');
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
          return {
            ...prev,
            steps: prev.steps.map((s) => s.id === step.id ? step : s),
          };
        });
      } else if (msg.type === 'job' && msg.data) {
        const jUpdate = msg.data as { state: string };
        setJob((prev) => prev ? { ...prev, state: jUpdate.state as Job['state'] } : prev);
      } else if (msg.type === 'prompt' && msg.data) {
        const prompt = msg.data as Prompt;
        setJob((prev) => prev ? { ...prev, prompt } : prev);
      }
    };

    ws.onerror = () => setError('WebSocket error');

    return () => ws.close();
  }, [jobId]);

  async function handleCancel() {
    try {
      await cancelJob(jobId);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  }

  if (!job) return <div style={styles.loading}>Loading job…</div>;

  const prompt = job.prompt;
  const isActive = ['running', 'awaiting-credentials', 'awaiting-confirmation', 'queued'].includes(job.state);

  const stateColor = {
    queued: '#64748b',
    running: '#3b82f6',
    'awaiting-credentials': '#8b5cf6',
    'awaiting-confirmation': '#f59e0b',
    succeeded: '#22c55e',
    failed: '#ef4444',
    partial: '#f59e0b',
    aborted: '#6b7280',
  }[job.state] ?? '#94a3b8';

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <button style={styles.back} onClick={onBack}>← Jobs</button>
        <div>
          <span style={styles.jobId}>{job.id.slice(0, 8)}</span>
          <span style={{ color: stateColor, marginLeft: 12, fontWeight: 600 }}>{job.state}</span>
        </div>
        <div style={styles.meta}>
          {job.targets.join(', ')} — {job.operations.join(', ')}
        </div>
        {isActive && (
          <button style={styles.cancelBtn} onClick={handleCancel}>Cancel</button>
        )}
      </div>

      {error && <div style={styles.error}>{error}</div>}

      <div style={styles.stepsSection}>
        <h3 style={styles.sectionTitle}>Steps</h3>
        <StepGraph steps={job.steps} onSelectStep={setSelectedStep} selectedStep={selectedStep} />
      </div>

      <div style={styles.terminalSection}>
        <div style={styles.terminalHeader}>
          <span style={styles.sectionTitle}>Log</span>
          {selectedStep && (
            <span style={styles.stepFilter}>
              Filtered: {selectedStep}
              <button style={styles.clearFilter} onClick={() => setSelectedStep(undefined)}>✗</button>
            </span>
          )}
          <div style={styles.resizeHandle}>
            <button style={styles.toolBtn} onClick={() => setTerminalHeight((h) => Math.max(120, h - 80))}>−</button>
            <button style={styles.toolBtn} onClick={() => setTerminalHeight((h) => Math.min(800, h + 80))}>+</button>
          </div>
        </div>
        <Terminal logs={job.logs} filterStep={selectedStep} height={terminalHeight} />
      </div>

      {prompt?.kind === 'credentials' && (
        <CredentialModal
          jobId={jobId}
          prompt={prompt as CredentialPrompt}
          onSubmitted={() => setJob((prev) => prev ? { ...prev, prompt: undefined } : prev)}
        />
      )}
      {prompt?.kind === 'confirmation' && (
        <ConfirmModal
          jobId={jobId}
          prompt={prompt as ConfirmationPrompt}
          onSubmitted={() => setJob((prev) => prev ? { ...prev, prompt: undefined } : prev)}
        />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: 24 },
  loading: { padding: 40, color: '#64748b', textAlign: 'center' },
  header: { display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20, flexWrap: 'wrap' },
  back: { padding: '6px 12px', background: 'transparent', border: '1px solid #2d3148', borderRadius: 6, color: '#94a3b8', cursor: 'pointer', fontSize: 13 },
  jobId: { color: '#64748b', fontFamily: 'monospace', fontSize: 13 },
  meta: { color: '#94a3b8', fontSize: 13 },
  cancelBtn: { padding: '6px 14px', background: '#7f1d1d', border: 'none', borderRadius: 6, color: '#fca5a5', cursor: 'pointer', fontSize: 13 },
  error: { color: '#f87171', padding: '8px 12px', background: '#2d1515', borderRadius: 6, marginBottom: 12, fontSize: 13 },
  stepsSection: { marginBottom: 24 },
  sectionTitle: { color: '#94a3b8', fontSize: 14, fontWeight: 600, margin: '0 0 12px' },
  terminalSection: {},
  terminalHeader: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 },
  stepFilter: { color: '#60a5fa', fontSize: 12, background: '#1e2235', padding: '2px 8px', borderRadius: 10, display: 'flex', alignItems: 'center', gap: 6 },
  clearFilter: { background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', padding: 0, fontSize: 12 },
  resizeHandle: { marginLeft: 'auto', display: 'flex', gap: 4 },
  toolBtn: { padding: '3px 8px', background: 'transparent', border: '1px solid #2d3148', borderRadius: 4, color: '#64748b', cursor: 'pointer', fontSize: 11 },
};
