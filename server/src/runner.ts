import { randomUUID } from 'crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import {
  Config,
  accountByKey,
  counterpartAccounts,
  groupSyncsByAccount,
  logoutAfterImport,
  profileDir,
  syncByKey,
  syncKind,
  syncOrgId,
  vaultOfAccount,
} from './config.js';
import { bwInit, lockProfile, logoutProfile, listItems, listOrgCollections, InitResult } from './session.js';
import { cachePassword, getPassword, clearAllPasswords } from './secrets.js';
import { purgeVault } from './purge.js';
import { reconcileOrgCollections } from './collections.js';
import { computeDiff, evaluateGuard, toDiffItem, computeSecureDiff, DiffResult, DiffItem, SecureDiffResult } from './diff.js';
import { findNewestExport, countExportItems, BackupMeta, buildBackupFilename } from './backups.js';
import { runBw, LogCallback, getCliVersion } from './bwCli.js';
import { redact, clearAllSecrets } from './redact.js';
import { recordLiveCount } from './liveCounts.js';
import { createHash } from 'crypto';
import { statSync } from 'fs';

export type JobOperation = 'backup' | 'import' | 'both' | 'status' | 'diff' | 'count';
export type JobState = 'queued' | 'running' | 'awaiting-credentials' | 'awaiting-confirmation' | 'succeeded' | 'failed' | 'partial' | 'aborted';
export type StepState = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'warning' | 'awaiting-input';

/** Job states the runner can still move out of on its own — can be cancelled, can't be deleted. */
const ACTIVE_JOB_STATES: JobState[] = ['queued', 'running', 'awaiting-credentials', 'awaiting-confirmation'];

export interface Step {
  id: string;
  label: string;
  state: StepState;
  startedAt?: string;
  endedAt?: string;
  detail?: string;
  group: string; // account key
}

export interface LogLine {
  ts: string;
  stream: 'stdout' | 'stderr' | 'app';
  step?: string;
  line: string;
}

export interface CredentialPrompt {
  kind: 'credentials';
  /** The account being unlocked — one identity on one vault, and the password-cache key. */
  accountKey: string;
  accountEmail: string;
  displayName?: string;
  /** Sync keys this one login covers. */
  targets: string[];
  vaultKey: string;
  vaultName: string;
  needsOtp: boolean;
  otpMethod?: number;
  /**
   * True when the code field is showing because the account is configured `otp: "required"`
   * rather than because a login already came back asking for one.
   */
  otpHinted?: boolean;
  /** The other endpoint accounts of `targets`, offered as "reuse this password for …". */
  counterparts: string[];
}

export interface ConfirmationPrompt {
  kind: 'confirmation';
  target: string;
  diff: DiffResult;
}

export type Prompt = CredentialPrompt | ConfirmationPrompt;

/** A single fresh reading of one side of one target, pushed to clients as the job takes it. */
export interface LiveCountUpdate {
  target: string;
  role: 'source' | 'dest';
  count: number;
  /** When the reading was taken, ISO — the same stamp the persisted store holds. */
  at: string;
}

export interface Job {
  id: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  state: JobState;
  targets: string[];
  operations: JobOperation[];
  options: JobOptions;
  steps: Step[];
  logs: LogLine[];
  prompt?: Prompt;
  results?: Record<string, { source?: number; dest?: number }>;
  secureDiffResults?: Record<string, SecureDiffResult>;
}

export interface JobOptions {
  dryRunDiff?: boolean;
  confirmTimeout?: number; // ms, default 30 min
}

const CONFIRM_TIMEOUT_DEFAULT_MS = 30 * 60 * 1000;
const CONFIRM_TIMEOUT_MIN_MS = 1000;
const CONFIRM_TIMEOUT_MAX_MS = 24 * 60 * 60 * 1000;

// job.options comes straight from the job-creation API body, so clamp it before
// handing it to setTimeout: unclamped it's an unbounded-resource-hold vector, and
// Node's timer delay silently overflows (fires ~immediately) past 2^31-1 ms.
function confirmTimeoutMs(options: JobOptions): number {
  const requested = options.confirmTimeout ?? CONFIRM_TIMEOUT_DEFAULT_MS;
  if (requested < CONFIRM_TIMEOUT_MIN_MS) return CONFIRM_TIMEOUT_MIN_MS;
  if (requested > CONFIRM_TIMEOUT_MAX_MS) return CONFIRM_TIMEOUT_MAX_MS;
  return requested;
}

// In-memory state
const jobs = new Map<string, Job>();
const jobOrder: string[] = [];
const MAX_JOBS = 50;
let activeJobId: string | null = null;
const queue: string[] = [];

const DATA_DIR = process.env['DATA_DIR'] ?? '/data';
const JOBS_DIR = join(DATA_DIR, 'jobs');

// EventEmitter-like callbacks for WebSocket streaming
type JobEvent = 'log' | 'step' | 'job' | 'prompt' | 'counts';
type JobUpdateCallback = (jobId: string, event: JobEvent, data: unknown) => void;
const listeners = new Set<JobUpdateCallback>();

export function addJobListener(cb: JobUpdateCallback): void {
  listeners.add(cb);
}

export function removeJobListener(cb: JobUpdateCallback): void {
  listeners.delete(cb);
}

function emit(jobId: string, event: JobEvent, data: unknown): void {
  for (const cb of listeners) {
    try { cb(jobId, event, data); } catch { /* ignore */ }
  }
}

/**
 * Files a count this job actually observed in a vault: onto the job's own results, into the
 * persisted live-count store, and out to connected clients. Every phase that lists a vault
 * goes through here — the backup's sidecar listing of the source and the import's post-import
 * verify of the destination are live readings just as much as a 'count' job's are, and the
 * dashboard should not need a separate count run to catch up with them.
 */
function recordCount(job: Job, target: string, role: 'source' | 'dest', count: number): void {
  const at = recordLiveCount(target, role, count);
  job.results = job.results ?? {};
  job.results[target] = { ...job.results[target], [role]: count };
  const update: LiveCountUpdate = { target, role, count, at };
  emit(job.id, 'counts', update);
}

function persistJob(job: Job): void {
  try {
    mkdirSync(JOBS_DIR, { recursive: true });
    const safe: Job = { ...job, logs: job.logs.map((l) => ({ ...l, line: redact(l.line) })) };
    writeFileSync(join(JOBS_DIR, `${job.id}.json`), JSON.stringify(safe, null, 2));
  } catch { /* best-effort */ }
}

export function loadPersistedJobs(): void {
  try {
    mkdirSync(JOBS_DIR, { recursive: true });
    const files = readdirSync(JOBS_DIR).filter((f) => f.endsWith('.json')).sort();
    for (const f of files.slice(-MAX_JOBS)) {
      try {
        const j = JSON.parse(readFileSync(join(JOBS_DIR, f), 'utf-8')) as Job;
        jobs.set(j.id, j);
        if (!jobOrder.includes(j.id)) jobOrder.push(j.id);
      } catch { /* ignore corrupt */ }
    }
  } catch { /* ignore */ }
}

