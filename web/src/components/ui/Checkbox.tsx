import React from 'react';
import * as RC from '@radix-ui/react-checkbox';
import { Check, Minus } from 'lucide-react';
import { cn } from '../../lib/cn.js';

export function Checkbox({
  checked,
  onCheckedChange,
  className,
  ...rest
}: Omit<RC.CheckboxProps, 'className'> & { className?: string }) {
  return (
    <RC.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-[5px] border',
        'transition-[background-color,border-color] duration-150 cursor-pointer',
        'border-line-strong bg-bg hover:border-fg-faint',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent',
        'data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent',
        'disabled:cursor-not-allowed disabled:opacity-45',
        className,
      )}
      {...rest}
    >
      <RC.Indicator className="text-white">
        {checked === 'indeterminate' ? (
          <Minus className="size-3" strokeWidth={3} />
        ) : (
          <Check className="size-3" strokeWidth={3} />
        )}
      </RC.Indicator>
    </RC.Root>
  );
}

/** Checkbox with a clickable text label beside it. */
export function CheckboxField({
  checked,
  onCheckedChange,
  label,
  className,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  label: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn('flex cursor-pointer select-none items-center gap-2 text-[13px] text-fg-muted', className)}>
      <Checkbox checked={checked} onCheckedChange={(v: RC.CheckedState) => onCheckedChange(v === true)} />
      {label}
    </label>
  );
}
