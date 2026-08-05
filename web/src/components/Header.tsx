import { ShieldCheck, Cloud, HardDrive, ArrowLeftRight, LogOut } from 'lucide-react';
import { AppConfig } from '../types.js';
import { cn } from '../lib/cn.js';
import { Tooltip } from './ui/Feedback.js';

export type Page = 'dashboard' | 'jobs' | 'backups';

const PAGES: { id: Page; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'jobs', label: 'Jobs' },
  { id: 'backups', label: 'Backups' },
];

interface Props {
  config: AppConfig | null;
  onLogout: () => void;
  currentPage: Page;
  onNavigate: (page: Page) => void;
}

function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export function Header({ config, onLogout, currentPage, onNavigate }: Props) {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/80 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-4 px-4 sm:px-6">
        {/* Brand */}
        <div className="flex shrink-0 items-center gap-2.5">
          <div className="flex size-7 items-center justify-center rounded-lg border border-accent-line bg-accent-soft">
            <ShieldCheck className="size-4 text-accent" />
          </div>
          <span className="text-[13px] font-semibold tracking-tight text-fg">Bitwarden Sync</span>
          {config && (
            <Tooltip content="Pinned Bitwarden CLI version">
              <span className="hidden rounded-md border border-line bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-fg-subtle sm:inline">
                bw {config.cliVersion}
              </span>
            </Tooltip>
          )}
        </div>

        {/* Server pair */}
        {config && (
          <div className="mx-auto hidden items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-1.5 lg:flex">
            <Tooltip content={`Cloud source — ${config.cloudServerUrl}`}>
              <span className="flex items-center gap-1.5 text-[11px] text-fg-muted">
                <Cloud className="size-3.5 text-info" />
                <span className="font-mono">{hostOf(config.cloudServerUrl)}</span>
              </span>
            </Tooltip>
            <ArrowLeftRight className="size-3 text-fg-faint" />
            <Tooltip content={`Home destination — ${config.homeServerUrl}`}>
              <span className="flex items-center gap-1.5 text-[11px] text-fg-muted">
                <HardDrive className="size-3.5 text-violet" />
                <span className="font-mono">{hostOf(config.homeServerUrl)}</span>
              </span>
            </Tooltip>
          </div>
        )}

        {/* Nav + account */}
        <nav className="ml-auto flex items-center gap-1">
          <div className="flex items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5">
            {PAGES.map((p) => (
              <button
                key={p.id}
                onClick={() => onNavigate(p.id)}
                aria-current={currentPage === p.id ? 'page' : undefined}
                className={cn(
                  'rounded-[6px] px-3 py-1.5 text-[13px] font-medium transition-colors duration-150',
                  currentPage === p.id
                    ? 'bg-elevated text-fg shadow-card'
                    : 'text-fg-subtle hover:text-fg-muted',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>

          <Tooltip content="Sign out">
            <button
              onClick={onLogout}
              aria-label="Sign out"
              className="ml-1 flex size-8 items-center justify-center rounded-lg text-fg-subtle transition-colors duration-150 hover:bg-elevated hover:text-danger"
            >
              <LogOut className="size-4" />
            </button>
          </Tooltip>
        </nav>
      </div>
    </header>
  );
}
