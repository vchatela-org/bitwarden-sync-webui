import React, { useState, useEffect } from 'react';
import { BackupInventory, BackupSet } from '../types.js';
import { getBackups, verifyBackups, pruneBackups } from '../api.js';
import { AppConfig } from '../types.js';

interface Props {
  config: AppConfig;
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}

function formatTs(ts: string): string {
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(9, 11)}:${ts.slice(11, 13)}`;
}

export function BackupsPage({ config }: Props) {
  const [inventory, setInventory] = useState<BackupInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [keepDaily, setKeepDaily] = useState(config.retention.keepDaily);
  const [keepMonthly, setKeepMonthly] = useState(config.retention.keepMonthly);
  const [pruneResult, setPruneResult] = useState<unknown>(null);
  const [verifyResult, setVerifyResult] = useState<Array<{ path: string; ok: boolean; reason?: string }> | null>(null);
  const [dryRun, setDryRun] = useState(true);

  useEffect(() => {
    loadInventory();
  }, []);

  async function loadInventory() {
    setLoading(true);
    try {
      const inv = await getBackups();
      setInventory(inv);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify() {
    try {
      const r = await verifyBackups();
      setVerifyResult(r.results);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Verify failed');
    }
  }

  async function handlePrune() {
    try {
      const r = await pruneBackups({ keepDaily, keepMonthly, dryRun });
      setPruneResult(r);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Prune failed');
    }
  }

  if (loading) return <div style={styles.loading}>Loading backups…</div>;

  const managed = inventory?.managed ?? [];
  const unmanaged = inventory?.unmanaged ?? [];

  // Group by target
  const byTarget = new Map<string, BackupSet[]>();
  for (const s of managed) {
    if (!byTarget.has(s.targetKey)) byTarget.set(s.targetKey, []);
    byTarget.get(s.targetKey)!.push(s);
  }

  const totalBytes = managed.reduce((acc, s) => acc + s.sizeBytes, 0);

  return (
    <div style={styles.container}>
      <h2 style={styles.title}>Backups</h2>
      {error && <div style={styles.error}>{error}</div>}

      <div style={styles.summary}>
        <div style={styles.summaryBox}>
          <div style={styles.summaryNum}>{managed.length}</div>
          <div style={styles.summaryLabel}>managed sets</div>
        </div>
        <div style={styles.summaryBox}>
          <div style={styles.summaryNum}>{formatBytes(totalBytes)}</div>
          <div style={styles.summaryLabel}>total size</div>
        </div>
        <div style={styles.summaryBox}>
          <div style={styles.summaryNum}>{unmanaged.length}</div>
          <div style={styles.summaryLabel}>unmanaged files</div>
        </div>
      </div>

      <div style={styles.actions}>
        <button style={styles.btn} onClick={handleVerify}>🔍 Verify integrity</button>
        <button style={styles.btn} onClick={loadInventory}>↻ Refresh</button>
      </div>

      {verifyResult && (
        <div style={styles.verifyResult}>
          <strong style={{ color: '#94a3b8' }}>Integrity results:</strong>
          {verifyResult.map((r, i) => (
            <div key={i} style={{ color: r.ok ? '#4ade80' : '#f87171', fontSize: 12, marginTop: 4 }}>
              {r.ok ? '✓' : '✗'} {r.path.split('/').pop()} {r.reason ? `— ${r.reason}` : ''}
            </div>
          ))}
        </div>
      )}

      {[...byTarget.entries()].map(([target, sets]) => {
        const sorted = [...sets].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        const newest = sorted[0]!;
        return (
          <div key={target} style={styles.targetSection}>
            <div style={styles.targetHeader}>
              <strong style={styles.targetKey}>{target}</strong>
              <span style={styles.targetMeta}>{sets.length} sets — {formatBytes(sets.reduce((a, s) => a + s.sizeBytes, 0))}</span>
            </div>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Timestamp</th>
                  <th style={styles.th}>Items</th>
                  <th style={styles.th}>Size</th>
                  <th style={styles.th}>Files</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((s) => (
                  <tr key={s.timestamp} style={styles.tr}>
                    <td style={styles.td}>
                      <span style={{ color: s === newest ? '#60a5fa' : '#94a3b8' }}>{formatTs(s.timestamp)}</span>
                      {s === newest && <span style={styles.newestBadge}>newest</span>}
                    </td>
                    <td style={styles.td}>{s.meta?.itemCount ?? '?'}</td>
                    <td style={styles.td}>{formatBytes(s.sizeBytes)}</td>
                    <td style={styles.td}>{s.files.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}

      {unmanaged.length > 0 && (
        <div style={styles.unmanagedSection}>
          <h3 style={styles.unmanagedTitle}>⚠️ Unmanaged files ({unmanaged.length}) — not touched by pruning</h3>
          <div style={styles.unmanagedList}>
            {unmanaged.map((f, i) => (
              <div key={i} style={styles.unmanagedFile}>{f.split('/').pop()}</div>
            ))}
          </div>
        </div>
      )}

      <div style={styles.pruneSection}>
        <h3 style={styles.pruneTitle}>Retention & Pruning</h3>
        <div style={styles.pruneSettings}>
          <label style={styles.label}>Keep daily sets</label>
          <input type="number" min={1} value={keepDaily} onChange={(e) => setKeepDaily(parseInt(e.target.value))} style={styles.numInput} />
          <label style={styles.label}>Keep monthly sets</label>
          <input type="number" min={1} value={keepMonthly} onChange={(e) => setKeepMonthly(parseInt(e.target.value))} style={styles.numInput} />
          <label style={styles.checkLabel}>
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
            Dry run (preview only)
          </label>
        </div>
        <button style={{ ...styles.btn, ...styles.btnDanger }} onClick={handlePrune}>
          {dryRun ? '🔍 Preview prune' : '🗑 Execute prune'}
        </button>

        {pruneResult && (
          <div style={styles.pruneResult}>
            <pre style={styles.pruneJson}>{JSON.stringify(pruneResult, null, 2)}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: 24 },
  title: { color: '#e2e8f0', fontSize: 18, margin: '0 0 16px' },
  loading: { padding: 40, color: '#64748b', textAlign: 'center' },
  error: { color: '#f87171', padding: '8px 12px', background: '#2d1515', borderRadius: 6, marginBottom: 12, fontSize: 13 },
  summary: { display: 'flex', gap: 16, marginBottom: 20 },
  summaryBox: { background: '#1a1d27', border: '1px solid #2d3148', borderRadius: 8, padding: '12px 20px', textAlign: 'center', flex: 1 },
  summaryNum: { fontSize: 24, fontWeight: 700, color: '#e2e8f0' },
  summaryLabel: { color: '#64748b', fontSize: 12, marginTop: 4 },
  actions: { display: 'flex', gap: 8, marginBottom: 16 },
  btn: { padding: '7px 14px', background: '#1e2235', border: '1px solid #2d3148', borderRadius: 6, color: '#cbd5e1', cursor: 'pointer', fontSize: 13 },
  btnDanger: { background: '#7f1d1d', color: '#fca5a5', borderColor: '#991b1b' },
  verifyResult: { background: '#12151e', border: '1px solid #2d3148', borderRadius: 8, padding: 12, marginBottom: 16 },
  targetSection: { marginBottom: 20, background: '#1a1d27', border: '1px solid #2d3148', borderRadius: 8, overflow: 'hidden' },
  targetHeader: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', background: '#12151e', borderBottom: '1px solid #2d3148' },
  targetKey: { color: '#e2e8f0', fontSize: 14 },
  targetMeta: { color: '#64748b', fontSize: 12 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { padding: '8px 16px', textAlign: 'left', color: '#64748b', fontWeight: 600, borderBottom: '1px solid #1e2235' },
  tr: { borderBottom: '1px solid #1e2235' },
  td: { padding: '8px 16px', color: '#94a3b8', verticalAlign: 'top' },
  newestBadge: { marginLeft: 8, background: '#1e3a5f', color: '#60a5fa', padding: '1px 6px', borderRadius: 8, fontSize: 10 },
  unmanagedSection: { background: '#1a1410', border: '1px solid #3d2a1a', borderRadius: 8, padding: 16, marginBottom: 20 },
  unmanagedTitle: { color: '#f59e0b', fontSize: 14, margin: '0 0 8px' },
  unmanagedList: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  unmanagedFile: { color: '#92400e', fontSize: 11, background: '#1c1309', padding: '2px 8px', borderRadius: 4 },
  pruneSection: { background: '#1a1d27', border: '1px solid #2d3148', borderRadius: 8, padding: 16 },
  pruneTitle: { color: '#e2e8f0', fontSize: 14, margin: '0 0 12px' },
  pruneSettings: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' },
  label: { color: '#94a3b8', fontSize: 13 },
  checkLabel: { color: '#94a3b8', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' },
  numInput: { width: 60, padding: '4px 8px', background: '#0f1117', border: '1px solid #2d3148', borderRadius: 6, color: '#e2e8f0', fontSize: 13 },
  pruneResult: { marginTop: 12 },
  pruneJson: { background: '#12151e', border: '1px solid #1e2235', borderRadius: 6, padding: 12, color: '#94a3b8', fontSize: 11, overflow: 'auto', maxHeight: 300 },
};
