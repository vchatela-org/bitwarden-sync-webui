import React, { useState, useEffect, useMemo } from 'react';
import {
  Archive,
  HardDriveDownload,
  FileWarning,
  ShieldCheck,
  RefreshCw,
  Trash2,
  Eye,
  Check,
  X,
  AlertCircle,
  ChevronRight,
  Layers,
} from 'lucide-react';
import {
  AppConfig,
  BackupInventory,
  BackupSet,
  IntegrityResult,
  PruneSummary,
} from '../types.js';
import { getBackups, verifyBackups, pruneBackups } from '../api.js';
import { Card, CardHeader, StatCard } from './ui/Card.js';
import { Button } from './ui/Button.js';
import { Badge, StatusLabel } from './ui/Badge.js';
import { Input, Field, Alert } from './ui/Input.js';
import { CheckboxField } from './ui/Checkbox.js';
import { LoadingPane, EmptyState, Tooltip } from './ui/Feedback.js';
import { cn } from '../lib/cn.js';
import { formatBytes, formatTimestamp, backupAge } from '../lib/status.js';

interface Props {
  config: AppConfig;
}

export function BackupsPage({ config }: Props) {
  const [inventory, setInventory] = useState<BackupInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [keepDaily, setKeepDaily] = useState(config.retention.keepDaily);
  const [keepMonthly, setKeepMonthly] = useState(config.retention.keepMonthly);
  const [dryRun, setDryRun] = useState(true);
  const [pruneResult, setPruneResult] = useState<PruneSummary | null>(null);
  const [verifyResult, setVerifyResult] = useState<IntegrityResult[] | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadInventory();
  }, []);

  async function loadInventory() {
    setLoading(true);
    try {
      const inv = await getBackups();
      setInventory(inv);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load backups');
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify() {
    setError('');
    setVerifying(true);
    try {
      const r = await verifyBackups();
      setVerifyResult(r.results);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Verification failed');
    } finally {
      setVerifying(false);
    }
  }

  async function handlePrune() {
    setError('');
    setPruning(true);
    try {
      const r = await pruneBackups({ keepDaily, keepMonthly, dryRun });
      setPruneResult(r);
      if (!r.dryRun) await loadInventory();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Prune failed');
    } finally {
      setPruning(false);
    }
  }

  function toggleTarget(target: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(target)) next.delete(target);
      else next.add(target);
      return next;
    });
  }

  const managed = inventory?.managed ?? [];
  const unmanaged = inventory?.unmanaged ?? [];

  const byTarget = useMemo(() => {
    const map = new Map<string, BackupSet[]>();
    for (const s of managed) {
      if (!map.has(s.targetKey)) map.set(s.targetKey, []);
      map.get(s.targetKey)!.push(s);
    }
    for (const sets of map.values()) {
      sets.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    }
    return map;
  }, [managed]);

  const totalBytes = managed.reduce((acc, s) => acc + s.sizeBytes, 0);
  const failedChecks = verifyResult?.filter((r) => !r.ok) ?? [];

  if (loading) return <LoadingPane label="Loading backups…" />;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Backup sets" value={managed.length} hint={`${byTarget.size} target${byTarget.size === 1 ? '' : 's'}`} icon={<Archive />} tone="accent" />
        <StatCard label="Total size" value={formatBytes(totalBytes)} hint="on the backup volume" icon={<HardDriveDownload />} />
        <StatCard
          label="Unmanaged files"
          value={unmanaged.length}
          hint="never pruned automatically"
          icon={<FileWarning />}
          tone={unmanaged.length > 0 ? 'warn' : 'neutral'}
        />
        <StatCard
          label="Integrity"
          value={verifyResult ? (failedChecks.length === 0 ? 'Passing' : `${failedChecks.length} bad`) : '—'}
          hint={verifyResult ? `${verifyResult.length} files checked` : 'not verified yet'}
          icon={<ShieldCheck />}
          tone={verifyResult ? (failedChecks.length === 0 ? 'ok' : 'danger') : 'neutral'}
        />
      </div>

      {error && <Alert icon={<AlertCircle />}>{error}</Alert>}

      <div className="flex flex-wrap items-center gap-2">
        <Button icon={<ShieldCheck />} loading={verifying} onClick={handleVerify}>
          Verify integrity
        </Button>
        <Button variant="ghost" icon={<RefreshCw />} onClick={loadInventory}>
          Refresh
        </Button>
      </div>

      {/* ── Integrity results ───────────────────────────────────────────── */}
      {verifyResult && (
        <Card>
          <CardHeader
            title="Integrity results"
            description={`${verifyResult.length - failedChecks.length} of ${verifyResult.length} files verified`}
            actions={
              <Button size="sm" variant="ghost" onClick={() => setVerifyResult(null)} aria-label="Dismiss results">
                <X className="size-3.5" />
              </Button>
            }
          />
          {verifyResult.length === 0 ? (
            <EmptyState icon={<ShieldCheck />} title="Nothing to verify" description="No managed backup files were found." />
          ) : (
            <div className="scrollbar-thin max-h-72 divide-y divide-line overflow-y-auto">
              {/* Failures first — they are the only reason to read this list */}
              {[...verifyResult].sort((a, b) => Number(a.ok) - Number(b.ok)).map((r, i) => (
                <div key={i} className="flex items-start gap-2.5 px-4 py-2 text-xs">
                  {r.ok ? (
                    <Check className="mt-px size-3.5 shrink-0 text-ok" />
                  ) : (
                    <X className="mt-px size-3.5 shrink-0 text-danger" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono text-fg-muted">
                    {r.path.split(/[/\\]/).pop()}
                  </span>
                  {r.reason && <span className="shrink-0 text-danger">{r.reason}</span>}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* ── Sets by target ──────────────────────────────────────────────── */}
      {byTarget.size === 0 ? (
        <Card>
          <EmptyState
            icon={<Archive />}
            title="No backups yet"
            description="Run a backup from the dashboard — sets will be listed here grouped by target."
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {[...byTarget.entries()].map(([target, sets]) => {
            const newest = sets[0]!;
            const open = expanded.has(target);
            const targetBytes = sets.reduce((a, s) => a + s.sizeBytes, 0);
            const age = backupAge(newest.timestamp);

            return (
              <Card key={target}>
                <button
                  onClick={() => toggleTarget(target)}
                  aria-expanded={open}
                  className="flex w-full items-center gap-3 bg-surface-2/60 px-4 py-3 text-left transition-colors hover:bg-surface-2"
                >
                  <ChevronRight
                    className={cn(
                      'size-3.5 shrink-0 text-fg-subtle transition-transform duration-200',
                      open && 'rotate-90',
                    )}
                  />
                  <span className="text-[13px] font-semibold text-fg">{target}</span>
                  <Badge tone={newest.kind === 'org' ? 'violet' : 'info'}>{newest.kind}</Badge>
                  <StatusLabel tone={age.tone}>{age.label}</StatusLabel>

                  <span className="ml-auto flex items-center gap-3 text-xs text-fg-subtle">
                    <span className="inline-flex items-center gap-1.5">
                      <Layers className="size-3.5" />
                      <span className="tabular-nums">{sets.length}</span>
                    </span>
                    <span className="tabular-nums">{formatBytes(targetBytes)}</span>
                  </span>
                </button>

                {open && (
                  <div className="scrollbar-thin overflow-x-auto">
                    <table className="w-full min-w-[34rem] text-[13px]">
                      <thead>
                        <tr className="border-b border-line text-left">
                          <Th className="pl-4">Timestamp</Th>
                          <Th className="text-right">Items</Th>
                          <Th className="text-right">Size</Th>
                          <Th className="pr-4 text-right">Files</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {sets.map((s) => (
                          <tr key={s.timestamp} className="border-b border-line/60 last:border-0 hover:bg-surface-2">
                            <td className="py-2 pl-4">
                              <span className="inline-flex items-center gap-2">
                                <span className={cn('font-mono text-xs', s === newest ? 'text-fg' : 'text-fg-muted')}>
                                  {formatTimestamp(s.timestamp)}
                                </span>
                                {s === newest && <Badge tone="accent">newest</Badge>}
                              </span>
                            </td>
                            <td className="py-2 text-right tabular-nums text-fg-muted">
                              {s.meta?.itemCount?.toLocaleString() ?? '—'}
                            </td>
                            <td className="py-2 text-right tabular-nums text-fg-muted">
                              {formatBytes(s.sizeBytes)}
                            </td>
                            <td className="py-2 pr-4 text-right tabular-nums text-fg-subtle">
                              {s.files.length}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* ── Unmanaged ───────────────────────────────────────────────────── */}
      {unmanaged.length > 0 && (
        <Card className="border-warn-line">
          <CardHeader
            title={
              <span className="inline-flex items-center gap-2 text-warn">
                <FileWarning className="size-3.5" />
                Unmanaged files
              </span>
            }
            description="Not matched to a configured target — retention never touches these."
            className="bg-warn-soft"
          />
          <div className="scrollbar-thin flex max-h-40 flex-wrap gap-1.5 overflow-y-auto p-4">
            {unmanaged.map((f, i) => (
              <Tooltip key={i} content={f}>
                <span className="rounded-md border border-line bg-elevated px-2 py-0.5 font-mono text-[11px] text-fg-subtle">
                  {f.split(/[/\\]/).pop()}
                </span>
              </Tooltip>
            ))}
          </div>
        </Card>
      )}

      {/* ── Retention ───────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Retention & pruning"
          description="Keeps the newest N daily sets and N monthly sets per target; everything else is deleted."
        />
        <div className="space-y-4 p-4">
          <div className="flex flex-wrap items-end gap-4">
            <Field label="Keep daily" htmlFor="keep-daily" className="w-28">
              <Input
                id="keep-daily"
                type="number"
                min={1}
                value={keepDaily}
                onChange={(e) => setKeepDaily(Math.max(1, parseInt(e.target.value) || 1))}
              />
            </Field>
            <Field label="Keep monthly" htmlFor="keep-monthly" className="w-28">
              <Input
                id="keep-monthly"
                type="number"
                min={1}
                value={keepMonthly}
                onChange={(e) => setKeepMonthly(Math.max(1, parseInt(e.target.value) || 1))}
              />
            </Field>
            <CheckboxField
              checked={dryRun}
              onCheckedChange={(v) => { setDryRun(v); setPruneResult(null); }}
              label="Dry run (preview only)"
              className="h-9 items-center"
            />
            <Button
              variant={dryRun ? 'default' : 'danger'}
              icon={dryRun ? <Eye /> : <Trash2 />}
              loading={pruning}
              onClick={handlePrune}
              className="ml-auto"
            >
              {dryRun ? 'Preview prune' : 'Delete permanently'}
            </Button>
          </div>

          {!dryRun && (
            <Alert tone="warn" icon={<AlertCircle />}>
              Dry run is off — the next run deletes files from the backup volume immediately.
            </Alert>
          )}

          {pruneResult && <PruneReport result={pruneResult} />}
        </div>
      </Card>
    </div>
  );
}

function PruneReport({ result }: { result: PruneSummary }) {
  if (result.toDelete.length === 0) {
    return (
      <div className="rounded-lg border border-ok-line bg-ok-soft px-3 py-2.5 text-[13px] text-ok">
        Nothing to prune — every set is within the retention policy.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div
        className={cn(
          'flex flex-wrap items-center gap-2 px-3 py-2 text-[13px]',
          result.dryRun ? 'bg-info-soft text-info' : 'bg-danger-soft text-danger',
        )}
      >
        <span className="font-medium">
          {result.dryRun ? 'Preview' : 'Deleted'}: {result.toDelete.length} set
          {result.toDelete.length === 1 ? '' : 's'}
        </span>
        <span className="opacity-60">·</span>
        <span className="tabular-nums">{formatBytes(result.totalBytes)} reclaimed</span>
      </div>

      <div className="scrollbar-thin max-h-56 divide-y divide-line overflow-y-auto bg-surface-2">
        {result.toDelete.map((c, i) => (
          <div key={i} className="flex items-center gap-3 px-3 py-1.5 text-xs">
            <span className="font-medium text-fg-muted">{c.targetKey}</span>
            <span className="font-mono text-fg-subtle">{formatTimestamp(c.timestamp)}</span>
            <span className="ml-auto shrink-0 tabular-nums text-fg-subtle">
              {c.files.length} file{c.files.length === 1 ? '' : 's'} · {formatBytes(c.sizeBytes)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Th({ className, children }: { className?: string; children?: React.ReactNode }) {
  return (
    <th
      className={cn(
        'px-3 py-2 text-[11px] font-medium uppercase tracking-[0.06em] text-fg-subtle',
        className,
      )}
    >
      {children}
    </th>
  );
}