/**
 * Step a job is currently executing, by job id. Every log line emitted while a step is running is
 * tagged with it so the UI can filter the terminal down to one step. A step becomes current when it
 * goes 'running' and stops being current when it reaches a terminal state, so lines produced between
 * steps (account headers, job-level errors) stay untagged.
 */
const currentStep = new Map<string, string>();

const TERMINAL_STEP_STATES = ['succeeded', 'failed', 'skipped', 'warning'];
const TERMINAL_JOB_STATES: JobState[] = ['succeeded', 'failed', 'partial', 'aborted'];

function addLog(job: Job, stream: 'stdout' | 'stderr' | 'app', line: string, step?: string): void {
  const entry: LogLine = {
    ts: new Date().toISOString(),
    stream,
    step: step ?? currentStep.get(job.id),
    line: redact(line),
  };
  job.logs.push(entry);
  emit(job.id, 'log', entry);
}

function applyStep(job: Job, stepId: string, update: Partial<Step>): void {
  const step = job.steps.find((s) => s.id === stepId);
  if (!step) return;
  Object.assign(step, update);
  if (update.state === 'running') {
    step.startedAt = new Date().toISOString();
    currentStep.set(job.id, stepId);
  }
  if (TERMINAL_STEP_STATES.includes(update.state ?? '')) {
    step.endedAt = new Date().toISOString();
    // Only the running step clears the marker: bulk 'skipped' updates for downstream steps
    // must not detach logs from whichever step is still executing.
    if (currentStep.get(job.id) === stepId) currentStep.delete(job.id);
  }
  emit(job.id, 'step', step);
}

function updateStep(job: Job, stepId: string, update: Partial<Step>): void {
  // Cancellation settles every unfinished step at once, but the work itself only unwinds at
  // the next checkpoint. Until it does, its in-flight `bw` calls keep reporting results —
  // ignore them, or a cancelled job's step list drifts back to running/succeeded and the UI
  // shows spinners under an "Aborted" badge.
  if (TERMINAL_JOB_STATES.includes(job.state)) return;
  applyStep(job, stepId, update);
}

/**
 * Settles every step that hasn't finished, for a job that is going no further. Bypasses the
 * terminal-state guard in updateStep — this is the call that establishes that final state.
 */
function markRemainingSkipped(job: Job, detail: string): void {
  for (const step of job.steps) {
    if (step.state === 'pending' || step.state === 'running' || step.state === 'awaiting-input') {
      applyStep(job, step.id, { state: 'skipped', detail });
    }
  }
  currentStep.delete(job.id);
}

