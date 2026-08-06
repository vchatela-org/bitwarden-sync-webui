import React, { useEffect, useMemo } from 'react';
import {
  RefreshCw,
  Hash,
  Save,
  Download,
  RotateCw,
  Users,
  Archive,
  HardDriveDownload,
  Clock,
  Cloud,
  HardDrive,
  AlertCircle,
  ArrowUp,
  ArrowDown,
  Check,
} from 'lucide-react';
import { AppConfig, BackupSet, VaultStatus } from '../types.js';
import { createJob } from '../api.js';
import { useDashboardData } from '../state/DashboardData.js';
import { Button } from './ui/Button.js';
import { Card, StatCard } from './ui/Card.js';
import { Badge, StatusLabel } from './ui/Badge.js';
import { Checkbox } from './ui/Checkbox.js';
import { Alert } from './ui/Input.js';
import { Tooltip, EmptyState } from './ui/Feedback.js';
import { cn } from '../lib/cn.js';
import { vaultTone, formatBytes, backupAge, parseTimestamp, relativeTime } from '../lib/status.js';

interface Props {
  config: AppConfig;
  onJobCreated: (jobId: string) => void;
}

interface Target {
  key: string;
  kind: 'user' | 'org';
  displayName: string;
  /** Org owner key — used to nest orgs beneath the user that owns them. */
  owner: string | null;
}

