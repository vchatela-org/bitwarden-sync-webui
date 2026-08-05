import React, { useEffect, useRef, useState } from 'react';

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
}

const STREAM_COLORS: Record<string, string> = {
  stdout: '#94a3b8',
  stderr: '#f87171',
  app: '#60a5fa',
};

export function Terminal({ logs, filterStep, height = 320 }: Props) {
  const [filter, setFilter] = useState('');
  const [paused, setPaused] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const displayed = logs.filter((l) => {
    if (filterStep && l.step && l.step !== filterStep) return false;
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

  function copyAll() {
    const text = displayed.map((l) => `[${l.ts}] [${l.stream}] ${l.line}`).join('\n');
    navigator.clipboard.writeText(text).catch(() => {});
  }

  function downloadLog() {
    const text = displayed.map((l) => `[${l.ts}] [${l.stream}] ${l.line}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bitwarden-sync.log';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={styles.filterInput}
          placeholder="Filter log…"
        />
        <span style={styles.lineCount}>{displayed.length} lines</span>
        {paused && <span style={styles.paused}>⏸ Paused</span>}
        <button style={styles.toolBtn} onClick={copyAll}>Copy all</button>
        <button style={styles.toolBtn} onClick={downloadLog}>Download</button>
      </div>
      <div
        ref={containerRef}
        style={{ ...styles.logArea, height }}
        onScroll={handleScroll}
      >
        {displayed.map((line, i) => (
          <div key={i} style={styles.logLine}>
            <span style={styles.ts}>{line.ts.slice(11, 19)}</span>
            <span style={{ ...styles.stream, color: STREAM_COLORS[line.stream] ?? '#94a3b8' }}>
              [{line.stream}]
            </span>
            <span style={styles.lineText}>{line.line}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { background: '#0a0c13', border: '1px solid #1e2235', borderRadius: 8, overflow: 'hidden' },
  toolbar: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: '#12151e', borderBottom: '1px solid #1e2235' },
  filterInput: { flex: 1, padding: '4px 8px', background: '#0a0c13', border: '1px solid #2d3148', borderRadius: 4, color: '#e2e8f0', fontSize: 12 },
  lineCount: { color: '#475569', fontSize: 11 },
  paused: { color: '#f59e0b', fontSize: 11 },
  toolBtn: { padding: '3px 8px', background: 'transparent', border: '1px solid #2d3148', borderRadius: 4, color: '#64748b', cursor: 'pointer', fontSize: 11 },
  logArea: { overflowY: 'auto', fontFamily: 'monospace', fontSize: 12, padding: '8px 12px' },
  logLine: { display: 'flex', gap: 6, marginBottom: 2, lineHeight: 1.4 },
  ts: { color: '#3d4166', minWidth: 64, flexShrink: 0 },
  stream: { minWidth: 56, flexShrink: 0 },
  lineText: { color: '#94a3b8', wordBreak: 'break-all', whiteSpace: 'pre-wrap' },
};