function updateJobState(job: Job, state: JobState): void {
  // Never transition out of a terminal state — once a job is aborted, succeeded,
  // failed, or partial, no other code path should resurrect it.
  if (TERMINAL_JOB_STATES.includes(job.state)) return;
  job.state = state;
  if (state === 'running' && !job.startedAt) job.startedAt = new Date().toISOString();
  if (TERMINAL_JOB_STATES.includes(state)) {
    job.endedAt = new Date().toISOString();
  }
  emit(job.id, 'job', { state });
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(page = 0, pageSize = 20): Job[] {
  const all = jobOrder.map((id) => jobs.get(id)!).filter(Boolean).reverse();
  return all.slice(page * pageSize, (page + 1) * pageSize);
}

export function createJob(targets: string[], operations: JobOperation[], options: JobOptions, config: Config): Job {
  const id = randomUUID();
  const job: Job = {
    id,
    createdAt: new Date().toISOString(),
    state: 'queued',
    targets,
    operations,
    options,
    steps: buildSteps(targets, operations, config),
    logs: [],
  };
  jobs.set(id, job);
  jobOrder.push(id);
  if (jobOrder.length > MAX_JOBS) {
    const oldest = jobOrder.shift()!;
    jobs.delete(oldest);
  }
  persistJob(job);
  emit(id, 'job', { state: 'queued', id });

  // Enqueue
  if (!activeJobId) {
    runJobAsync(id, config);
  } else {
    queue.push(id);
    addLog(job, 'app', `Job queued (position ${queue.length})`);
    persistJob(job);
  }

  return job;
}

/**
 * Steps are grouped by source account: one group is everything a single login on the source
 * side covers (a personal sync plus any org syncs exported from the same account). The
 * destination side can fan out — two syncs from one source account may land on different
 * destination accounts — so import and count-dest sub-group by destination account.
 */
function buildSteps(targets: string[], ops: JobOperation[], config: Config): Step[] {
  const steps: Step[] = [];
  const doBackup = ops.includes('backup') || ops.includes('both');
  const doImport = ops.includes('import') || ops.includes('both');
  const doCount = ops.includes('count');
  const doDiff = ops.includes('diff');

  const vaultNameOf = (accountKey: string): string => vaultOfAccount(config, accountKey).name;

  for (const [srcAccount, groupSyncs] of groupSyncsByAccount(targets, config, 'from')) {
    const g = srcAccount;
    if (doBackup) {
      const vaultName = vaultNameOf(srcAccount);
      steps.push({ id: `${g}:backup:login`, label: `[${srcAccount}] ${vaultName} login`, state: 'pending', group: g });
      steps.push({ id: `${g}:backup:sync`, label: `[${srcAccount}] ${vaultName} sync`, state: 'pending', group: g });
      for (const t of groupSyncs) {
        steps.push({ id: `${g}:export:${t}:encrypted`, label: `[${t}] Export encrypted`, state: 'pending', group: g });
        steps.push({ id: `${g}:export:${t}:pass`, label: `[${t}] Export password-protected`, state: 'pending', group: g });
        steps.push({ id: `${g}:export:${t}:meta`, label: `[${t}] Write sidecar metadata`, state: 'pending', group: g });
      }
      steps.push({ id: `${g}:backup:lock`, label: `[${srcAccount}] ${vaultName} lock`, state: 'pending', group: g });
    }
    if (doImport) {
      for (const [destAccount, dSyncs] of groupSyncsByAccount(groupSyncs, config, 'to')) {
        const vaultName = vaultNameOf(destAccount);
        const d = destAccount;
        steps.push({ id: `${g}:import:${d}:login`, label: `[${d}] ${vaultName} login`, state: 'pending', group: g });
        steps.push({ id: `${g}:import:${d}:sync`, label: `[${d}] ${vaultName} sync`, state: 'pending', group: g });
        for (const t of dSyncs) {
          steps.push({ id: `${g}:import:${t}:resolveFile`, label: `[${t}] Resolve backup file`, state: 'pending', group: g });
          steps.push({ id: `${g}:import:${t}:diff`, label: `[${t}] Pre-import diff`, state: 'pending', group: g });
          steps.push({ id: `${g}:import:${t}:purge`, label: `[${t}] Purge destination vault`, state: 'pending', group: g });
          steps.push({ id: `${g}:import:${t}:run`, label: `[${t}] Import`, state: 'pending', group: g });
          steps.push({ id: `${g}:import:${t}:verify`, label: `[${t}] Verify import`, state: 'pending', group: g });
          if (syncByKey(config, t).org) {
            steps.push({ id: `${g}:import:${t}:reconcile`, label: `[${t}] Reconcile org collections`, state: 'pending', group: g });
          }
        }
        steps.push({ id: `${g}:import:${d}:lock`, label: `[${d}] ${vaultName} lock`, state: 'pending', group: g });
        if (logoutAfterImport(config, accountByKey(config, destAccount).vault)) {
          steps.push({ id: `${g}:import:${d}:logout`, label: `[${d}] ${vaultName} logout`, state: 'pending', group: g });
        }
      }
    }
    if (doCount) {
      for (const role of ['source', 'dest'] as const) {
        const byAccount = groupSyncsByAccount(groupSyncs, config, role === 'source' ? 'from' : 'to');
        for (const [account, aSyncs] of byAccount) {
          const vaultName = vaultNameOf(account);
          const a = account;
          steps.push({ id: `${g}:count:${role}:${a}:login`, label: `[${a}] ${vaultName} login`, state: 'pending', group: g });
          steps.push({ id: `${g}:count:${role}:${a}:sync`, label: `[${a}] ${vaultName} sync`, state: 'pending', group: g });
          for (const t of aSyncs) {
            steps.push({ id: `${g}:count:${role}:${a}:${t}`, label: `[${t}] Count ${role} items`, state: 'pending', group: g });
          }
          steps.push({ id: `${g}:count:${role}:${a}:lock`, label: `[${a}] ${vaultName} lock`, state: 'pending', group: g });
        }
      }
    }
    if (doDiff) {
      // Source snapshot
      const srcVaultName = vaultNameOf(srcAccount);
      steps.push({ id: `${g}:diff:src:login`, label: `[${srcAccount}] ${srcVaultName} login`, state: 'pending', group: g });
      steps.push({ id: `${g}:diff:src:sync`, label: `[${srcAccount}] ${srcVaultName} sync`, state: 'pending', group: g });
      for (const t of groupSyncs) {
        steps.push({ id: `${g}:diff:src:${t}`, label: `[${t}] Snapshot source`, state: 'pending', group: g });
      }
      steps.push({ id: `${g}:diff:src:lock`, label: `[${srcAccount}] ${srcVaultName} lock`, state: 'pending', group: g });
      // Destination snapshot + compare (may span multiple dest accounts)
      for (const [destAccount, dSyncs] of groupSyncsByAccount(groupSyncs, config, 'to')) {
        const dstVaultName = vaultNameOf(destAccount);
        const d = destAccount;
        steps.push({ id: `${g}:diff:dst:${d}:login`, label: `[${d}] ${dstVaultName} login`, state: 'pending', group: g });
        steps.push({ id: `${g}:diff:dst:${d}:sync`, label: `[${d}] ${dstVaultName} sync`, state: 'pending', group: g });
        for (const t of dSyncs) {
          steps.push({ id: `${g}:diff:dst:${d}:${t}`, label: `[${t}] Snapshot destination`, state: 'pending', group: g });
          steps.push({ id: `${g}:diff:compare:${t}`, label: `[${t}] Compare (hashed)`, state: 'pending', group: g });
        }
        steps.push({ id: `${g}:diff:dst:${d}:lock`, label: `[${d}] ${dstVaultName} lock`, state: 'pending', group: g });
      }
    }
  }
  return steps;
}

// Pending credential/confirmation resolvers
const credentialResolvers = new Map<string, (pw: string, otp?: string, otpMethod?: number) => void>();
const confirmationResolvers = new Map<string, (decision: 'proceed' | 'skip' | 'abort') => void>();

function clearPrompt(job: Job): void {
  if (!job.prompt) return;
  job.prompt = undefined;
  emit(job.id, 'prompt', null);
  persistJob(job);
}

/**
 * Caches the password under the prompted account's own key. With `reuseForCounterparts`, it is
 * also cached for the other endpoint accounts of the syncs this prompt covers — the common case
 * of one person using the same master password on both sides, without the config having to
 * assert that two accounts share a secret.
 */
export function submitCredentials(
  jobId: string,
  accountKey: string,
  password: string,
  otp?: string,
  otpMethod?: number,
  reuseForCounterparts = false,
): boolean {
  const resolver = credentialResolvers.get(`${jobId}:${accountKey}`);
  if (typeof resolver !== 'function') return false;
  const job = jobs.get(jobId);
  cachePassword(accountKey, password);
  if (reuseForCounterparts && job?.prompt?.kind === 'credentials') {
    for (const other of job.prompt.counterparts) cachePassword(other, password);
  }
  if (job) clearPrompt(job);
  resolver(password, otp, otpMethod);
  return true;
}

export function submitConfirmation(jobId: string, target: string, decision: 'proceed' | 'skip' | 'abort'): boolean {
  const resolver = confirmationResolvers.get(`${jobId}:${target}`);
  if (typeof resolver !== 'function') return false;
  const job = jobs.get(jobId);
  if (job) clearPrompt(job);
  resolver(decision);
  return true;
}

export function cancelJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job) return false;
  if (!ACTIVE_JOB_STATES.includes(job.state)) return false;
  // Settle the steps first: markRemainingSkipped has to run while the job is still active,
  // and it is what stops the UI spinning the moment Cancel is pressed. The runner keeps
  // going until its next checkpoint, but updateStep ignores it from here on.
  markRemainingSkipped(job, 'Cancelled');
  updateJobState(job, 'aborted');
  clearPrompt(job);
  // Wake any pending resolvers
  for (const [k, res] of credentialResolvers) {
    if (k.startsWith(jobId + ':')) { res('', undefined, undefined); credentialResolvers.delete(k); }
  }
  for (const [k, res] of confirmationResolvers) {
    if (k.startsWith(jobId + ':')) { res('abort'); confirmationResolvers.delete(k); }
  }
  persistJob(job);
  return true;
}

export interface DeleteJobsResult {
  deleted: string[];
  skipped: { id: string; reason: 'not-found' | 'active' }[];
}

/** Removes finished jobs from memory and disk (their log/output record). Active jobs must be cancelled first. */
export function deleteJobs(ids: string[]): DeleteJobsResult {
  const deleted: string[] = [];
  const skipped: DeleteJobsResult['skipped'] = [];

  for (const id of ids) {
    const job = jobs.get(id);
    if (!job) { skipped.push({ id, reason: 'not-found' }); continue; }
    if (ACTIVE_JOB_STATES.includes(job.state)) { skipped.push({ id, reason: 'active' }); continue; }

    jobs.delete(id);
    const idx = jobOrder.indexOf(id);
    if (idx !== -1) jobOrder.splice(idx, 1);
    currentStep.delete(id);
    try { unlinkSync(join(JOBS_DIR, `${id}.json`)); } catch { /* already gone */ }
    deleted.push(id);
  }

  return { deleted, skipped };
}

