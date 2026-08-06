import { AppConfig, Job, BackupInventory, TargetStatus, IntegrityResult, PruneSummary } from './types.js';

let csrfToken: string | null = null;

async function fetchJson<T>(url: string, opts?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts?.headers as Record<string, string> ?? {}),
  };
  if (csrfToken && opts?.method && opts.method !== 'GET') {
    headers['X-CSRF-Token'] = csrfToken;
  }
  const res = await fetch(url, { ...opts, headers, credentials: 'include' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function login(password: string): Promise<void> {
  const r = await fetchJson<{ ok: boolean; csrfToken: string }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
  csrfToken = r.csrfToken;
}

export async function logout(): Promise<void> {
  await fetchJson('/api/auth/logout', { method: 'POST' });
  csrfToken = null;
}

export async function getMe(): Promise<{ authenticated: boolean; csrfToken: string | null }> {
  const r = await fetchJson<{ authenticated: boolean; csrfToken: string | null }>('/api/auth/me');
  if (r.csrfToken) csrfToken = r.csrfToken;
  return r;
}

export async function getConfig(): Promise<AppConfig> {
  return fetchJson<AppConfig>('/api/config');
}

export async function getStatus(): Promise<Record<string, TargetStatus>> {
  return fetchJson<Record<string, TargetStatus>>('/api/status');
}

export async function createJob(targets: string[], operations: string[], options = {}): Promise<{ jobId: string }> {
  return fetchJson<{ jobId: string }>('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({ targets, operations, options }),
  });
}

export async function getJob(id: string): Promise<Job> {
  return fetchJson<Job>(`/api/jobs/${id}`);
}

export async function listJobs(page = 0): Promise<Job[]> {
  return fetchJson<Job[]>(`/api/jobs?page=${page}`);
}

export async function cancelJob(id: string): Promise<void> {
  await fetchJson(`/api/jobs/${id}/cancel`, { method: 'POST', body: '{}' });
}

export interface DeleteJobsResult {
  deleted: string[];
  skipped: { id: string; reason: 'not-found' | 'active' }[];
}

export async function deleteJobs(ids: string[]): Promise<DeleteJobsResult> {
  return fetchJson<DeleteJobsResult>('/api/jobs/delete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
}

export async function submitCredentials(jobId: string, accountKey: string, password: string, otp?: string, otpMethod?: number): Promise<void> {
  await fetchJson(`/api/jobs/${jobId}/credentials`, {
    method: 'POST',
    body: JSON.stringify({ accountKey, password, otp, otpMethod }),
  });
}

export async function submitConfirmation(jobId: string, target: string, decision: 'proceed' | 'skip' | 'abort'): Promise<void> {
  await fetchJson(`/api/jobs/${jobId}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ target, decision }),
  });
}

export async function getBackups(): Promise<BackupInventory> {
  return fetchJson<BackupInventory>('/api/backups');
}

export async function verifyBackups(target?: string): Promise<{ results: IntegrityResult[] }> {
  return fetchJson('/api/backups/verify', {
    method: 'POST',
    body: JSON.stringify({ target }),
  });
}

export async function pruneBackups(opts: { target?: string; keepDaily?: number; keepMonthly?: number; dryRun?: boolean }): Promise<PruneSummary> {
  return fetchJson<PruneSummary>('/api/backups/prune', {
    method: 'POST',
    body: JSON.stringify(opts),
  });
}

export function openJobStream(jobId: string): WebSocket {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${window.location.host}/api/jobs/${jobId}/stream`);
  return ws;
}
