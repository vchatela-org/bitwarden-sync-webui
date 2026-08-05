import React from 'react';
import { AppConfig } from '../types.js';

interface Props {
  config: AppConfig | null;
  onLogout: () => void;
  currentPage: 'dashboard' | 'jobs' | 'backups';
  onNavigate: (page: 'dashboard' | 'jobs' | 'backups') => void;
}

export function Header({ config, onLogout, currentPage, onNavigate }: Props) {
  return (
    <header style={styles.header}>
      <div style={styles.left}>
        <span style={styles.logo}>🔐 Bitwarden Sync</span>
        {config && (
          <span style={styles.version}>
            bw {config.cliVersion}
          </span>
        )}
      </div>
      {config && (
        <div style={styles.servers}>
          <span style={styles.server}>
            ☁️ <span style={styles.url}>{config.cloudServerUrl.replace(/^https?:\/\//, '')}</span>
          </span>
          <span style={styles.serverSep}>↔</span>
          <span style={styles.server}>
            🏠 <span style={styles.url}>{config.homeServerUrl.replace(/^https?:\/\//, '')}</span>
          </span>
        </div>
      )}
      <nav style={styles.nav}>
        <button style={{ ...styles.navBtn, ...(currentPage === 'dashboard' ? styles.navActive : {}) }} onClick={() => onNavigate('dashboard')}>Dashboard</button>
        <button style={{ ...styles.navBtn, ...(currentPage === 'jobs' ? styles.navActive : {}) }} onClick={() => onNavigate('jobs')}>Jobs</button>
        <button style={{ ...styles.navBtn, ...(currentPage === 'backups' ? styles.navActive : {}) }} onClick={() => onNavigate('backups')}>Backups</button>
        <button style={styles.logoutBtn} onClick={onLogout}>Logout</button>
      </nav>
    </header>
  );
}

const styles: Record<string, React.CSSProperties> = {
  header: {
    display: 'flex',
    alignItems: 'center',
    padding: '0 24px',
    height: 56,
    background: '#1a1d27',
    borderBottom: '1px solid #2d3148',
    gap: 16,
    position: 'sticky',
    top: 0,
    zIndex: 100,
  },
  left: { display: 'flex', alignItems: 'center', gap: 12, minWidth: 180 },
  logo: { color: '#e2e8f0', fontWeight: 700, fontSize: 16 },
  version: { color: '#64748b', fontSize: 12, background: '#0f1117', padding: '2px 8px', borderRadius: 4 },
  servers: { display: 'flex', alignItems: 'center', gap: 8, flex: 1, justifyContent: 'center' },
  server: { color: '#94a3b8', fontSize: 12 },
  url: { color: '#60a5fa', fontFamily: 'monospace' },
  serverSep: { color: '#475569', fontSize: 12 },
  nav: { display: 'flex', gap: 4, alignItems: 'center' },
  navBtn: {
    padding: '6px 12px',
    background: 'transparent',
    border: 'none',
    color: '#94a3b8',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
  },
  navActive: { background: '#2d3148', color: '#e2e8f0' },
  logoutBtn: {
    padding: '6px 12px',
    background: 'transparent',
    border: '1px solid #3d4166',
    color: '#94a3b8',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
  },
};