async function waitForCredentials(
  job: Job,
  config: Config,
  accountKey: string,
  targets: string[],
  needsOtp: boolean,
  otpHinted: boolean,
): Promise<{ password: string; otp?: string; otpMethod?: number }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      credentialResolvers.delete(`${job.id}:${accountKey}`);
      clearPrompt(job);
      reject(new Error(`Credential prompt timed out for ${accountKey}`));
    }, confirmTimeoutMs(job.options));

    credentialResolvers.set(`${job.id}:${accountKey}`, (pw: string, otp?: string, otpMethod?: number) => {
      clearTimeout(timeout);
      credentialResolvers.delete(`${job.id}:${accountKey}`);
      if (!pw) reject(new Error('Job aborted or cancelled'));
      else resolve({ password: pw, otp, otpMethod });
    });

    const account = accountByKey(config, accountKey);
    const vault = vaultOfAccount(config, accountKey);
    const prompt: CredentialPrompt = {
      kind: 'credentials',
      accountKey,
      accountEmail: account.email,
      ...(account.displayName !== undefined ? { displayName: account.displayName } : {}),
      targets,
      vaultKey: vault.key,
      vaultName: vault.name,
      needsOtp,
      ...(account.otpMethod !== undefined ? { otpMethod: account.otpMethod } : {}),
      ...(otpHinted ? { otpHinted: true } : {}),
      counterparts: counterpartAccounts(targets, config, accountKey),
    };
    job.prompt = prompt;
    emit(job.id, 'prompt', prompt);
  });
}

const MAX_CREDENTIAL_ATTEMPTS = 3;

/**
 * Runs bwInit, prompting for credentials (and re-prompting on wrong password/OTP) until it
 * succeeds or MAX_CREDENTIAL_ATTEMPTS is exhausted. Each bwInit() call is independent and always
 * starts its own internal attempt count at 1, so the attempt limit has to be tracked here across
 * calls rather than inside bwInit itself.
 */
async function loginWithRetry(opts: {
  job: Job;
  config: Config;
  account: string;
  groupTargets: string[];
  stepId: string;
  log: LogCallback;
}): Promise<InitResult> {
  const { job, config, account, groupTargets, stepId, log } = opts;
  const accountCfg = accountByKey(config, account);
  const vault = vaultOfAccount(config, account);
  const initOpts = {
    accountKey: account,
    profileLabel: `${account}@${vault.key}`,
    email: accountCfg.email,
    wantServer: vault.serverUrl,
    profileDir: profileDir(config.bitwardenConfigDir, account),
    otpRequired: accountCfg.otp === 'required',
    log,
  };
  let result = await bwInit(initOpts);

  // Each iteration here is one credential prompt shown to the user, so this caps the
  // number of prompts (not "wrong password" retries) at MAX_CREDENTIAL_ATTEMPTS.
  for (
    let attempt = 1;
    attempt <= MAX_CREDENTIAL_ATTEMPTS && result.ok === false && (result.reason === 'needs-password' || result.reason === 'needs-otp');
    attempt++
  ) {
    if ((job.state as string) === 'aborted') throw new Error('Job aborted or cancelled');
    updateJobState(job, 'awaiting-credentials');
    updateStep(job, stepId, { state: 'awaiting-input' });
    // A code is asked for either because a login attempt came back wanting one, or because
    // the account is configured as needing one and this profile is headed for a full login —
    // the latter is what saves the user a second trip through the modal.
    const hinted = result.reason === 'needs-password' && result.otpExpected === true;
    const creds = await waitForCredentials(job, config, account, groupTargets, result.reason === 'needs-otp' || hinted, hinted);
    result = await bwInit({
      ...initOpts,
      ...(creds.otp !== undefined ? { otp: creds.otp } : {}),
      ...(creds.otpMethod !== undefined ? { otpMethod: creds.otpMethod } : {}),
    });
    updateJobState(job, 'running');
    updateStep(job, stepId, { state: 'running' });
  }

  if (!result.ok && (result.reason === 'needs-password' || result.reason === 'needs-otp')) {
    result = { ok: false, reason: 'max-attempts', message: `Failed after ${MAX_CREDENTIAL_ATTEMPTS} attempts` };
  }

  updateStep(job, stepId, result.ok
    ? { state: 'succeeded' }
    : { state: 'failed', detail: result.message });
  return result;
}

async function waitForConfirmation(job: Job, target: string, diff: DiffResult): Promise<'proceed' | 'skip' | 'abort'> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      confirmationResolvers.delete(`${job.id}:${target}`);
      clearPrompt(job);
      reject(new Error(`Confirmation timed out for ${target}`));
    }, confirmTimeoutMs(job.options));

    confirmationResolvers.set(`${job.id}:${target}`, (decision: string) => {
      clearTimeout(timeout);
      confirmationResolvers.delete(`${job.id}:${target}`);
      resolve(decision as 'proceed' | 'skip' | 'abort');
    });

    const prompt: ConfirmationPrompt = { kind: 'confirmation', target, diff };
    job.prompt = prompt;
    emit(job.id, 'prompt', prompt);
  });
}

