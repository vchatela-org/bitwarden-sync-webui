import React from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { cn } from '../../lib/cn.js';

export interface ModalProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  iconTone?: 'accent' | 'warn' | 'danger';
  footer?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  /**
   * Prompts that block a running job must be answered, so closing on
   * Escape / overlay click is opt-in rather than the default.
   */
  dismissible?: boolean;
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  icon,
  iconTone = 'accent',
  footer,
  children,
  className,
  dismissible = false,
}: ModalProps) {
  const tone = {
    accent: 'bg-accent-soft text-accent border-accent-line',
    warn: 'bg-warn-soft text-warn border-warn-line',
    danger: 'bg-danger-soft text-danger border-danger-line',
  }[iconTone];

  const block = (e: Event) => {
    if (!dismissible) e.preventDefault();
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-[2px] animate-fade-in" />
        <Dialog.Content
          onEscapeKeyDown={block}
          onPointerDownOutside={block}
          onInteractOutside={block}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-[min(calc(100vw-2rem),30rem)]',
            '-translate-x-1/2 -translate-y-1/2 animate-pop',
            'flex max-h-[85vh] flex-col overflow-hidden rounded-2xl',
            'border border-line-strong bg-surface shadow-modal',
            className,
          )}
        >
          <div className="flex items-start gap-3 px-5 pt-5 pb-4">
            {icon && (
              <span
                className={cn(
                  'flex size-9 shrink-0 items-center justify-center rounded-xl border [&>svg]:size-4.5',
                  tone,
                )}
              >
                {icon}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-[15px] font-semibold tracking-tight text-fg">
                {title}
              </Dialog.Title>
              {description && (
                <Dialog.Description className="mt-1 text-[13px] leading-relaxed text-fg-muted">
                  {description}
                </Dialog.Description>
              )}
            </div>
          </div>

          {children && (
            <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 pb-1">{children}</div>
          )}

          {footer && (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-2/60 px-5 py-3.5">
              {footer}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
