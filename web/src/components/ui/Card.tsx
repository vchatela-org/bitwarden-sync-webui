import React from 'react';
import { cn } from '../../lib/cn.js';

export function Card({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'bg-surface border border-line rounded-xl shadow-card overflow-hidden',
        className,
      )}
      {...rest}
    />
  );
}

export function CardHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 px-4 py-3 border-b border-line bg-surface-2/60',
        className,
      )}
    >
      <div className="min-w-0">
        <h3 className="text-[13px] font-semibold text-fg truncate">{title}</h3>
        {description && (
          <p className="text-xs text-fg-subtle mt-0.5 truncate">{description}</p>
        )}
      </div>
      {actions && <div className="ml-auto flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

/** Big-number tile for the dashboard summary row. */
export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = 'neutral',
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';
  className?: string;
}) {
  const toneRing = {
    neutral: 'text-fg-subtle bg-elevated',
    ok: 'text-ok bg-ok-soft',
    warn: 'text-warn bg-warn-soft',
    danger: 'text-danger bg-danger-soft',
    accent: 'text-accent bg-accent-soft',
  }[tone];

  return (
    <div
      className={cn(
        'group relative bg-surface border border-line rounded-xl p-4 shadow-card',
        'transition-colors duration-200 hover:border-line-strong',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-fg-subtle">
          {label}
        </span>
        {icon && (
          <span
            className={cn(
              'flex size-6 items-center justify-center rounded-md [&>svg]:size-3.5',
              toneRing,
            )}
          >
            {icon}
          </span>
        )}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-fg tabular-nums">
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-fg-subtle">{hint}</div>}
    </div>
  );
}
