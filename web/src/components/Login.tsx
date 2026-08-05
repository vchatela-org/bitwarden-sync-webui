import React, { useState } from 'react';
import { ShieldCheck, AlertCircle, ArrowRight } from 'lucide-react';
import { login } from '../api.js';
import { Button } from './ui/Button.js';
import { Input, Field, Alert } from './ui/Input.js';

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
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4">
      {/* Ambient accent glow behind the card */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 size-[36rem] -translate-x-1/2 -translate-y-[60%] rounded-full opacity-50 blur-[120px]"
        style={{
          background:
            'radial-gradient(circle, var(--color-accent) 0%, transparent 65%)',
        }}
      />

      <div className="relative w-full max-w-sm animate-rise">
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="mb-4 flex size-12 items-center justify-center rounded-2xl border border-accent-line bg-accent-soft shadow-pop">
            <ShieldCheck className="size-6 text-accent" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-fg">Bitwarden Sync</h1>
          <p className="mt-1.5 text-[13px] text-fg-subtle">Self-hosted vault synchronisation</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-2xl border border-line bg-surface p-6 shadow-modal"
        >
          <Field label="UI password" htmlFor="ui-password">
            <Input
              id="ui-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              autoFocus
              autoComplete="current-password"
              invalid={!!error}
            />
          </Field>

          {error && <Alert icon={<AlertCircle />}>{error}</Alert>}

          <Button
            type="submit"
            variant="primary"
            disabled={!password}
            loading={loading}
            className="h-9.5 w-full justify-center text-sm"
          >
            {loading ? 'Signing in…' : 'Sign in'}
            {!loading && <ArrowRight className="size-3.5" />}
          </Button>
        </form>

        <p className="mt-5 text-center text-[11px] text-fg-faint">
          Vault master passwords are never stored — they are requested per job.
        </p>
      </div>
    </div>
  );
}
