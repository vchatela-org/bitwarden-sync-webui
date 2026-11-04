import { useEffect, useState } from 'react';
import { Job } from '../types.js';
import { listJobs } from '../api.js';
import { CredentialModal } from './CredentialModal.js';
import { ConfirmModal } from './ConfirmModal.js';
import { isActive } from '../lib/status.js';

interface Props {
  /** When true, redact account/target labels — for taking screenshots. */
  masked?: boolean;
}

/**
 * How often the app looks for a prompt it should put in front of the user. The prompt itself
 * is only ever sent over a job's own stream, so a user who started a run and then went back to
 * the dashboard (or opened the jobs list, or another job) would never see it: the run then sat
 * unanswered until its timeout, holding the single runner slot and queueing everything behind
 * it. Polling the list gives every page the same view of "someone needs to type a password".
 */
const POLL_MS = 5000;

/** The one active job currently asking a question, if any. */
async function findPromptedJob(): Promise<Job | null> {
  const jobs = await listJobs();
  return jobs.find((job) => isActive(job.state) && job.prompt) ?? null;
}

export function GlobalPrompt({ masked }: Props) {
  const [job, setJob] = useState<Job | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const next = await findPromptedJob();
        if (!cancelled) setJob(next);
      } catch {
        // Keep the last answer: an unreadable poll is not a reason to drop a modal the
        // user is filling in. The next tick retries.
      }
    }

    void poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // The prompt is cleared server-side the moment it is answered, so hiding it locally keeps
  // the modal from lingering for up to one poll; a re-prompt for a wrong password arrives on
  // a later tick and reopens it.
  function handleSubmitted() {
    setJob((prev) => (prev ? { ...prev, prompt: undefined } : prev));
  }

  const prompt = job?.prompt;
  if (!job || !prompt) return null;

  if (prompt.kind === 'confirmation') {
    return <ConfirmModal jobId={job.id} prompt={prompt} onSubmitted={handleSubmitted} masked={masked} />;
  }
  return <CredentialModal jobId={job.id} prompt={prompt} onSubmitted={handleSubmitted} masked={masked} />;
}
