import React, { useState, useEffect } from 'react';
import { Job } from '../types.js';
import { listJobs } from '../api.js';

interface Props {
  onSelectJob: (jobId: string) => void;
  activeJobId?: string;
}

const STATE_COLORS: Record<string, string> = {
  queued: '#64748b',
  running: '#3b82f6',
  'awaiting-credentials': '#8b5cf6',
  'awaiting-confirmation': '#f59e0b',
  succeeded: '#22c55e',
  failed: '#ef4444',
  partial: '#f59e0b',
  aborted: '#6b7280',
};

export function JobList({ onSelectJob, activeJobId }: Props) {
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
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }

  if (loading) return <div style={styles.loading}>Loading…</div>;

  return (
    <div style={styles.container}>
      <h2 style={styles.title}>Job History</h2>
      {jobs.length === 0 && <div style={styles.empty}>No jobs yet.</div>}
      <div style={styles.list}>
        {jobs.map((job) => (
          <div
            key={job.id}
            style={{ ...styles.card, ...(activeJobId === job.id ? styles.cardActive : {}) }}
            onClick={() => onSelectJob(job.id)}
          >
            <div style={styles.cardTop}>
              <span style={styles.jobId}>{job.id.slice(0, 8)}</span>
              <span style={{ color: STATE_COLORS[job.state] ?? '#94a3b8', fontSize: 12, fontWeight: 600 }}>
                {job.state}
              </span>
            </div>
            <div style={styles.cardMeta}>
              {job.operations.join(', ')} — {job.targets.join(', ')}
            </div>
            <div style={styles.cardTime}>
              {new Date(job.createdAt).toLocaleString()}
              {job.endedAt && ` → ${new Date(job.endedAt).toLocaleTimeString()}`}
            </div>
            <div style={styles.stepsRow}>
              {job.steps.map((s) => (
                <span
                  key={s.id}
                  title={s.label}
                  style={{
                    ...styles.stepDot,
                    background: STATE_COLORS[s.state] ?? '#475569',
                  }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: 24 },
  title: { color: '#e2e8f0', fontSize: 18, margin: '0 0 16px' },
  loading: { padding: 40, color: '#64748b', textAlign: 'center' },
  empty: { color: '#475569', padding: 20, textAlign: 'center' },
  list: { display: 'flex', flexDirection: 'column', gap: 8 },
  card: {
    background: '#1a1d27',
    border: '1px solid #2d3148',
    borderRadius: 8,
    padding: '12px 16px',
    cursor: 'pointer',
  },
  cardActive: { borderColor: '#4f46e5' },
  cardTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  jobId: { color: '#64748b', fontFamily: 'monospace', fontSize: 13 },
  cardMeta: { color: '#94a3b8', fontSize: 12, marginTop: 4 },
  cardTime: { color: '#475569', fontSize: 11, marginTop: 2 },
  stepsRow: { display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 8 },
  stepDot: { width: 8, height: 8, borderRadius: '50%', display: 'inline-block' },
};
