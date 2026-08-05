import React, { useState } from 'react';
import { ConfirmationPrompt } from '../types.js';
import { submitConfirmation } from '../api.js';

interface Props {
  jobId: string;
  prompt: ConfirmationPrompt;
  onSubmitted: () => void;
}

export function ConfirmModal({ jobId, prompt, onSubmitted }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { diff } = prompt;

  async function decide(decision: 'proceed' | 'skip' | 'abort') {
    setError('');
    setLoading(true);
    try {
      await submitConfirmation(jobId, prompt.target, decision);
      onSubmitted();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setLoading(false);
    }
  }

  const srcCount = diff.sourceCount === 'unknown' ? '?' : diff.sourceCount;
  const ratio = diff.sourceCount !== 'unknown' && diff.destCount > 0
    ? Math.round((diff.sourceCount / diff.destCount) * 100)
    : null;

  return (
    <div style={styles.overlay}>
      <div style={styles.modal}>
        <h2 style={styles.title}>⚠️ Import Guard Tripped</h2>
        <p style={styles.subtitle}>
          Target: <strong style={{ color: '#60a5fa' }}>{prompt.target}</strong>
        </p>
        <div style={styles.reason}>{diff.guardReason}</div>

        <div style={styles.counts}>
          <div style={styles.countBox}>
            <div style={styles.countNum}>{srcCount}</div>
            <div style={styles.countLabel}>Source items</div>
          </div>
          <div style={styles.arrow}>→</div>
          <div style={styles.countBox}>
            <div style={styles.countNum}>{diff.destCount}</div>
            <div style={styles.countLabel}>Destination items</div>
          </div>
          {ratio !== null && (
            <div style={styles.countBox}>
              <div style={{ ...styles.countNum, color: ratio < 50 ? '#f87171' : '#facc15' }}>{ratio}%</div>
              <div style={styles.countLabel}>Ratio</div>
            </div>
          )}
        </div>

        {diff.removed.length > 0 && (
          <div style={styles.diffSection}>
            <div style={styles.diffLabel}>🔴 Would be removed ({diff.removed.length} shown):</div>
            <div style={styles.diffList}>
              {diff.removed.slice(0, 10).map((item, i) => (
                <div key={i} style={styles.diffItem}>{item.name}{item.username ? ` (${item.username})` : ''}</div>
              ))}
              {diff.removed.length > 10 && <div style={styles.moreItems}>…and {diff.removed.length - 10} more</div>}
            </div>
          </div>
        )}

        {diff.added.length > 0 && (
          <div style={styles.diffSection}>
            <div style={styles.diffLabel}>🟢 Would be added ({diff.added.length} shown):</div>
            <div style={styles.diffList}>
              {diff.added.slice(0, 5).map((item, i) => (
                <div key={i} style={styles.diffItem}>{item.name}{item.username ? ` (${item.username})` : ''}</div>
              ))}
              {diff.added.length > 5 && <div style={styles.moreItems}>…and {diff.added.length - 5} more</div>}
            </div>
          </div>
        )}

        {error && <div style={styles.error}>{error}</div>}

        <div style={styles.warning}>
          ⚠️ Choosing <strong>Proceed</strong> will purge the home vault and re-import. This cannot be undone.
        </div>

        <div style={styles.buttons}>
          <button style={{ ...styles.btn, ...styles.btnDanger }} onClick={() => decide('proceed')} disabled={loading}>
            Proceed anyway
          </button>
          <button style={{ ...styles.btn, ...styles.btnSecondary }} onClick={() => decide('skip')} disabled={loading}>
            Skip target
          </button>
          <button style={{ ...styles.btn, ...styles.btnAbort }} onClick={() => decide('abort')} disabled={loading}>
            Abort job
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modal: { background: '#1a1d27', border: '1px solid #2d3148', borderRadius: 12, padding: '32px 40px', width: 520, maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 16px 48px rgba(0,0,0,0.6)' },
  title: { color: '#f59e0b', margin: 0, fontSize: 20 },
  subtitle: { color: '#94a3b8', fontSize: 13, margin: '10px 0 4px' },
  reason: { color: '#f87171', fontSize: 13, background: '#2d1515', padding: '8px 12px', borderRadius: 6, marginBottom: 16 },
  counts: { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16 },
  countBox: { textAlign: 'center', background: '#12151e', padding: '12px 16px', borderRadius: 8, flex: 1 },
  countNum: { fontSize: 28, fontWeight: 700, color: '#e2e8f0' },
  countLabel: { color: '#64748b', fontSize: 11, marginTop: 4 },
  arrow: { color: '#475569', fontSize: 20 },
  diffSection: { marginBottom: 12 },
  diffLabel: { color: '#94a3b8', fontSize: 12, marginBottom: 4 },
  diffList: { background: '#12151e', borderRadius: 6, padding: '8px 12px' },
  diffItem: { color: '#cbd5e1', fontSize: 12, padding: '2px 0' },
  moreItems: { color: '#475569', fontSize: 11, marginTop: 4 },
  warning: { color: '#f59e0b', fontSize: 12, background: '#2d1f00', padding: '8px 12px', borderRadius: 6, margin: '16px 0' },
  error: { color: '#f87171', fontSize: 13, marginTop: 8 },
  buttons: { display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' },
  btn: { padding: '9px 16px', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 },
  btnDanger: { background: '#dc2626', color: '#fff' },
  btnSecondary: { background: '#1e2235', color: '#94a3b8', border: '1px solid #2d3148' },
  btnAbort: { background: '#7f1d1d', color: '#fca5a5' },
};
