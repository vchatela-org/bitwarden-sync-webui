import { useEffect, useRef, useState } from 'react';
import { Search, Copy, Download, ArrowDownToLine, Check, Terminal as TerminalIcon } from 'lucide-react';
import { Input } from './ui/Input.js';
import { Button } from './ui/Button.js';
import { Tooltip } from './ui/Feedback.js';
import { cn } from '../lib/cn.js';
import { maskEmails } from '../lib/mask.js';

interface LogLine {
  ts: string;
  stream: 'stdout' | 'stderr' | 'app';
  step?: string;
  line: string;
}

interface Props {
  logs: LogLine[];
  filterStep?: string;
  height?: number;
  /** When true, redact email addresses in the rendered/copied/downloaded output. */
  masked?: boolean;
}

const STREAM_STYLE: Record<string, string> = {
  stdout: 'text-fg-faint',
  stderr: 'text-danger',
  app: 'text-info',
};

const LINE_STYLE: Record<string, string> = {
  stdout: 'text-fg-muted',
  stderr: 'text-danger/90',
  app: 'text-fg',
};

export function Terminal({ logs, filterStep, height = 340, masked }: Props) {
  const [filter, setFilter] = useState('');
  const [paused, setPaused] = useState(false);
  const [copied, setCopied] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Jobs that ran before output was tagged per step have no `step` on any line — filtering those
  // down to a selected step would blank the panel, so the step filter simply doesn't apply to them.
  const stepTagged = logs.some((l) => l.step);
  const stepFilter = stepTagged ? filterStep : undefined;

  const displayed = logs.filter((l) => {
    if (stepFilter && l.step !== stepFilter) return false;
    if (filter && !l.line.toLowerCase().includes(filter.toLowerCase())) return false;
    return true;
  });

  useEffect(() => {
    if (!paused) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [displayed.length, paused]);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setPaused(!atBottom);
  }

  function resume() {
    setPaused(false);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }

  function asText(): string {
    return displayed.map((l) => `[${l.ts}] [${l.stream}] ${masked ? maskEmails(l.line) : l.line}`).join('\n');
  }

  function copyAll() {
    navigator.clipboard.writeText(asText()).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      },
      () => { /* clipboard unavailable over plain HTTP — Download still works */ },
    );
  }

  function downloadLog() {
    const blob = new Blob([asText()], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bitwarden-sync.log';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="relative overflow-hidden rounded-xl border border-line bg-[#06070a] shadow-card">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface/70 px-2.5 py-2 backdrop-blur">
        <div className="w-full sm:w-56">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter log…"
            icon={<Search />}
            className="h-7 rounded-md text-xs"
          />
        </div>

        <span className="text-[11px] tabular-nums text-fg-faint">
          {displayed.length.toLocaleString()}
          {displayed.length !== logs.length && (
            <span className="text-fg-faint/70"> / {logs.length.toLocaleString()}</span>
          )}{' '}
          lines
        </span>

        {filterStep && !stepTagged && (
          <span className="text-[11px] text-warn">Output isn’t tagged by step for this job</span>
        )}

        <div className="ml-auto flex items-center gap-1">
          <Tooltip content={copied ? 'Copied' : 'Copy visible lines'}>
            <Button size="sm" variant="ghost" onClick={copyAll} aria-label="Copy log">
              {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
            </Button>
          </Tooltip>
          <Tooltip content="Download as .log">
            <Button size="sm" variant="ghost" onClick={downloadLog} aria-label="Download log">
              <Download className="size-3.5" />
            </Button>
          </Tooltip>
        </div>
      </div>

      {/* Log area */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{ height }}
        className="scrollbar-thin overflow-y-auto px-3 py-2.5 font-mono text-[12px] leading-[1.55]"
      >
        {displayed.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-fg-faint">
            <TerminalIcon className="size-5" />
            <span className="text-xs">
              {logs.length === 0
                ? 'Waiting for output…'
                : stepFilter && !filter
                  ? 'This step produced no output'
                  : 'No lines match the current filter'}
            </span>
          </div>
        ) : (
          displayed.map((line, i) => (
            <div key={i} className="flex gap-2.5 rounded px-1 -mx-1 hover:bg-white/[0.03]">
              <span className="w-14 shrink-0 select-none text-fg-faint/60">
                {line.ts.slice(11, 19)}
              </span>
              <span className={cn('w-12 shrink-0 select-none', STREAM_STYLE[line.stream])}>
                {line.stream}
              </span>
              <span className={cn('min-w-0 flex-1 whitespace-pre-wrap break-all', LINE_STYLE[line.stream])}>
                {masked ? maskEmails(line.line) : line.line}
              </span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Resume-follow pill, shown only when the user has scrolled up */}
      {paused && (
        <button
          onClick={resume}
          className={cn(
            'absolute bottom-3 left-1/2 -translate-x-1/2 animate-rise',
            'inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-elevated',
            'px-3 py-1.5 text-[11px] font-medium text-fg-muted shadow-pop',
            'transition-colors hover:border-accent-line hover:text-fg',
          )}
        >
          <ArrowDownToLine className="size-3" />
          Follow output
        </button>
      )}
    </div>
  );
}
