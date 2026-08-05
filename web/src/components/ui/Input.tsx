import React from 'react';
import { cn } from '../../lib/cn.js';

const FIELD =
  'w-full bg-bg border border-line-strong rounded-lg text-fg placeholder:text-fg-faint ' +
  'transition-[border-color,box-shadow] duration-150 ' +
  'hover:border-fg-faint focus:outline-none focus:border-accent focus:ring-3 focus:ring-accent/20 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Icon rendered inside the field, on the left. */
  icon?: React.ReactNode;
  invalid?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { icon, invalid, className, ...rest },
  ref,
) {
  const field = (
    <input
      ref={ref}
      className={cn(
        FIELD,
        'h-9 px-3 text-[13px]',
        icon && 'pl-8.5',
        invalid && 'border-danger-line focus:border-danger focus:ring-danger/20',
        className,
      )}
      {...rest}
    />
  );

  if (!icon) return field;

  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-faint [&>svg]:size-3.5">
        {icon}
      </span>
      {field}
    </div>
  );
});

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <div className="relative">
        <select
          ref={ref}
          className={cn(FIELD, 'h-9 pl-3 pr-8 text-[13px] appearance-none cursor-pointer', className)}
          {...rest}
        >
          {children}
        </select>
        <svg
          className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m4 6 4 4 4-4" />
        </svg>
      </div>
    );
  },
);

export function Field({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={htmlFor} className="block text-xs font-medium text-fg-muted">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-fg-subtle">{hint}</p>}
    </div>
  );
}

/** Inline error/alert strip used under forms and at the top of pages. */
export function Alert({
  tone = 'danger',
  icon,
  className,
  children,
}: {
  tone?: 'danger' | 'warn' | 'info';
  icon?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  const tones = {
    danger: 'bg-danger-soft border-danger-line text-danger',
    warn: 'bg-warn-soft border-warn-line text-warn',
    info: 'bg-info-soft border-info-line text-info',
  }[tone];

  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px] animate-fade-in',
        tones,
        className,
      )}
    >
      {icon && <span className="mt-px shrink-0 [&>svg]:size-4">{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
