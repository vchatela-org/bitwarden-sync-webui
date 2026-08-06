import { useState, useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Login } from './components/Login.js';
import { Header, type Page } from './components/Header.js';
import { Dashboard } from './components/Dashboard.js';
import { JobView } from './components/JobView.js';
import { JobList } from './components/JobList.js';
import { BackupsPage } from './components/BackupsPage.js';
import { LoadingPane, TooltipProvider, EmptyState } from './components/ui/Feedback.js';
import { DashboardDataProvider } from './state/DashboardData.js';
import { getMe, getConfig, logout } from './api.js';
import { AppConfig } from './types.js';
import { loadMaskPreference, saveMaskPreference } from './lib/mask.js';

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [page, setPage] = useState<Page>('dashboard');
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [maskSensitive, setMaskSensitive] = useState(loadMaskPreference);

  useEffect(() => {
    saveMaskPreference(maskSensitive);
  }, [maskSensitive]);

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

  function handleJobsDeleted(ids: string[]) {
    setActiveJobId((prev) => (prev && ids.includes(prev) ? null : prev));
  }

  if (authed === null) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoadingPane />
      </div>
    );
  }

  if (!authed) {
    return <Login onLogin={handleLogin} />;
  }

  return (
    <TooltipProvider delayDuration={300} skipDelayDuration={200}>
      <DashboardDataProvider>
        <div className="min-h-screen">
          <Header
            config={config}
            onLogout={handleLogout}
            currentPage={page}
            onNavigate={setPage}
          />

          <main className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6">
            {page === 'dashboard' &&
              (config ? (
                <Dashboard config={config} onJobCreated={handleJobCreated} />
              ) : (
                <EmptyState
                  icon={<AlertTriangle className="text-warn" />}
                  title="Configuration not loaded"
                  description="targets.json is missing or invalid. Check /api/health for the validation error."
                />
              ))}

            {page === 'jobs' &&
              (activeJobId ? (
                <div className="space-y-8">
                  <JobView
                    jobId={activeJobId}
                    onBack={() => setActiveJobId(null)}
                    masked={maskSensitive}
                    onToggleMask={() => setMaskSensitive((m) => !m)}
                  />
                  <JobList
                    onSelectJob={setActiveJobId}
                    activeJobId={activeJobId}
                    onJobsDeleted={handleJobsDeleted}
                    masked={maskSensitive}
                    compact
                  />
                </div>
              ) : (
                <JobList
                  onSelectJob={setActiveJobId}
                  onJobsDeleted={handleJobsDeleted}
                  masked={maskSensitive}
                  onToggleMask={() => setMaskSensitive((m) => !m)}
                />
              ))}

            {page === 'backups' && config && <BackupsPage config={config} />}
          </main>
        </div>
      </DashboardDataProvider>
    </TooltipProvider>
  );
}
