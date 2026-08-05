import React from 'react';
import { cn } from '../../lib/cn.js';

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info' | 'violet';

export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-fg-muted',
  accent: 'text-accent',
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
  info: 'text-info',
  violet: 'text-violet',
};

const TONE_CHIP: Record<Tone, string> = {
  neutral: 'bg-elevated text-fg-muted border-line-strong',
  accent: 'bg-accent-soft text-accent border-accent-line',
  ok: 'bg-ok-soft text-ok border-ok-line',
  warn: 'bg-warn-soft text-warn border-warn-line',
  danger: 'bg-danger-soft text-danger border-danger-line',
  info: 'bg-info-soft text-info border-info-line',
  violet: 'bg-violet-soft text-violet border-violet-line',
};

export function Badge({
  tone = 'neutral',
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-px',
        'text-[11px] font-medium leading-[18px] whitespace-nowrap',
        TONE_CHIP[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}

/**
 * Small filled circle used as a status glyph. `pulse` adds an expanding ring —
 * reserve it for states that are actively changing.
 */
export function Dot({
  tone = 'neutral',
  pulse,
  className,
}: {
  tone?: Tone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full bg-current',
        TONE_TEXT[tone],
        pulse && 'animate-pulse-ring',
        className,
      )}
    />
  );
}

/** Status glyph + label, the pairing used in every table status cell. */
export function StatusLabel({
  tone = 'neutral',
  pulse,
  children,
  className,
}: {
  tone?: Tone;
  pulse?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', TONE_TEXT[tone], className)}>
      <Dot tone={tone} pulse={pulse} />
      {children}
    </span>
  );
}
