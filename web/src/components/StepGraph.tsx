import React from 'react';
import { Step, StepState } from '../types.js';

interface Props {
  steps: Step[];
  onSelectStep?: (stepId: string) => void;
  selectedStep?: string;
}

const STATE_COLORS: Record<StepState, string> = {
  pending: '#475569',
  running: '#3b82f6',
  succeeded: '#22c55e',
  failed: '#ef4444',
  skipped: '#64748b',
  warning: '#f59e0b',
  'awaiting-input': '#8b5cf6',
};

const STATE_ICONS: Record<StepState, string> = {
  pending: '○',
  running: '⟳',
  succeeded: '✓',
  failed: '✗',
  skipped: '—',
  warning: '⚠',
  'awaiting-input': '⏸',
};

export function StepGraph({ steps, onSelectStep, selectedStep }: Props) {
  // Group steps by account group
  const groups = new Map<string, Step[]>();
  for (const step of steps) {
    if (!groups.has(step.group)) groups.set(step.group, []);
    groups.get(step.group)!.push(step);
  }

  return (
    <div style={styles.container}>
      {[...groups.entries()].map(([group, groupSteps]) => (
        <div key={group} style={styles.group}>
          <div style={styles.groupLabel}>{group}</div>
          <div style={styles.stepList}>
            {groupSteps.map((step) => {
              const color = STATE_COLORS[step.state];
              const icon = STATE_ICONS[step.state];
              const isSelected = selectedStep === step.id;
              const isRunning = step.state === 'running';
              return (
                <div
                  key={step.id}
                  style={{
                    ...styles.stepNode,
                    borderColor: color,
                    background: isSelected ? '#1e2235' : '#12151e',
                    cursor: onSelectStep ? 'pointer' : 'default',
                  }}
                  onClick={() => onSelectStep?.(step.id)}
                >
                  <span style={{ color, fontSize: 14, fontWeight: 700, animation: isRunning ? 'spin 1s linear infinite' : undefined }}>
                    {icon}
                  </span>
                  <div style={styles.stepLabel}>{step.label}</div>
                  {step.detail && (
                    <div style={styles.stepDetail}>{step.detail.slice(0, 80)}</div>
                  )}
                  {step.startedAt && step.endedAt && (
                    <div style={styles.stepDuration}>
                      {Math.round((new Date(step.endedAt).getTime() - new Date(step.startedAt).getTime()) / 1000)}s
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: '16px 0', overflowX: 'auto' },
  group: { marginBottom: 16 },
  groupLabel: { color: '#64748b', fontSize: 12, fontWeight: 600, marginBottom: 8, paddingLeft: 4 },
  stepList: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  stepNode: {
    border: '1px solid',
    borderRadius: 6,
    padding: '6px 10px',
    minWidth: 140,
    maxWidth: 200,
    fontSize: 11,
  },
  stepLabel: { color: '#cbd5e1', marginTop: 2, fontSize: 11, lineHeight: 1.3 },
  stepDetail: { color: '#94a3b8', fontSize: 10, marginTop: 2, wordBreak: 'break-all' },
  stepDuration: { color: '#475569', fontSize: 10, marginTop: 2 },
};