async function runJobAsync(jobId: string, config: Config): Promise<void> {
  activeJobId = jobId;
  const job = jobs.get(jobId)!;
  updateJobState(job, 'running');

  const log: LogCallback = (stream, line) => {
    addLog(job, stream as 'stdout' | 'stderr' | 'app', line);
  };

  const cliVer = await getCliVersion().catch(() => 'unknown');
  addLog(job, 'app', `bw CLI version: ${cliVer}`);

  const doBackup = job.operations.includes('backup') || job.operations.includes('both');
  const doImport = job.operations.includes('import') || job.operations.includes('both');
  const doCount = job.operations.includes('count');
  const doDiff = job.operations.includes('diff');

  const backupFiles = new Map<string, string>(); // sync key → path
  /**
   * sync key → what the source vault held when it was exported this run. Listed once
   * for the sidecar and kept so the import guard can diff against it after the source
   * profile has been locked, instead of treating every source as an unknown.
   */
  const sourceItems = new Map<string, DiffItem[]>();
  const backupFailed = new Set<string>();
  let anyFailed = false;

  /**
   * Cancellation is cooperative: cancelJob() flips the state, and the phases below unwind at
   * the next call to this. Nothing interrupts an in-flight `bw` child — a half-written
   * `import` or `edit item` would leave the destination vault in a state no later run could
   * reason about — so the worst-case wait is one command's timeout.
   */
  const aborted = (): boolean => (job.state as string) === 'aborted';

  /** Marks every still-unfinished step matching a prefix, e.g. after a login failure. */
  const skipPending = (prefix: string, detail: string): void => {
    for (const s of job.steps) {
      if (s.id.startsWith(prefix) && (s.state === 'pending' || s.state === 'running')) {
        updateStep(job, s.id, { state: 'skipped', detail });
      }
    }
  };

  try {
    // One iteration per source account: a single `bw login` on the source side, covering that
    // account's personal sync plus any org syncs exported through it.
    for (const [srcAccount, groupSyncs] of groupSyncsByAccount(job.targets, config, 'from')) {
      if (aborted()) break;
      const srcCfg = accountByKey(config, srcAccount);
      const srcVault = vaultOfAccount(config, srcAccount);
      addLog(job, 'app', `\n====== ${srcAccount} (${srcCfg.email}) on ${srcVault.name} — syncs: ${groupSyncs.join(', ')} ======`);

      // 14 chars, not 15: '2026-08-07T12:24:05.420Z' → '20260807122405' → '20260807_122405'.
      // Slicing 15 kept the '.' before the milliseconds, and the trailing dot it left in
      // every filename made parseBackupFilename reject the whole set.
      const ts = new Date().toISOString().replace(/[-T:]/g, '').slice(0, 14).replace(/(\d{8})(\d{6})/, '$1_$2');

      // ─── BACKUP PHASE ──────────────────────────────────────────────────────
      if (doBackup) {
        const loginStepId = `${srcAccount}:backup:login`;
        updateStep(job, loginStepId, { state: 'running' });
        updateJobState(job, 'running');

        const vaultDir = profileDir(config.bitwardenConfigDir, srcAccount);
        let initResult: InitResult;
        try {
          initResult = await loginWithRetry({
            job, config, account: srcAccount, groupTargets: groupSyncs, stepId: loginStepId, log,
          });
        } catch (err: unknown) {
          updateStep(job, loginStepId, { state: 'failed', detail: String(err) });
          initResult = { ok: false, reason: 'failed', message: String(err) };
        }

        if (!initResult.ok) {
          for (const t of groupSyncs) backupFailed.add(t);
          anyFailed = true;
          updateStep(job, `${srcAccount}:backup:sync`, { state: 'skipped', detail: 'Login failed' });
          for (const t of groupSyncs) skipPending(`${srcAccount}:export:${t}:`, 'Login failed');
          updateStep(job, `${srcAccount}:backup:lock`, { state: 'skipped', detail: 'Login failed' });
        } else {
          const session = initResult.sessionKey;

          // Sync step (already done in bwInit, just mark complete)
          updateStep(job, `${srcAccount}:backup:sync`, { state: 'succeeded' });

          for (const target of groupSyncs) {
            if (aborted()) break;
            const sync = syncByKey(config, target);
            const isOrg = !!sync.org;
            const orgId = syncOrgId(config, sync, srcVault.key);
            const pw = getPassword(srcAccount);
            if (!pw) {
              addLog(job, 'app', `⚠️ No password cached for ${srcAccount}, skipping export of ${target}`);
              backupFailed.add(target);
              for (const stepSuffix of ['encrypted', 'pass', 'meta']) {
                updateStep(job, `${srcAccount}:export:${target}:${stepSuffix}`, { state: 'skipped', detail: 'No password' });
              }
              continue;
            }

            const encStepId = `${srcAccount}:export:${target}:encrypted`;
            const passStepId = `${srcAccount}:export:${target}:pass`;
            const metaStepId = `${srcAccount}:export:${target}:meta`;
            updateStep(job, encStepId, { state: 'running' });

            const encFilename = buildBackupFilename(target, syncKind(sync), ts, 'encrypted');
            const encPath = `${config.backupFolder}/${encFilename}`;
            const encArgs = ['export', '--output', encPath, '--format', 'encrypted_json', '--session', session];
            if (isOrg) encArgs.push('--organizationid', orgId!);
            const encResult = await runBw(encArgs, { profileDir: vaultDir, timeout: 60000 }, log);
            if (encResult.exitCode !== 0) {
              updateStep(job, encStepId, { state: 'failed', detail: 'Export failed' });
              backupFailed.add(target);
              updateStep(job, passStepId, { state: 'skipped', detail: 'Encrypted export failed' });
              updateStep(job, metaStepId, { state: 'skipped', detail: 'Encrypted export failed' });
              anyFailed = true;
              continue;
            }
            updateStep(job, encStepId, { state: 'succeeded' });
            updateStep(job, passStepId, { state: 'running' });

            const passFilename = buildBackupFilename(target, syncKind(sync), ts, 'encrypted_pass');
            const passPath = `${config.backupFolder}/${passFilename}`;
            const passArgs = ['export', '--output', passPath, '--format', 'encrypted_json', '--session', session, '--password'];
            if (isOrg) passArgs.push('--organizationid', orgId!);
            const passResult = await runBw(passArgs, { profileDir: vaultDir, stdin: pw, timeout: 60000 }, log);
            if (passResult.exitCode !== 0) {
              updateStep(job, passStepId, { state: 'failed', detail: 'Password-protected export failed' });
              backupFailed.add(target);
              updateStep(job, metaStepId, { state: 'skipped', detail: 'Password export failed' });
              anyFailed = true;
              continue;
            }
            backupFiles.set(target, passPath);
            updateStep(job, passStepId, { state: 'succeeded' });
            updateStep(job, metaStepId, { state: 'running' });

            // Write sidecar metadata
            try {
              const itemsForMeta = await listItems(vaultDir, session, { ...(isOrg ? { organizationId: orgId! } : {}) }, log);
              const filteredMeta = isOrg
                ? (itemsForMeta as Array<Record<string, unknown>>).filter((i) => i['organizationId'] === orgId)
                : (itemsForMeta as Array<Record<string, unknown>>).filter((i) => !i['organizationId']);
              // Hand the same listing to the import guard — the source is locked by then.
              sourceItems.set(target, filteredMeta.map(toDiffItem));
              recordCount(job, target, 'source', filteredMeta.length);
              const passContent = readFileSync(passPath);
              const sha256 = createHash('sha256').update(passContent).digest('hex');
              const sizeStat = statSync(passPath);
              const meta: BackupMeta = {
                target,
                kind: syncKind(sync),
                timestamp: ts,
                itemCount: filteredMeta.length,
                folderCount: isOrg ? undefined : (await runBw(['list', 'folders', '--session', session], { profileDir: vaultDir, timeout: 30000, silenceStdout: true }, log).then((r) => { try { return (JSON.parse(r.stdout) as unknown[]).length; } catch { return 0; } })),
                collectionCount: isOrg ? filteredMeta.filter((i) => i['collectionIds']).length : null,
                sourceServer: srcVault.serverUrl,
                cliVersion: cliVer,
                exportFile: passFilename,
                sizeBytes: sizeStat.size,
                sha256,
              };
              const metaFilename = buildBackupFilename(target, syncKind(sync), ts, 'meta');
              writeFileSync(`${config.backupFolder}/${metaFilename}`, JSON.stringify(meta, null, 2));
              updateStep(job, metaStepId, { state: 'succeeded' });
            } catch (err: unknown) {
              addLog(job, 'app', `⚠️ Failed to write metadata for ${target}: ${err}`);
              updateStep(job, metaStepId, { state: 'warning', detail: String(err) });
            }
          }

          const lockStepId = `${srcAccount}:backup:lock`;
          updateStep(job, lockStepId, { state: 'running' });
          await lockProfile(vaultDir, log);
          updateStep(job, lockStepId, { state: 'succeeded' });
        }
      }

      // ─── IMPORT PHASE ──────────────────────────────────────────────────────
      // The destination side can fan out: two syncs sharing a source account may target
      // different destination accounts, each needing its own login.
      if (doImport && !aborted()) {
        for (const [destAccount, dSyncs] of groupSyncsByAccount(groupSyncs, config, 'to')) {
          if (aborted()) break;
          const destCfg = accountByKey(config, destAccount);
          const destVault = vaultOfAccount(config, destAccount);

          const loginStepId = `${srcAccount}:import:${destAccount}:login`;
          updateStep(job, loginStepId, { state: 'running' });

          const vaultDir = profileDir(config.bitwardenConfigDir, destAccount);
          let initResult: InitResult;
          try {
            initResult = await loginWithRetry({
              job, config, account: destAccount, groupTargets: dSyncs, stepId: loginStepId, log,
            });
          } catch (err: unknown) {
            updateStep(job, loginStepId, { state: 'failed', detail: String(err) });
            initResult = { ok: false, reason: 'failed', message: String(err) };
          }

          if (!initResult.ok) {
            anyFailed = true;
            updateStep(job, `${srcAccount}:import:${destAccount}:sync`, { state: 'skipped', detail: 'Login failed' });
            for (const t of dSyncs) skipPending(`${srcAccount}:import:${t}:`, 'Login failed');
            skipPending(`${srcAccount}:import:${destAccount}:`, 'Login failed');
            continue;
          }
          const session = initResult.sessionKey;
          updateStep(job, `${srcAccount}:import:${destAccount}:sync`, { state: 'succeeded' });

          for (const target of dSyncs) {
            if (aborted()) break;
            const sync = syncByKey(config, target);
            const isOrg = !!sync.org;
            const destOrgId = syncOrgId(config, sync, destVault.key);
            const pw = getPassword(destAccount);

            // Skip if backup failed
            if (backupFailed.has(target) && doBackup) {
              addLog(job, 'app', `⏭️ Skipping import of ${target}: backup failed this run`);
              skipPending(`${srcAccount}:import:${target}:`, 'Backup failed');
              continue;
            }

            const resolveId = `${srcAccount}:import:${target}:resolveFile`;
            updateStep(job, resolveId, { state: 'running' });

            let backupFile = backupFiles.get(target) ?? null;
            if (!backupFile) {
              backupFile = findNewestExport(config.backupFolder, target, syncKind(sync));
            }
            if (!backupFile) {
              addLog(job, 'app', `⚠️ No backup file found for ${target}, skipping`);
              skipPending(`${srcAccount}:import:${target}:`, 'No backup file');
              anyFailed = true;
              continue;
            }
            updateStep(job, resolveId, { state: 'succeeded', detail: backupFile });

            // Diff
            const diffId = `${srcAccount}:import:${target}:diff`;
            updateStep(job, diffId, { state: 'running' });

            let diffResult: DiffResult | null = null;
            let confirmDecision: 'proceed' | 'skip' | 'abort' = 'proceed';

            // What the source held. Items captured during this run's backup are the
            // best input; otherwise recover a count from the export we resolved above,
            // which is the only handle on a backup made by an earlier run.
            const captured = sourceItems.get(target);
            const fileCounts = captured ? null : countExportItems(backupFile);
            if (!captured && !fileCounts) {
              addLog(job, 'app', `⚠️ No item count available for ${target} — the import guard will treat the source as unknown`);
            }

            try {
              diffResult = await computeDiff({
                ...(captured ? { sourceItems: captured } : {}),
                ...(fileCounts ? { sourceCount: fileCounts.itemCount, sourceCountOrigin: fileCounts.source } : {}),
                destProfileDir: vaultDir,
                destSessionKey: session,
                ...(isOrg ? { destOrgId: destOrgId! } : {}),
                log,
              });
              const guardResult = evaluateGuard(diffResult, config.importGuard);

              if (guardResult.blocked) {
                addLog(job, 'app', `⚠️ Import guard tripped for ${target}: ${guardResult.reason}`);
                updateStep(job, diffId, { state: 'warning', detail: guardResult.reason });
                updateJobState(job, 'awaiting-confirmation');

                try {
                  confirmDecision = await waitForConfirmation(job, target, diffResult);
                } catch {
                  confirmDecision = 'abort';
                }

                updateJobState(job, 'running');

                if (confirmDecision === 'abort') {
                  updateJobState(job, 'aborted');
                  break;
                }
                if (confirmDecision === 'skip') {
                  addLog(job, 'app', `⏭️ Skipping import of ${target} (user decision)`);
                  skipPending(`${srcAccount}:import:${target}:`, 'Skipped by user');
                  continue;
                }
              } else {
                updateStep(job, diffId, { state: 'succeeded' });
              }
            } catch (err: unknown) {
              addLog(job, 'app', `⚠️ Diff failed for ${target}: ${err}`);
              updateStep(job, diffId, { state: 'warning', detail: String(err) });
            }

            // Last point at which cancelling is free. Everything from the purge to the
            // verify below is one destructive unit — stopping between them would leave the
            // destination emptied with nothing imported back into it — so a cancel arriving
            // after this line is honoured only once that unit has run to completion.
            if (aborted()) break;

            // Purge
            const purgeId = `${srcAccount}:import:${target}:purge`;
            updateStep(job, purgeId, { state: 'running' });

            if (!pw) {
              updateStep(job, purgeId, { state: 'failed', detail: 'No password cached' });
              anyFailed = true;
              continue;
            }

            try {
              await purgeVault({
                who: destAccount,
                email: destCfg.email,
                destProfileDir: vaultDir,
                sessionKey: session,
                destServerUrl: destVault.serverUrl,
                ...(isOrg ? { destOrgId: destOrgId! } : {}),
                password: pw,
              }, log);
              updateStep(job, purgeId, { state: 'succeeded' });
            } catch (err: unknown) {
              updateStep(job, purgeId, { state: 'failed', detail: String(err) });
              addLog(job, 'app', `❌ Purge failed for ${target}: ${err}`);
              skipPending(`${srcAccount}:import:${target}:`, 'Purge failed');
              anyFailed = true;
              continue;
            }

            // Snapshot pre-import collection ids for org
            let preImportIds: string[] = [];
            if (isOrg) {
              const cols = await listOrgCollections(vaultDir, session, destOrgId!, log);
              preImportIds = (cols as Array<{ id: string }>).map((c) => c.id);
            }

            // Import
            const runId = `${srcAccount}:import:${target}:run`;
            updateStep(job, runId, { state: 'running' });
            const importArgs = ['import', 'bitwardenjson', backupFile, '--session', session];
            if (isOrg) importArgs.push('--organizationid', destOrgId!);
            const importResult = await runBw(importArgs, { profileDir: vaultDir, fifoPassword: pw, timeout: 120000 }, log);
            if (importResult.exitCode !== 0) {
              updateStep(job, runId, { state: 'failed', detail: 'Import failed' });
              anyFailed = true;
              skipPending(`${srcAccount}:import:${target}:`, 'Import failed');
              continue;
            }
            updateStep(job, runId, { state: 'succeeded' });

            // Verify
            const verifyId = `${srcAccount}:import:${target}:verify`;
            updateStep(job, verifyId, { state: 'running' });
            const verifyItems = await listItems(vaultDir, session, { ...(isOrg ? { organizationId: destOrgId! } : {}) }, log);
            const verifyCount = isOrg
              ? verifyItems.filter((i) => (i as Record<string, unknown>)['organizationId'] === destOrgId).length
              : verifyItems.filter((i) => !(i as Record<string, unknown>)['organizationId']).length;
            addLog(job, 'app', `📊 Items imported for ${target}: ${verifyCount}`);
            // Taken after the import, so it is what the destination now holds — the same
            // reading a 'count' job would go and fetch.
            recordCount(job, target, 'dest', verifyCount);
            updateStep(job, verifyId, { state: 'succeeded', detail: `${verifyCount} items` });

            // Reconcile collections (org only)
            if (isOrg && !aborted()) {
              const reconcileId = `${srcAccount}:import:${target}:reconcile`;
              updateStep(job, reconcileId, { state: 'running' });
              try {
                const reconciled = await reconcileOrgCollections({
                  profileDir: vaultDir,
                  sessionKey: session,
                  orgId: destOrgId!,
                  preImportIds,
                  log,
                  shouldAbort: aborted,
                });
                if (reconciled.needsReview > 0) {
                  updateStep(job, reconcileId, { state: 'warning', detail: `${reconciled.needsReview} need review` });
                } else {
                  updateStep(job, reconcileId, { state: 'succeeded', detail: `${reconciled.removed} removed` });
                }
              } catch (err: unknown) {
                updateStep(job, reconcileId, { state: 'warning', detail: String(err) });
              }
            }
          }

          const lockStepId = `${srcAccount}:import:${destAccount}:lock`;
          updateStep(job, lockStepId, { state: 'running' });
          await lockProfile(vaultDir, log);
          updateStep(job, lockStepId, { state: 'succeeded' });

          if (logoutAfterImport(config, destVault.key)) {
            const logoutStepId = `${srcAccount}:import:${destAccount}:logout`;
            updateStep(job, logoutStepId, { state: 'running' });
            await logoutProfile(vaultDir, log);
            updateStep(job, logoutStepId, { state: 'succeeded' });
          }
        }
      }

      // ─── COUNT PHASE (live item counts, no export) ─────────────────────────
      if (doCount && !aborted()) {
        for (const role of ['source', 'dest'] as const) {
          if (aborted()) break;
          const byAccount = groupSyncsByAccount(groupSyncs, config, role === 'source' ? 'from' : 'to');
          for (const [account, aSyncs] of byAccount) {
            if (aborted()) break;
            const vault = vaultOfAccount(config, account);

            const loginStepId = `${srcAccount}:count:${role}:${account}:login`;
            updateStep(job, loginStepId, { state: 'running' });
            updateJobState(job, 'running');

            const vaultDir = profileDir(config.bitwardenConfigDir, account);
            let initResult: InitResult;
            try {
              initResult = await loginWithRetry({
                job, config, account, groupTargets: aSyncs, stepId: loginStepId, log,
              });
            } catch (err: unknown) {
              updateStep(job, loginStepId, { state: 'failed', detail: String(err) });
              anyFailed = true;
              initResult = { ok: false, reason: 'failed', message: String(err) };
            }

            if (!initResult.ok) {
              anyFailed = true;
              updateStep(job, `${srcAccount}:count:${role}:${account}:sync`, { state: 'skipped' });
              for (const t of aSyncs) {
                updateStep(job, `${srcAccount}:count:${role}:${account}:${t}`, { state: 'skipped', detail: 'Login failed' });
              }
              updateStep(job, `${srcAccount}:count:${role}:${account}:lock`, { state: 'skipped' });
              continue;
            }

            const session = initResult.sessionKey;
            updateStep(job, `${srcAccount}:count:${role}:${account}:sync`, { state: 'succeeded' });

            for (const target of aSyncs) {
              if (aborted()) break;
              const sync = syncByKey(config, target);
              const isOrg = !!sync.org;
              const orgId = syncOrgId(config, sync, vault.key);
              const stepId = `${srcAccount}:count:${role}:${account}:${target}`;
              updateStep(job, stepId, { state: 'running' });
              try {
                const items = await listItems(vaultDir, session, { ...(isOrg ? { organizationId: orgId! } : {}) }, log);
                const filtered = isOrg
                  ? (items as Array<Record<string, unknown>>).filter((i) => i['organizationId'] === orgId)
                  : (items as Array<Record<string, unknown>>).filter((i) => !i['organizationId']);
                recordCount(job, target, role, filtered.length);
                updateStep(job, stepId, { state: 'succeeded', detail: `${filtered.length} items` });
              } catch (err: unknown) {
                updateStep(job, stepId, { state: 'failed', detail: String(err) });
                anyFailed = true;
              }
            }

            updateStep(job, `${srcAccount}:count:${role}:${account}:lock`, { state: 'running' });
            await lockProfile(vaultDir, log);
            updateStep(job, `${srcAccount}:count:${role}:${account}:lock`, { state: 'succeeded' });
          }
        }
      }

      // ─── DIFF PHASE (secure credential comparison, no clear-text leaves memory) ─
      if (doDiff && !aborted()) {
        // Step 1: snapshot source vault — list all items, hash credentials, discard raw data
        const srcVaultDir = profileDir(config.bitwardenConfigDir, srcAccount);

        const srcLoginStepId = `${srcAccount}:diff:src:login`;
        updateStep(job, srcLoginStepId, { state: 'running' });
        updateJobState(job, 'running');

        let srcInitResult: InitResult;
        try {
          srcInitResult = await loginWithRetry({
            job, config, account: srcAccount, groupTargets: groupSyncs, stepId: srcLoginStepId, log,
          });
        } catch (err: unknown) {
          updateStep(job, srcLoginStepId, { state: 'failed', detail: String(err) });
          srcInitResult = { ok: false, reason: 'failed', message: String(err) };
        }

        if (!srcInitResult.ok) {
          anyFailed = true;
          updateStep(job, `${srcAccount}:diff:src:sync`, { state: 'skipped', detail: 'Login failed' });
          for (const t of groupSyncs) skipPending(`${srcAccount}:diff:src:${t}`, 'Login failed');
          updateStep(job, `${srcAccount}:diff:src:lock`, { state: 'skipped', detail: 'Login failed' });
          for (const [destAccount, dSyncs] of groupSyncsByAccount(groupSyncs, config, 'to')) {
            skipPending(`${srcAccount}:diff:dst:${destAccount}:`, 'Source login failed');
            for (const t of dSyncs) skipPending(`${srcAccount}:diff:compare:${t}`, 'Source login failed');
          }
        } else {
          const srcSession = srcInitResult.sessionKey;
          updateStep(job, `${srcAccount}:diff:src:sync`, { state: 'succeeded' });

          // Collect source snapshots per target (raw items in memory only, never persisted)
          const srcSnapshots = new Map<string, Array<Record<string, unknown>>>();
          for (const target of groupSyncs) {
            if (aborted()) break;
            const sync = syncByKey(config, target);
            const isOrg = !!sync.org;
            const orgId = syncOrgId(config, sync, srcVault.key);
            const stepId = `${srcAccount}:diff:src:${target}`;
            updateStep(job, stepId, { state: 'running' });
            try {
              const items = await listItems(srcVaultDir, srcSession, { ...(isOrg ? { organizationId: orgId! } : {}) }, log);
              const filtered = isOrg
                ? (items as Array<Record<string, unknown>>).filter((i) => i['organizationId'] === orgId)
                : (items as Array<Record<string, unknown>>).filter((i) => !i['organizationId']);
              srcSnapshots.set(target, filtered);
              updateStep(job, stepId, { state: 'succeeded', detail: `${filtered.length} items captured` });
            } catch (err: unknown) {
              updateStep(job, stepId, { state: 'failed', detail: String(err) });
              anyFailed = true;
            }
          }

          updateStep(job, `${srcAccount}:diff:src:lock`, { state: 'running' });
          await lockProfile(srcVaultDir, log);
          updateStep(job, `${srcAccount}:diff:src:lock`, { state: 'succeeded' });

          // Step 2: snapshot each destination vault, then compute hashed diff immediately
          for (const [destAccount, dSyncs] of groupSyncsByAccount(groupSyncs, config, 'to')) {
            if (aborted()) break;
            const destVault = vaultOfAccount(config, destAccount);
            const dstVaultDir = profileDir(config.bitwardenConfigDir, destAccount);

            const dstLoginStepId = `${srcAccount}:diff:dst:${destAccount}:login`;
            updateStep(job, dstLoginStepId, { state: 'running' });

            let dstInitResult: InitResult;
            try {
              dstInitResult = await loginWithRetry({
                job, config, account: destAccount, groupTargets: dSyncs, stepId: dstLoginStepId, log,
              });
            } catch (err: unknown) {
              updateStep(job, dstLoginStepId, { state: 'failed', detail: String(err) });
              dstInitResult = { ok: false, reason: 'failed', message: String(err) };
            }

            if (!dstInitResult.ok) {
              anyFailed = true;
              updateStep(job, `${srcAccount}:diff:dst:${destAccount}:sync`, { state: 'skipped', detail: 'Login failed' });
              for (const t of dSyncs) {
                updateStep(job, `${srcAccount}:diff:dst:${destAccount}:${t}`, { state: 'skipped', detail: 'Login failed' });
                updateStep(job, `${srcAccount}:diff:compare:${t}`, { state: 'skipped', detail: 'Dest login failed' });
              }
              updateStep(job, `${srcAccount}:diff:dst:${destAccount}:lock`, { state: 'skipped', detail: 'Login failed' });
              continue;
            }

            const dstSession = dstInitResult.sessionKey;
            updateStep(job, `${srcAccount}:diff:dst:${destAccount}:sync`, { state: 'succeeded' });

            for (const target of dSyncs) {
              if (aborted()) break;
              const sync = syncByKey(config, target);
              const isOrg = !!sync.org;
              const orgId = syncOrgId(config, sync, destVault.key);

              const dstStepId = `${srcAccount}:diff:dst:${destAccount}:${target}`;
              updateStep(job, dstStepId, { state: 'running' });

              let dstItems: Array<Record<string, unknown>> = [];
              try {
                const items = await listItems(dstVaultDir, dstSession, { ...(isOrg ? { organizationId: orgId! } : {}) }, log);
                dstItems = isOrg
                  ? (items as Array<Record<string, unknown>>).filter((i) => i['organizationId'] === orgId)
                  : (items as Array<Record<string, unknown>>).filter((i) => !i['organizationId']);
                updateStep(job, dstStepId, { state: 'succeeded', detail: `${dstItems.length} items captured` });
              } catch (err: unknown) {
                updateStep(job, dstStepId, { state: 'failed', detail: String(err) });
                updateStep(job, `${srcAccount}:diff:compare:${target}`, { state: 'skipped', detail: 'Dest snapshot failed' });
                anyFailed = true;
                continue;
              }

              // Compare: all credential data is hashed inside computeSecureDiff,
              // raw items are discarded immediately after the call.
              const compareStepId = `${srcAccount}:diff:compare:${target}`;
              updateStep(job, compareStepId, { state: 'running' });
              const srcItems = srcSnapshots.get(target) ?? [];
              const result = computeSecureDiff(srcItems, dstItems);
              // Discard raw data — only the result (hashes compared, values gone) survives.
              srcSnapshots.delete(target);

              job.secureDiffResults = job.secureDiffResults ?? {};
              job.secureDiffResults[target] = result;
              // Broadcast the updated diff results so connected clients update in real time.
              emit(job.id, 'job', { secureDiffResults: job.secureDiffResults });
              persistJob(job);

              const diffParts: string[] = [];
              if (result.onlyInSource.length > 0) diffParts.push(`${result.onlyInSource.length} only in source`);
              if (result.onlyInDest.length > 0) diffParts.push(`${result.onlyInDest.length} only in dest`);
              if (result.credentialsDiffer.length > 0) diffParts.push(`${result.credentialsDiffer.length} credential mismatch`);
              const summary = diffParts.length > 0 ? diffParts.join(', ') : 'vaults are identical';
              addLog(job, 'app', `🔍 [${target}] Diff: ${summary} (${result.identical} identical)`);

              updateStep(job, compareStepId, {
                state: result.onlyInSource.length + result.onlyInDest.length + result.credentialsDiffer.length > 0 ? 'warning' : 'succeeded',
                detail: summary,
              });
            }

            updateStep(job, `${srcAccount}:diff:dst:${destAccount}:lock`, { state: 'running' });
            await lockProfile(dstVaultDir, log);
            updateStep(job, `${srcAccount}:diff:dst:${destAccount}:lock`, { state: 'succeeded' });
          }
        }
      }
    }

    clearAllPasswords();
    clearAllSecrets();
    if (aborted()) {
      // state already set
    } else if (anyFailed) {
      updateJobState(job, 'partial');
    } else {
      updateJobState(job, 'succeeded');
    }
  } catch (err: unknown) {
    addLog(job, 'app', `❌ Job failed: ${err}`);
    clearAllPasswords();
    clearAllSecrets();
    updateJobState(job, 'failed');
  } finally {
    // A job that stopped early — cancelled, or thrown out of mid-phase — leaves steps it
    // never reached sitting at 'pending', and the one it died inside at 'running'. Settle
    // them so a finished job never shows work still in progress. A clean run has nothing
    // left to settle, so this is a no-op there.
    let stoppedBecause = 'Job ended before this step ran';
    if (aborted()) stoppedBecause = 'Job cancelled';
    else if (job.state === 'failed') stoppedBecause = 'Job failed';
    markRemainingSkipped(job, stoppedBecause);

    currentStep.delete(job.id);
    persistJob(job);
    activeJobId = null;

    // Run next queued job
    if (queue.length > 0) {
      const nextId = queue.shift()!;
      const nextJob = jobs.get(nextId);
      if (nextJob && nextJob.state === 'queued') {
        const cfg = (global as unknown as { _bwConfig: Config })._bwConfig;
        if (cfg) setTimeout(() => runJobAsync(nextId, cfg), 0);
      }
    }
  }
}

// Helper to expose config globally for queue continuation
export function setGlobalConfig(cfg: Config): void {
  (global as unknown as { _bwConfig: Config })._bwConfig = cfg;
}
