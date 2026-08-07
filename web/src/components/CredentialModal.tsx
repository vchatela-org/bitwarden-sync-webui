import React, { useState } from 'react';
import { KeyRound, Server, AlertCircle } from 'lucide-react';
import { CredentialPrompt } from '../types.js';
import { submitCredentials, cancelJob } from '../api.js';
import { Modal } from './ui/Modal.js';
import { Button } from './ui/Button.js';
import { Input, Select, Field, Alert } from './ui/Input.js';
import { CheckboxField } from './ui/Checkbox.js';
import { maskValue } from '../lib/mask.js';

interface Props {
  jobId: string;
  prompt: CredentialPrompt;
  onSubmitted: () => void;
  /** When true, redact the account/target labels — for taking screenshots. */
  masked?: boolean;
}

const OTP_METHODS = [
  { value: 0, label: 'Authenticator app (TOTP)' },
  { value: 1, label: 'Email' },
  { value: 3, label: 'YubiKey' },
];

export function CredentialModal({ jobId, prompt, onSubmitted, masked }: Props) {
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [otpMethod, setOtpMethod] = useState(prompt.otpMethod ?? 0);
  const [shared, setShared] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  async function handleCancel() {
    setError('');
    setCancelling(true);
    try {
      await cancelJob(jobId);
      onSubmitted();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to cancel job');
      setCancelling(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await submitCredentials(
        jobId,
        prompt.accountKey,
        password,
        prompt.needsOtp ? otp : undefined,
        prompt.needsOtp ? otpMethod : undefined,
        shared,
      );
      onSubmitted();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to submit credentials';
      if (/no pending credential prompt|not awaiting credentials/i.test(message)) {
        // The job already moved past this prompt (e.g. stale state after a reload) —
        // there's nothing left to submit, so just close the modal instead of dead-ending the user.
        onSubmitted();
        return;
      }
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  const formId = `credential-form-${jobId}`;
  const canSubmit = !!password && (!prompt.needsOtp || !!otp);

  return (
    <Modal
      open
      icon={<KeyRound />}
      title="Credentials required"
      description={
        <span className="inline-flex flex-wrap items-center gap-1.5">
          Unlocking
          <strong className="font-medium text-fg">{masked ? maskValue(prompt.accountKey) : prompt.accountKey}</strong>
          on
          <span className="inline-flex items-center gap-1 rounded-md border border-line bg-elevated px-1.5 py-px text-[11px] text-fg-muted">
            <Server className="size-3 text-fg-muted" />
            {prompt.vaultName}
          </span>
          {prompt.targets && prompt.targets.length > 0 && (
            <span className="w-full text-[11px] text-fg-faint">
              Covers: {masked ? prompt.targets.map(maskValue).join(', ') : prompt.targets.join(', ')}
            </span>
          )}
        </span>
      }
      footer={
        <>
          <Button
            variant="dangerSoft"
            onClick={handleCancel}
            loading={cancelling}
            disabled={loading}
          >
            Cancel job
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            loading={loading}
            disabled={!canSubmit || cancelling}
          >
            {loading ? 'Unlocking…' : 'Unlock vault'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit} className="space-y-3.5 pb-4">
        <Field label="Master password" htmlFor="master-password">
          <Input
            id="master-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Vault master password"
            autoFocus
            autoComplete="off"
          />
        </Field>

        <CheckboxField
          checked={shared}
          onCheckedChange={setShared}
          label={`Use this password for ${masked ? maskValue(prompt.accountKey) : prompt.accountKey}'s other vaults too`}
        />

        {prompt.needsOtp && (
          <>
            <Field label="Two-step method" htmlFor="otp-method">
              <Select
                id="otp-method"
                value={otpMethod}
                onChange={(e) => setOtpMethod(parseInt(e.target.value))}
              >
                {OTP_METHODS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </Select>
            </Field>

            <Field label="Verification code" htmlFor="otp-code">
              <Input
                id="otp-code"
                type="text"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                placeholder="000000"
                maxLength={10}
                pattern="[0-9a-zA-Z]+"
                inputMode="numeric"
                autoComplete="one-time-code"
                className="font-mono tracking-[0.3em]"
              />
            </Field>
          </>
        )}

        {error && <Alert icon={<AlertCircle />}>{error}</Alert>}

        <p className="text-[11px] leading-relaxed text-fg-faint">
          Sent directly to the Bitwarden CLI for this job only — never written to disk or logs.
        </p>
      </form>
    </Modal>
  );
}
