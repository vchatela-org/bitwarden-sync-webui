import React, { useState } from 'react';
import { CredentialPrompt } from '../types.js';
import { submitCredentials } from '../api.js';

interface Props {
  jobId: string;
  prompt: CredentialPrompt;
  onSubmitted: () => void;
}

const OTP_METHODS = [
  { value: 0, label: 'Authenticator app (TOTP)' },
  { value: 1, label: 'Email' },
  { value: 3, label: 'YubiKey' },
];

export function CredentialModal({ jobId, prompt, onSubmitted }: Props) {
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [otpMethod, setOtpMethod] = useState(prompt.otpMethod ?? 0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await submitCredentials(jobId, prompt.accountKey, password, prompt.needsOtp ? otp : undefined, prompt.needsOtp ? otpMethod : undefined);
      onSubmitted();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.overlay}>
      <div style={styles.modal}>
        <h2 style={styles.title}>🔑 Credentials Required</h2>
        <p style={styles.subtitle}>
          Account: <strong style={{ color: '#60a5fa' }}>{prompt.accountKey}</strong>
          {' '} ({prompt.side === 'cloud' ? '☁️ cloud' : '🏠 home server'})
        </p>
        <form onSubmit={handleSubmit}>
          <label style={styles.label}>Master Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={styles.input}
            placeholder="Vault master password"
            autoFocus
          />
          {prompt.needsOtp && (
            <>
              <label style={styles.label}>Two-step method</label>
              <select
                value={otpMethod}
                onChange={(e) => setOtpMethod(parseInt(e.target.value))}
                style={styles.input}
              >
                {OTP_METHODS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
              <label style={styles.label}>OTP Code</label>
              <input
                type="text"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                style={styles.input}
                placeholder="6-digit code"
                maxLength={10}
                pattern="[0-9a-zA-Z]+"
              />
            </>
          )}
          {error && <div style={styles.error}>{error}</div>}
          <div style={styles.buttons}>
            <button type="submit" disabled={loading || !password || (prompt.needsOtp && !otp)} style={styles.btnPrimary}>
              {loading ? 'Submitting…' : 'Submit'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.7)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    background: '#1a1d27',
    border: '1px solid #2d3148',
    borderRadius: 12,
    padding: '32px 40px',
    width: 400,
    boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
  },
  title: { color: '#e2e8f0', margin: 0, fontSize: 20 },
  subtitle: { color: '#94a3b8', fontSize: 13, margin: '10px 0 20px' },
  label: { display: 'block', color: '#94a3b8', fontSize: 13, marginBottom: 6, marginTop: 12 },
  input: {
    width: '100%',
    padding: '9px 12px',
    background: '#0f1117',
    border: '1px solid #2d3148',
    borderRadius: 6,
    color: '#e2e8f0',
    fontSize: 14,
    boxSizing: 'border-box',
  },
  error: { color: '#f87171', fontSize: 13, marginTop: 8 },
  buttons: { marginTop: 20, display: 'flex', gap: 8, justifyContent: 'flex-end' },
  btnPrimary: {
    padding: '9px 20px',
    background: '#4f46e5',
    border: 'none',
    borderRadius: 6,
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
};
