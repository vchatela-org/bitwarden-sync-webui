import React, { useState } from 'react';
import { login } from '../api.js';

interface Props {
  onLogin: () => void;
}

export function Login({ onLogin }: Props) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(password);
      onLogin();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>🔐 Bitwarden Sync</h1>
        <p style={styles.subtitle}>Self-hosted vault synchronisation</p>
        <form onSubmit={handleSubmit}>
          <label style={styles.label}>UI Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={styles.input}
            placeholder="Enter UI password"
            autoFocus
          />
          {error && <div style={styles.error}>{error}</div>}
          <button type="submit" disabled={loading || !password} style={styles.button}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0f1117',
  },
  card: {
    background: '#1a1d27',
    border: '1px solid #2d3148',
    borderRadius: 12,
    padding: '40px 48px',
    width: 360,
    boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
  },
  title: {
    color: '#e2e8f0',
    margin: 0,
    fontSize: 24,
    fontWeight: 700,
  },
  subtitle: {
    color: '#64748b',
    margin: '8px 0 28px',
    fontSize: 14,
  },
  label: {
    display: 'block',
    color: '#94a3b8',
    fontSize: 13,
    marginBottom: 6,
  },
  input: {
    width: '100%',
    padding: '10px 12px',
    background: '#0f1117',
    border: '1px solid #2d3148',
    borderRadius: 6,
    color: '#e2e8f0',
    fontSize: 14,
    boxSizing: 'border-box',
    outline: 'none',
  },
  error: {
    color: '#f87171',
    fontSize: 13,
    marginTop: 8,
  },
  button: {
    marginTop: 16,
    width: '100%',
    padding: '10px',
    background: '#4f46e5',
    border: 'none',
    borderRadius: 6,
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
};
