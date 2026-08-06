import React, { useState } from 'react';
import { ShieldAlert, ArrowRight, AlertCircle, Minus, Plus } from 'lucide-react';
import { ConfirmationPrompt, DiffItem } from '../types.js';
import { submitConfirmation } from '../api.js';
import { Modal } from './ui/Modal.js';
import { Button } from './ui/Button.js';
import { Alert } from './ui/Input.js';
import { cn } from '../lib/cn.js';
import { maskValue } from '../lib/mask.js';

interface Props {
  jobId: string;
  prompt: ConfirmationPrompt;
  onSubmitted: () => void;
  /** When true, redact the target and vault item names/usernames — for taking screenshots. */
  masked?: boolean;
}

const REMOVED_PREVIEW = 10;
const ADDED_PREVIEW = 5;

export function ConfirmModal({ jobId, prompt, onSubmitted, masked }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { diff } = prompt;

  async function decide(decision: 'proceed' | 'skip' | 'abort') {
    setError('');
    setLoading(true);
    try {
      await submitConfirmation(jobId, prompt.target, decision);
      onSubmitted();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to submit decision';
      if (/no pending confirmation|not awaiting confirmation/i.test(message)) {
        onSubmitted();
        return;
      }
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  const srcKnown = diff.sourceCount !== 'unknown';
  const ratio =
    srcKnown && diff.destCount > 0
      ? Math.round(((diff.sourceCount as number) / diff.destCount) * 100)
      : null;

  return (
    <Modal
      open
      icon={<ShieldAlert />}
      iconTone="warn"
      title="Import guard tripped"
      description={
        <>
          The import into{' '}
          <strong className="font-medium text-fg">{masked ? maskValue(prompt.target) : prompt.target}</strong>{' '}
          looks destructive and was paused for review.
        </>
      }
      className="w-[min(calc(100vw-2rem),36rem)]"
      footer={
        <>
          <Button variant="ghost" onClick={() => decide('abort')} disabled={loading}>
            Abort job
          </Button>
          <Button variant="default" onClick={() => decide('skip')} disabled={loading}>
            Skip this target
          </Button>
          <Button variant="danger" onClick={() => decide('proceed')} loading={loading}>
            Purge &amp; import anyway
          </Button>
        </>
      }
    >
      <div className="space-y-4 pb-4">
        {diff.guardReason && (
          <Alert tone="warn" icon={<AlertCircle />}>
            {diff.guardReason}
          </Alert>
        )}

        {/* Source → destination counts */}
        <div className="flex items-stretch gap-2">
          <CountBox label="Source" value={srcKnown ? (diff.sourceCount as number) : '?'} />
          <div className="flex items-center">
            <ArrowRight className="size-4 text-fg-faint" />
          </div>
          <CountBox label="Destination" value={diff.destCount} />
          {ratio !== null && (
            <CountBox
              label="Ratio"
              value={`${ratio}%`}
              tone={ratio < 50 ? 'danger' : ratio < 90 ? 'warn' : 'ok'}
            />
          )}
        </div>

        <DiffList
          tone="danger"
          icon={<Minus className="size-3" strokeWidth={3} />}
          title="Would be removed"
          items={diff.removed}
          preview={REMOVED_PREVIEW}
          masked={masked}
        />
        <DiffList
          tone="ok"
          icon={<Plus className="size-3" strokeWidth={3} />}
          title="Would be added"
          items={diff.added}
          preview={ADDED_PREVIEW}
          masked={masked}
        />

        {diff.unchanged > 0 && (
          <p className="text-xs text-fg-subtle">
            <span className="tabular-nums text-fg-muted">{diff.unchanged.toLocaleString()}</span>{' '}
            item{diff.unchanged === 1 ? '' : 's'} unchanged.
          </p>
        )}

        {error && <Alert icon={<AlertCircle />}>{error}</Alert>}

        <div className="rounded-lg border border-danger-line bg-danger-soft px-3 py-2.5 text-[12px] leading-relaxed text-danger">
          <strong className="font-semibold">Purge &amp; import</strong> deletes every item in the
          home vault for this target before re-importing. There is no undo — the newest backup set
          is the only way back.
        </div>
      </div>
    </Modal>
  );
}

function CountBox({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'neutral' | 'ok' | 'warn' | 'danger';
}) {
  const toneText = {
    neutral: 'text-fg',
    ok: 'text-ok',
    warn: 'text-warn',
    danger: 'text-danger',
  }[tone];

  return (
    <div className="flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-center">
      <div className={cn('text-xl font-semibold tabular-nums tracking-tight', toneText)}>{value}</div>
      <div className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.06em] text-fg-subtle">
        {label}
      </div>
    </div>
  );
}

function DiffList({
  tone,
  icon,
  title,
  items,
  preview,
  masked,
}: {
  tone: 'ok' | 'danger';
  icon: React.ReactNode;
  title: string;
  items: DiffItem[];
  preview: number;
  masked?: boolean;
}) {
  if (items.length === 0) return null;

  const toneText = tone === 'ok' ? 'text-ok' : 'text-danger';
  const toneChip = tone === 'ok' ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger';

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className={cn('flex size-4 items-center justify-center rounded', toneChip)}>{icon}</span>
        <span className="text-xs font-medium text-fg-muted">{title}</span>
        <span className={cn('text-xs font-semibold tabular-nums', toneText)}>{items.length}</span>
      </div>
      <div className="scrollbar-thin max-h-40 overflow-y-auto rounded-lg border border-line bg-surface-2 px-3 py-2">
        {items.slice(0, preview).map((item, i) => (
          <div key={i} className="flex items-baseline gap-2 py-0.5 text-xs">
            <span className="truncate text-fg">{masked ? maskValue(item.name) : item.name}</span>
            {item.username && (
              <span className="shrink-0 font-mono text-[11px] text-fg-subtle">
                {masked ? maskValue(item.username) : item.username}
              </span>
            )}
          </div>
        ))}
        {items.length > preview && (
          <div className="mt-1 text-[11px] text-fg-faint">
            …and {items.length - preview} more
          </div>
        )}
      </div>
    </div>
  );
}
