import React from 'react';
import {
  Circle,
  Loader2,
  CheckCircle2,
  XCircle,
  MinusCircle,
  AlertTriangle,
  PauseCircle,
} from 'lucide-react';
import { Step, StepState } from '../types.js';
import { cn } from '../lib/cn.js';
import { STEP_TONE, formatDuration } from '../lib/status.js';
import { TONE_TEXT } from './ui/Badge.js';
import { Tooltip } from './ui/Feedback.js';

interface Props {
  steps: Step[];
  onSelectStep?: (stepId: string | undefined) => void;
  selectedStep?: string;
}

const STEP_ICON: Record<StepState, React.ComponentType<{ className?: string }>> = {
  pending: Circle,
  running: Loader2,
  succeeded: CheckCircle2,
  failed: XCircle,
  skipped: MinusCircle,
  warning: AlertTriangle,
  'awaiting-input': PauseCircle,
};

/** Left border colour of a step node, by state. */
const STEP_EDGE: Record<StepState, string> = {
  pending: 'border-l-fg-faint',
  running: 'border-l-info',
  succeeded: 'border-l-ok',
  failed: 'border-l-danger',
  skipped: 'border-l-fg-faint',
  warning: 'border-l-warn',
  'awaiting-input': 'border-l-violet',
};

export function StepGraph({ steps, onSelectStep, selectedStep }: Props) {
  const groups = new Map<string, Step[]>();
  for (const step of steps) {
    if (!groups.has(step.group)) groups.set(step.group, []);
    groups.get(step.group)!.push(step);
  }

  return (
    <div className="space-y-4">
      {[...groups.entries()].map(([group, groupSteps]) => {
        const done = groupSteps.filter((s) => s.state === 'succeeded').length;
        const failed = groupSteps.some((s) => s.state === 'failed');

        return (
          <div key={group}>
            <div className="mb-2 flex items-center gap-2">
              <h4 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-subtle">
                {group}
              </h4>
              <div className="h-px flex-1 rule-fade opacity-60" />
              <span
                className={cn(
                  'text-[10px] tabular-nums',
                  failed ? 'text-danger' : done === groupSteps.length ? 'text-ok' : 'text-fg-faint',
                )}
              >
                {done}/{groupSteps.length}
              </span>
            </div>

            <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {groupSteps.map((step) => {
                const tone = STEP_TONE[step.state];
                const Icon = STEP_ICON[step.state];
                const isSelected = selectedStep === step.id;
                const duration = formatDuration(step.startedAt, step.endedAt);

                return (
                  <button
                    key={step.id}
                    onClick={() => onSelectStep?.(isSelected ? undefined : step.id)}
                    disabled={!onSelectStep}
                    className={cn(
                      'flex items-start gap-2 rounded-lg border border-l-2 px-2.5 py-2 text-left',
                      'transition-[background-color,border-color] duration-150',
                      STEP_EDGE[step.state],
                      isSelected
                        ? 'border-accent-line bg-accent-soft'
                        : 'border-line bg-surface enabled:hover:bg-surface-2 enabled:hover:border-line-strong',
                      !onSelectStep && 'cursor-default',
                    )}
                  >
                    <Icon
                      className={cn(
                        'mt-px size-3.5 shrink-0',
                        TONE_TEXT[tone],
                        step.state === 'running' && 'animate-spin',
                        step.state === 'pending' && 'opacity-50',
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div
                        className={cn(
                          'truncate text-xs leading-snug',
                          step.state === 'pending' ? 'text-fg-subtle' : 'text-fg',
                        )}
                      >
                        {step.label}
                      </div>
                      {step.detail && (
                        <Tooltip content={step.detail}>
                          <div className="mt-0.5 truncate text-[11px] text-fg-subtle">
                            {step.detail}
                          </div>
                        </Tooltip>
                      )}
                    </div>
                    {duration && (
                      <span className="mt-px shrink-0 text-[10px] tabular-nums text-fg-faint">
                        {duration}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
