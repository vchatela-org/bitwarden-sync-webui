import React, { useState, useEffect } from 'react';
import { AppConfig, TargetStatus, BackupSet } from '../types.js';
import { getStatus, getBackups, createJob } from '../api.js';

interface Props {
  config: AppConfig;
  onJobCreated: (jobId: string) => void;
}

function formatAge(ts: string): { label: string; color: string } {
  // ts like 20260805_101500
  const y = ts.slice(0, 4);
  const m = ts.slice(4, 6);
  const d = ts.slice(6, 8);
  const h = ts.slice(9, 11);
  const min = ts.slice(11, 13);
  const dt = new Date(`${y}-${m}-${d}T${h}:${min}:00Z`);
  const diffMs = Date.now() - dt.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  if (diffDays < 2) return { label: `${Math.round(diffDays * 24)}h ago`, color: '#4ade80' };
  if (diffDays < 8) return { label: `${Math.floor(diffDays)}d ago`, color: '#facc15' };
  return { label: `${Math.floor(diffDays)}d ago`, color: '#f87171' };
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}

export function Dashboard({ config, onJobCreated }: Props) {
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<Record<string, TargetStatus>>({});
  const [backupSets, setBackupSets] = useState<BackupSet[]>([]);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [error, setError] = useState('');

  const allTargets = [
    ...config.users.map((u) => ({ key: u.key, kind: 'user' as const, displayName: u.displayName ?? u.key, owner: null })),
    ...config.orgs.map((o) => ({ key: o.key, kind: 'org' as const, displayName: o.name, owner: o.owner })),
  ];

  useEffect(() => {
    loadBackups();
  }, []);

  async function loadBackups() {
    try {
      const inv = await getBackups();
      setBackupSets(inv.managed);
    } catch { /* non-fatal */ }
  }

  async function handleRefreshStatus() {
    setLoadingStatus(true);
    setError('');
    try {
      const s = await getStatus();
      setStatus(s);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to refresh status');
    } finally {
      setLoadingStatus(false);
    }
  }

  function toggleTarget(key: string) {
    setSelectedTargets((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectAll() {
    setSelectedTargets(new Set(allTargets.map((t) => t.key)));
  }

  function selectNone() {
    setSelectedTargets(new Set());
  }

  async function startJob(ops: string[]) {
    const targets = selectedTargets.size > 0 ? [...selectedTargets] : allTargets.map((t) => t.key);
    try {
      const r = await createJob(targets, ops);
      onJobCreated(r.jobId);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to create job');
    }
  }

  function getNewestSet(targetKey: string): BackupSet | null {
    const sets = backupSets.filter((s) => s.targetKey === targetKey).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return sets[0] ?? null;
  }

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <div style={styles.selectionRow}>
          <button style={styles.btn} onClick={selectAll}>Select All</button>
          <button style={styles.btn} onClick={selectNone}>Clear</button>
          <span style={styles.selectionLabel}>
            {selectedTargets.size === 0 ? 'All targets' : `${selectedTargets.size} selected`}
          </span>
        </div>
        <div style={styles.actions}>
          <button style={{ ...styles.btn, ...styles.btnSecondary }} onClick={handleRefreshStatus} disabled={loadingStatus}>
            {loadingStatus ? '⏳ Refreshing…' : '↻ Refresh Status'}
          </button>
          <button style={styles.btn} onClick={() => startJob(['backup'])}>💾 Backup</button>
          <button style={styles.btn} onClick={() => startJob(['import'])}>📥 Import</button>
          <button style={{ ...styles.btn, ...styles.btnPrimary }} onClick={() => startJob(['both'])}>🔄 Backup + Import</button>
        </div>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      <div style={styles.tableWrapper}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>☑</th>
              <th style={styles.th}>Target</th>
              <th style={styles.th}>Kind</th>
              <th style={styles.th}>☁️ Cloud vault.bitwarden.eu</th>
              <th style={styles.th}>🏠 Home server</th>
              <th style={styles.th}>Last backup</th>
              <th style={styles.th}>Sets</th>
            </tr>
          </thead>
          <tbody>
            {allTargets.map((target) => {
              const st = status[target.key];
              const newestSet = getNewestSet(target.key);
              const countForTarget = backupSets.filter((s) => s.targetKey === target.key).length;
              const isOrg = target.kind === 'org';
              return (
                <tr key={target.key} style={{ ...styles.tr, ...(selectedTargets.has(target.key) ? styles.trSelected : {}) }}>
                  <td style={styles.td}>
                    <input
                      type="checkbox"
                      checked={selectedTargets.has(target.key)}
                      onChange={() => toggleTarget(target.key)}
                    />
                  </td>
                  <td style={styles.td}>
                    <div style={styles.targetName}>
                      {isOrg && <span style={styles.orgIndent}>└ </span>}
                      <strong style={styles.targetKey}>{target.key}</strong>
                      <span style={styles.displayName}>{target.displayName !== target.key ? ` — ${target.displayName}` : ''}</span>
                    </div>
                  </td>
                  <td style={styles.td}>
                    <span style={{ ...styles.badge, ...(isOrg ? styles.badgeOrg : styles.badgeUser) }}>
                      {isOrg ? 'org' : 'user'}
                    </span>
                  </td>
                  <td style={styles.td}>
                    <VaultCell status={st?.cloud} />
                  </td>
                  <td style={styles.td}>
                    <VaultCell status={st?.home} />
                  </td>
                  <td style={styles.td}>
                    {newestSet ? (
                      <div>
                        <span style={{ color: formatAge(newestSet.timestamp).color }}>
                          {formatAge(newestSet.timestamp).label}
                        </span>
                        {newestSet.meta?.itemCount !== undefined && (
                          <span style={styles.metaInfo}> {newestSet.meta.itemCount} items</span>
                        )}
                        <div style={styles.metaInfo}>{formatBytes(newestSet.sizeBytes)}</div>
                      </div>
                    ) : (
                      <span style={styles.unknown}>no backup</span>
                    )}
                  </td>
                  <td style={styles.td}>
                    <span style={styles.setCount}>{countForTarget}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function VaultCell({ status }: { status: { status: string; serverUrl?: string; lastSync?: string } | null | undefined }) {
  if (!status) {
    return <span style={{ color: '#475569', fontSize: 12 }}>—</span>;
  }
  const color =
    status.status === 'unlocked' ? '#4ade80' :
    status.status === 'locked' ? '#facc15' :
    status.status === 'unauthenticated' ? '#f87171' : '#94a3b8';
  return (
    <div>
      <span style={{ color, fontSize: 12, fontWeight: 600 }}>{status.status}</span>
      {status.lastSync && (
        <div style={{ color: '#64748b', fontSize: 11 }}>
          synced {new Date(status.lastSync).toLocaleDateString()}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: 24 },
  toolbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 12 },
  selectionRow: { display: 'flex', gap: 8, alignItems: 'center' },
  selectionLabel: { color: '#94a3b8', fontSize: 13 },
  actions: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  btn: {
    padding: '7px 14px',
    background: '#1e2235',
    border: '1px solid #2d3148',
    borderRadius: 6,
    color: '#cbd5e1',
    cursor: 'pointer',
    fontSize: 13,
  },
  btnSecondary: { background: '#1a1d27' },
  btnPrimary: { background: '#4f46e5', borderColor: '#4f46e5', color: '#fff', fontWeight: 600 },
  error: { color: '#f87171', margin: '8px 0', padding: '8px 12px', background: '#2d1515', borderRadius: 6, fontSize: 13 },
  tableWrapper: { overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: {
    padding: '8px 12px',
    textAlign: 'left',
    color: '#64748b',
    borderBottom: '1px solid #2d3148',
    fontWeight: 600,
    whiteSpace: 'nowrap',
  },
  tr: { borderBottom: '1px solid #1e2235' },
  trSelected: { background: '#1e2235' },
  td: { padding: '10px 12px', verticalAlign: 'top' },
  targetName: { display: 'flex', alignItems: 'center', gap: 4 },
  orgIndent: { color: '#475569' },
  targetKey: { color: '#e2e8f0' },
  displayName: { color: '#64748b' },
  badge: { padding: '1px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600 },
  badgeUser: { background: '#1e3a5f', color: '#60a5fa' },
  badgeOrg: { background: '#2d1b4e', color: '#a78bfa' },
  metaInfo: { color: '#64748b', fontSize: 11 },
  unknown: { color: '#475569', fontSize: 12 },
  setCount: { color: '#94a3b8', fontWeight: 600 },
};
