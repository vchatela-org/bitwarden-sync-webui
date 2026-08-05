import React, { useState, useEffect } from 'react';
import { Login } from './components/Login.js';
import { Header } from './components/Header.js';
import { Dashboard } from './components/Dashboard.js';
import { JobView } from './components/JobView.js';
import { JobList } from './components/JobList.js';
import { BackupsPage } from './components/BackupsPage.js';
import { getMe, getConfig, logout } from './api.js';
import { AppConfig } from './types.js';

type Page = 'dashboard' | 'jobs' | 'backups';

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [page, setPage] = useState<Page>('dashboard');
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    try {
      const me = await getMe();
      setAuthed(me.authenticated);
      if (me.authenticated) {
        loadConfig();
      }
    } catch {
      setAuthed(false);
    }
  }

  async function loadConfig() {
    try {
      const cfg = await getConfig();
      setConfig(cfg);
    } catch {
      setConfig(null);
    }
  }

  async function handleLogin() {
    setAuthed(true);
    await loadConfig();
  }

  async function handleLogout() {
    try { await logout(); } catch { /* ignore */ }
    setAuthed(false);
    setConfig(null);
  }

  function handleJobCreated(jobId: string) {
    setActiveJobId(jobId);
    setPage('jobs');
  }

  if (authed === null) {
    return (
      <div style={{ minHeight: '100vh', background: '#0f1117', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: '#64748b' }}>Loading…</div>
      </div>
    );
  }

  if (!authed) {
    return <Login onLogin={handleLogin} />;
  }

  return (
    <div style={{ minHeight: '100vh', background: '#0f1117', color: '#e2e8f0' }}>
      <Header
        config={config}
        onLogout={handleLogout}
        currentPage={page}
        onNavigate={setPage}
      />
      <main>
        {page === 'dashboard' && config && (
          <Dashboard config={config} onJobCreated={handleJobCreated} />
        )}
        {page === 'dashboard' && !config && (
          <div style={{ padding: 40, color: '#f87171', textAlign: 'center' }}>
            ⚠️ Config not loaded or invalid. Check /api/health for details.
          </div>
        )}
        {page === 'jobs' && (
          <>
            {activeJobId ? (
              <div>
                <JobView jobId={activeJobId} onBack={() => setActiveJobId(null)} />
                <div style={{ padding: '0 24px' }}>
                  <JobList onSelectJob={setActiveJobId} activeJobId={activeJobId} />
                </div>
              </div>
            ) : (
              <JobList onSelectJob={(id) => { setActiveJobId(id); }} />
            )}
          </>
        )}
        {page === 'backups' && config && (
          <BackupsPage config={config} />
        )}
      </main>
    </div>
  );
}