export function Dashboard({ config, onJobCreated }: Props) {
  // Lives above the page switch so it survives navigating to Jobs/Backups and back.
  const {
    status,
    statusLoading,
    refreshStatus,
    liveCounts,
    countLoading,
    startCounts,
    backupSets,
    refreshBackups,
    selectedTargets,
    setSelectedTargets,
    error,
    setError,
  } = useDashboardData();

  /** Users first, each immediately followed by the orgs it owns. */
  const allTargets = useMemo<Target[]>(() => {
    const users: Target[] = config.users.map((u) => ({
      key: u.key,
      kind: 'user',
      displayName: u.displayName ?? u.key,
      owner: null,
    }));
    const orgs: Target[] = config.orgs.map((o) => ({
      key: o.key,
      kind: 'org',
      displayName: o.name,
      owner: o.owner,
    }));

    const ordered: Target[] = [];
    for (const user of users) {
      ordered.push(user);
      ordered.push(...orgs.filter((o) => o.owner === user.key));
    }
    // Orgs whose owner is not a configured user still need to be listed.
    ordered.push(...orgs.filter((o) => !users.some((u) => u.key === o.owner)));
    return ordered;
  }, [config]);

  // Re-read the inventory each time the dashboard is shown; the cached sets stay
  // on screen meanwhile, so a job run elsewhere is picked up without a blank flash.
  useEffect(() => {
    refreshBackups();
  }, [refreshBackups]);

  function toggleTarget(key: string) {
    setSelectedTargets((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAll() {
    setSelectedTargets((prev) =>
      prev.size === allTargets.length ? new Set() : new Set(allTargets.map((t) => t.key)),
    );
  }

  function effectiveTargets(): string[] {
    return selectedTargets.size > 0 ? [...selectedTargets] : allTargets.map((t) => t.key);
  }

  async function startJob(ops: string[]) {
    try {
      const r = await createJob(effectiveTargets(), ops);
      onJobCreated(r.jobId);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to create job');
    }
  }

  /** Newest backup set per target, plus set count. */
  const perTarget = useMemo(() => {
    const map = new Map<string, { newest: BackupSet | null; count: number }>();
    for (const t of allTargets) {
      const sets = backupSets
        .filter((s) => s.targetKey === t.key)
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      map.set(t.key, { newest: sets[0] ?? null, count: sets.length });
    }
    return map;
  }, [allTargets, backupSets]);

  const summary = useMemo(() => {
    const newestSets = allTargets
      .map((t) => perTarget.get(t.key)?.newest)
      .filter((s): s is BackupSet => !!s);
    const items = newestSets.reduce((acc, s) => acc + (s.itemCount ?? 0), 0);
    const unknownCounts = newestSets.filter((s) => s.itemCount === undefined).length;
    const totalBytes = backupSets.reduce((acc, s) => acc + s.sizeBytes, 0);
    const oldest = newestSets.length
      ? newestSets.reduce((a, b) => (parseTimestamp(a.timestamp) < parseTimestamp(b.timestamp) ? a : b))
      : null;
    const uncovered = allTargets.length - newestSets.length;
    return { items, totalBytes, oldest, uncovered, unknownCounts };
  }, [allTargets, perTarget, backupSets]);

  const allSelected = selectedTargets.size === allTargets.length && allTargets.length > 0;
  const someSelected = selectedTargets.size > 0 && !allSelected;
  const staleness = summary.oldest ? backupAge(summary.oldest.timestamp) : null;

  return (
    <div className="space-y-6">
      {/* ── Summary ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Targets"
          value={allTargets.length}
          hint={`${config.users.length} user${config.users.length === 1 ? '' : 's'} · ${config.orgs.length} org${config.orgs.length === 1 ? '' : 's'}`}
          icon={<Users />}
          tone="accent"
        />
        <StatCard
          label="Oldest backup"
          value={staleness?.label ?? '—'}
          hint={
            summary.uncovered > 0
              ? `${summary.uncovered} target${summary.uncovered === 1 ? '' : 's'} never backed up`
              : 'every target covered'
          }
          icon={<Clock />}
          tone={summary.uncovered > 0 ? 'danger' : (staleness?.tone as 'ok' | 'warn' | 'danger') ?? 'neutral'}
        />
        <StatCard
          label="Items protected"
          value={summary.items.toLocaleString()}
          hint={
            summary.unknownCounts > 0
              ? `across newest backup of each target · ${summary.unknownCounts} uncountable`
              : 'across newest backup of each target'
          }
          icon={<Archive />}
        />
        <StatCard
          label="Archive size"
          value={formatBytes(summary.totalBytes)}
          hint={`${backupSets.length} backup set${backupSets.length === 1 ? '' : 's'}`}
          icon={<HardDriveDownload />}
        />
      </div>

      {error && <Alert icon={<AlertCircle />}>{error}</Alert>}

      {/* ── Targets ─────────────────────────────────────────────────────── */}
      <Card>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface-2/60 px-4 py-3">
          <h2 className="text-[13px] font-semibold text-fg">Targets</h2>
          <span
            className={cn(
              'text-xs transition-colors',
              selectedTargets.size > 0 ? 'text-accent' : 'text-fg-subtle',
            )}
          >
            {selectedTargets.size > 0
              ? `${selectedTargets.size} selected`
              : 'all targets · none selected'}
          </span>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              icon={<RefreshCw />}
              loading={statusLoading}
              onClick={refreshStatus}
            >
              Vault status
            </Button>
            <Tooltip content="Unlocks both the cloud and home vault for each target to fetch live item counts">
              <span>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Hash />}
                  loading={countLoading}
                  onClick={() => startCounts(effectiveTargets())}
                >
                  Live counts
                </Button>
              </span>
            </Tooltip>
          </div>
        </div>

        {allTargets.length === 0 ? (
          <EmptyState
            icon={<Users />}
            title="No targets configured"
            description="Add users and organisations to targets.json, then restart the container."
          />
        ) : (
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full min-w-[52rem] text-[13px]">
              <thead>
                <tr className="border-b border-line text-left">
                  <Th className="w-9 pl-4">
                    <Checkbox
                      checked={someSelected ? 'indeterminate' : allSelected}
                      onCheckedChange={toggleAll}
                      aria-label="Select all targets"
                    />
                  </Th>
                  <Th>Target</Th>
                  <Th>
                    <span className="inline-flex items-center gap-1.5">
                      <Cloud className="size-3.5 text-info" /> Cloud
                    </span>
                  </Th>
                  <Th>
                    <span className="inline-flex items-center gap-1.5">
                      <HardDrive className="size-3.5 text-violet" /> Home
                    </span>
                  </Th>
                  <Th>Last backup</Th>
                  <Th className="text-right">Backup items</Th>
                  <Th className="pr-4 text-right">Sets</Th>
                </tr>
              </thead>
              <tbody>
                {allTargets.map((target) => {
                  const st = status[target.key];
                  const { newest, count } = perTarget.get(target.key) ?? { newest: null, count: 0 };
                  const selected = selectedTargets.has(target.key);
                  const isOrg = target.kind === 'org';
                  return (
                    <tr
                      key={target.key}
                      onClick={() => toggleTarget(target.key)}
                      className={cn(
                        'group cursor-pointer border-b border-line/60 transition-colors duration-100 last:border-0',
                        selected ? 'bg-accent-soft' : 'hover:bg-surface-2',
                      )}
                    >
                      <td className="py-2.5 pl-4" onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={selected}
                          onCheckedChange={() => toggleTarget(target.key)}
                          aria-label={`Select ${target.key}`}
                        />
                      </td>
                      <td className="py-2.5 pr-3">
                        <div className={cn('flex items-center gap-2', isOrg && 'pl-4')}>
                          {isOrg && (
                            <span className="-ml-3 text-fg-faint" aria-hidden>
                              └
                            </span>
                          )}
                          <span className="font-medium text-fg">{target.key}</span>
                          <Badge tone={isOrg ? 'violet' : 'info'}>{isOrg ? 'org' : 'user'}</Badge>
                          {target.displayName !== target.key && (
                            <span className="truncate text-xs text-fg-subtle">
                              {target.displayName}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 pr-3">
                        <VaultCell
                          status={st?.cloud}
                          liveItems={liveCounts[target.key]?.cloud}
                          liveAt={liveCounts[target.key]?.cloudAt}
                        />
                      </td>
                      <td className="py-2.5 pr-3">
                        <VaultCell
                          status={st?.home}
                          liveItems={liveCounts[target.key]?.home}
                          liveAt={liveCounts[target.key]?.homeAt}
                        />
                      </td>
                      <td className="py-2.5 pr-3">
                        {newest ? (
                          <Tooltip content={`${newest.timestamp} · ${formatBytes(newest.sizeBytes)}`}>
                            <span>
                              <StatusLabel tone={backupAge(newest.timestamp).tone}>
                                {backupAge(newest.timestamp).label}
                              </StatusLabel>
                            </span>
                          </Tooltip>
                        ) : (
                          <span className="text-xs text-fg-faint">never</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-right">
                        <ItemsCell
                          lastKnown={newest?.meta?.itemCount}
                          live={liveCounts[target.key]?.cloud}
                          liveAt={liveCounts[target.key]?.cloudAt}
                        />
                      </td>
                      <td className="py-2.5 pr-4 text-right">
                        <span className={cn('tabular-nums', count > 0 ? 'text-fg-muted' : 'text-fg-faint')}>
                          {count}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── Action bar ──────────────────────────────────────────────────── */}
      <div className="sticky bottom-4 z-30">
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line-strong bg-elevated/90 px-3 py-2.5 shadow-pop backdrop-blur-xl">
          <span className="mr-1 hidden text-xs text-fg-subtle sm:inline">
            Run on{' '}
            <strong className="font-medium text-fg-muted">
              {selectedTargets.size > 0 ? `${selectedTargets.size} selected` : 'all targets'}
            </strong>
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button icon={<Save />} onClick={() => startJob(['backup'])}>
              Backup
            </Button>
            <Button icon={<Download />} onClick={() => startJob(['import'])}>
              Import
            </Button>
            <Button variant="primary" icon={<RotateCw />} onClick={() => startJob(['both'])}>
              Backup + Import
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Th({ className, children }: { className?: string; children?: React.ReactNode }) {
  return (
    <th
      className={cn(
        'px-3 py-2.5 text-[11px] font-medium uppercase tracking-[0.06em] text-fg-subtle',
        className,
      )}
    >
      {children}
    </th>
  );
}

function ItemsCell({ lastKnown, live, liveAt }: { lastKnown?: number; live?: number; liveAt?: string }) {
  if (live === undefined) {
    return lastKnown !== undefined ? (
      <span className="tabular-nums text-fg-muted">{lastKnown.toLocaleString()}</span>
    ) : (
      <span className="text-fg-faint">—</span>
    );
  }

  const tooltip = [
    `Live vault: ${live}${liveAt ? ` (${relativeTime(liveAt)})` : ''}`,
    lastKnown !== undefined ? `last backup: ${lastKnown}` : null,
  ].filter(Boolean).join(' · ');

  if (lastKnown === undefined) {
    return (
      <Tooltip content={tooltip}>
        <span className="font-medium tabular-nums text-info">{live.toLocaleString()}</span>
      </Tooltip>
    );
  }

  const diff = live - lastKnown;
  return (
    <Tooltip content={tooltip}>
      <span className="inline-flex items-center justify-end gap-1.5">
        <span className="font-medium tabular-nums text-info">{live.toLocaleString()}</span>
        {diff === 0 ? (
          <Check className="size-3 text-ok" />
        ) : (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 text-[11px] font-medium tabular-nums',
              diff > 0 ? 'text-ok' : 'text-danger',
            )}
          >
            {diff > 0 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}
            {Math.abs(diff)}
          </span>
        )}
      </span>
    </Tooltip>
  );
}

function VaultCell({ status, liveItems, liveAt }: { status?: VaultStatus; liveItems?: number; liveAt?: string }) {
  const liveLabel = liveItems !== undefined && (
    <span className="inline-flex items-baseline gap-1 pl-3 text-[11px] font-medium tabular-nums text-info">
      {liveItems.toLocaleString()} items
      {liveAt && (
        <Tooltip content={new Date(liveAt).toLocaleString()}>
          <span className="font-normal text-fg-faint">· {relativeTime(liveAt)}</span>
        </Tooltip>
      )}
    </span>
  );

  if (!status) {
    return liveLabel || <span className="text-xs text-fg-faint">—</span>;
  }
  return (
    <Tooltip
      content={
        <span className="font-mono">
          {status.userEmail ?? status.serverUrl}
          {status.lastSync && ` · synced ${new Date(status.lastSync).toLocaleString()}`}
        </span>
      }
    >
      <span className="inline-flex flex-col items-start gap-0.5">
        <StatusLabel tone={vaultTone(status.status)} pulse={status.status === 'unlocked'}>
          {status.status}
        </StatusLabel>
        {liveLabel || (
          status.lastSync && (
            <span className="pl-3 text-[11px] text-fg-faint">
              {new Date(status.lastSync).toLocaleDateString()}
            </span>
          )
        )}
      </span>
    </Tooltip>
  );
}
