import React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/cn.js';

type Variant = 'primary' | 'default' | 'ghost' | 'danger' | 'dangerSoft';
type Size = 'sm' | 'md' | 'icon';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-accent text-white shadow-[0_1px_0_#ffffff26_inset,0_1px_2px_#0006] ' +
    'hover:bg-accent-hi active:bg-accent-lo',
  default:
    'bg-elevated text-fg border border-line-strong ' +
    'hover:bg-hover hover:border-fg-faint active:bg-elevated',
  ghost:
    'text-fg-muted hover:bg-elevated hover:text-fg active:bg-surface-2',
  danger:
    'bg-danger-hi text-white shadow-[0_1px_0_#ffffff26_inset,0_1px_2px_#0006] ' +
    'hover:brightness-110 active:brightness-95',
  dangerSoft:
    'bg-danger-soft text-danger border border-danger-line ' +
    'hover:bg-danger/20 hover:border-danger/60',
};

const SIZES: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-md',
  md: 'h-8.5 px-3 text-[13px] gap-2 rounded-lg',
  icon: 'h-8 w-8 justify-center rounded-lg',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  /** Rendered before the label; swapped for a spinner while `loading`. */
  icon?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', loading, icon, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center font-medium whitespace-nowrap select-none',
        'transition-[background-color,border-color,color,box-shadow,transform] duration-150',
        'active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
      ) : (
        icon && <span className="shrink-0 [&>svg]:size-3.5">{icon}</span>
      )}
      {children}
    </button>
  );
});
