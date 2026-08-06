import { randomUUID } from 'crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { Config, buildAccountGroups, groupTargetsByVault, profileDir, vaultByKey } from './config.js';
import { bwInit, getBwStatus, lockProfile, logoutProfile, listItems, listOrgCollections, InitResult } from './session.js';
import { cachePassword, getPassword, clearAllPasswords } from './secrets.js';
import { purgeVault } from './purge.js';
import { dedupeOrgCollections } from './collections.js';
import { computeDiff, evaluateGuard, DiffResult } from './diff.js';
import { findNewestExport, BackupMeta, buildBackupFilename } from './backups.js';
import { runBw, LogCallback, getCliVersion } from './bwCli.js';
import { redact, clearAllSecrets } from './redact.js';
import { recordLiveCount } from './liveCounts.js';
import { createHash } from 'crypto';
import { statSync } from 'fs';

export type JobOperation = 'backup' | 'import' | 'both' | 'status' | 'diff' | 'count';
export type JobState = 'queued' | 'running' | 'awaiting-credentials' | 'awaiting-confirmation' | 'succeeded' | 'failed' | 'partial' | 'aborted';
// Use a separate variable to track aborted state at runtime (the type above does include 'aborted')
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
  accountKey: string;
  targets: string[];
  vaultKey: string;
  vaultName: string;
  needsOtp: boolean;
  otpMethod?: number;
}

export interface ConfirmationPrompt {
  kind: 'confirmation';
  target: string;
  diff: DiffResult;
}

export type Prompt = CredentialPrompt | ConfirmationPrompt;

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
type JobUpdateCallback = (jobId: string, event: 'log' | 'step' | 'job' | 'prompt', data: unknown) => void;
const listeners = new Set<JobUpdateCallback>();

export function addJobListener(cb: JobUpdateCallback): void {
  listeners.add(cb);
}

export function removeJobListener(cb: JobUpdateCallback): void {
  listeners.delete(cb);
}

function emit(jobId: string, event: 'log' | 'step' | 'job' | 'prompt', data: unknown): void {
  for (const cb of listeners) {
    try { cb(jobId, event, data); } catch { /* ignore */ }
  }
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

function updateStep(job: Job, stepId: string, update: Partial<Step>): void {
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

const TERMINAL_JOB_STATES: JobState[] = ['succeeded', 'failed', 'partial', 'aborted'];

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

function buildSteps(targets: string[], ops: JobOperation[], config: Config): Step[] {
  const groups = buildAccountGroups(targets, config);
  const steps: Step[] = [];
  const doBackup = ops.includes('backup') || ops.includes('both');
  const doImport = ops.includes('import') || ops.includes('both');
  const doCount = ops.includes('count');

  for (const [account, groupTargets] of groups) {
    const g = account;
    if (doBackup) {
      const byFrom = groupTargetsByVault(groupTargets, config, 'from');
      for (const [v, vTargets] of byFrom) {
        const vaultName = vaultByKey(config, v).name;
        steps.push({ id: `${g}:backup:${v}:login`, label: `[${g}] ${vaultName} login`, state: 'pending', group: g });
        steps.push({ id: `${g}:backup:${v}:sync`, label: `[${g}] ${vaultName} sync`, state: 'pending', group: g });
        for (const t of vTargets) {
          steps.push({ id: `${g}:export:${t}:encrypted`, label: `[${t}] Export encrypted`, state: 'pending', group: g });
          steps.push({ id: `${g}:export:${t}:pass`, label: `[${t}] Export password-protected`, state: 'pending', group: g });
          steps.push({ id: `${g}:export:${t}:meta`, label: `[${t}] Write sidecar metadata`, state: 'pending', group: g });
        }
        steps.push({ id: `${g}:backup:${v}:lock`, label: `[${g}] ${vaultName} lock`, state: 'pending', group: g });
      }
    }
    if (doImport) {
      const byTo = groupTargetsByVault(groupTargets, config, 'to');
      for (const [v, vTargets] of byTo) {
        const vaultName = vaultByKey(config, v).name;
        steps.push({ id: `${g}:import:${v}:login`, label: `[${g}] ${vaultName} login`, state: 'pending', group: g });
        steps.push({ id: `${g}:import:${v}:sync`, label: `[${g}] ${vaultName} sync`, state: 'pending', group: g });
        for (const t of vTargets) {
          steps.push({ id: `${g}:import:${t}:resolveFile`, label: `[${t}] Resolve backup file`, state: 'pending', group: g });
          steps.push({ id: `${g}:import:${t}:diff`, label: `[${t}] Pre-import diff`, state: 'pending', group: g });
          steps.push({ id: `${g}:import:${t}:purge`, label: `[${t}] Purge destination vault`, state: 'pending', group: g });
          steps.push({ id: `${g}:import:${t}:run`, label: `[${t}] Import`, state: 'pending', group: g });
          steps.push({ id: `${g}:import:${t}:verify`, label: `[${t}] Verify import`, state: 'pending', group: g });
          const org = config.orgs.find((o) => o.key === t);
          if (org) {
            steps.push({ id: `${g}:import:${t}:dedupe`, label: `[${t}] Dedupe org collections`, state: 'pending', group: g });
          }
        }
        steps.push({ id: `${g}:import:${v}:lock`, label: `[${g}] ${vaultName} lock`, state: 'pending', group: g });
        if (config.homeLogoutAfterImport) {
          steps.push({ id: `${g}:import:${v}:logout`, label: `[${g}] ${vaultName} logout`, state: 'pending', group: g });
        }
      }
    }
    if (doCount) {
      for (const role of ['source', 'dest'] as const) {
        const byRole = groupTargetsByVault(groupTargets, config, role === 'source' ? 'from' : 'to');
        for (const [v, vTargets] of byRole) {
          const vaultName = vaultByKey(config, v).name;
          steps.push({ id: `${g}:count:${role}:${v}:login`, label: `[${g}] ${vaultName} login`, state: 'pending', group: g });
          steps.push({ id: `${g}:count:${role}:${v}:sync`, label: `[${g}] ${vaultName} sync`, state: 'pending', group: g });
          for (const t of vTargets) {
            steps.push({ id: `${g}:count:${role}:${v}:${t}`, label: `[${t}] Count ${role} items`, state: 'pending', group: g });
          }
          steps.push({ id: `${g}:count:${role}:${v}:lock`, label: `[${g}] ${vaultName} lock`, state: 'pending', group: g });
        }
      }
    }
  }
  return steps;
}

// Pending credential/confirmation resolvers
const credentialResolvers = new Map<string, (pw: string, otp?: string, otpMethod?: number) => void>();
const confirmationResolvers = new Map<string, (decision: 'proceed' | 'skip' | 'abort') => void>();

function accountVaultKey(account: string, vaultKey: string): string {
  return `${account}::${vaultKey}`;
}

/**
 * Prefers a password cached specifically for this (account, vault); falls back to one shared
 * across the account's vaults (opt-in at submission time — see submitCredentials). Returns the
 * key to look up / write / forget next.
 */
function resolvePasswordCacheKey(account: string, vaultKey: string): string {
  const specific = accountVaultKey(account, vaultKey);
  if (getPassword(specific) !== undefined) return specific;
  if (getPassword(account) !== undefined) return account;
  return specific;
}

function clearPrompt(job: Job): void {
  if (!job.prompt) return;
  job.prompt = undefined;
  emit(job.id, 'prompt', null);
  persistJob(job);
}

export function submitCredentials(
  jobId: string,
  accountKey: string,
  password: string,
  otp?: string,
  otpMethod?: number,
  sharedAcrossVaults = false,
): boolean {
  const resolver = credentialResolvers.get(`${jobId}:${accountKey}`);
  if (typeof resolver !== 'function') return false;
  const job = jobs.get(jobId);
  const vaultKey = job?.prompt?.kind === 'credentials' ? job.prompt.vaultKey : undefined;
  const cacheKey = sharedAcrossVaults || !vaultKey ? accountKey : accountVaultKey(accountKey, vaultKey);
  cachePassword(cacheKey, password);
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

async function waitForCredentials(job: Job, accountKey: string, targets: string[], vaultKey: string, vaultName: string, needsOtp: boolean): Promise<{ password: string; otp?: string; otpMethod?: number }> {
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

    const prompt: CredentialPrompt = { kind: 'credentials', accountKey, targets, vaultKey, vaultName, needsOtp };
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
  account: string;
  groupTargets: string[];
  vaultKey: string;
  vaultName: string;
  email: string;
  wantServer: string;
  profileDir: string;
  stepId: string;
  log: LogCallback;
}): Promise<InitResult> {
  const { job, account, groupTargets, vaultKey, vaultName, email, wantServer, profileDir, stepId, log } = opts;
  const profileLabel = `${account}:${vaultKey}`;
  let result = await bwInit({
    accountKey: resolvePasswordCacheKey(account, vaultKey),
    profileLabel, email, wantServer, profileDir, log,
  });

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
    const creds = await waitForCredentials(job, account, groupTargets, vaultKey, vaultName, result.reason === 'needs-otp');
    // Re-resolve: the prompt may just have cached the password under either the vault-specific
    // or the shared key, depending on the user's "use for other vaults too" choice.
    result = await bwInit({
      accountKey: resolvePasswordCacheKey(account, vaultKey),
      profileLabel, email, wantServer, profileDir, otp: creds.otp, otpMethod: creds.otpMethod, log,
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

  const groups = buildAccountGroups(job.targets, config);
  const doBackup = job.operations.includes('backup') || job.operations.includes('both');
  const doImport = job.operations.includes('import') || job.operations.includes('both');
  const doCount = job.operations.includes('count');

  const backupFiles = new Map<string, string>(); // targetKey → path
  const backupFailed = new Set<string>();
  let anyFailed = false;

  try {
    for (const [account, groupTargets] of groups) {
      if ((job.state as string) === 'aborted') break;
      const userCfg = config.users.find((u) => u.key === account)!;
      const email = userCfg.email;
      addLog(job, 'app', `\n====== Account ${account} (${email}) — targets: ${groupTargets.join(', ')} ======`);

      const ts = new Date().toISOString().replace(/[-T:]/g, '').slice(0, 15).replace(/(\d{8})(\d{6})/, '$1_$2');

      // ─── BACKUP PHASE ──────────────────────────────────────────────────────
      if (doBackup) {
        const byFrom = groupTargetsByVault(groupTargets, config, 'from');
        for (const [v, vTargets] of byFrom) {
          if ((job.state as string) === 'aborted') break;
          const vault = vaultByKey(config, v);

          const loginStepId = `${account}:backup:${v}:login`;
          updateStep(job, loginStepId, { state: 'running' });
          updateJobState(job, 'running');

          const vaultDir = profileDir(config.bitwardenConfigDir, account, v);
          let initResult: InitResult;
          try {
            initResult = await loginWithRetry({
              job, account, groupTargets: vTargets, vaultKey: v, vaultName: vault.name,
              email, wantServer: vault.serverUrl, profileDir: vaultDir,
              stepId: loginStepId, log,
            });
          } catch (err: unknown) {
            updateStep(job, loginStepId, { state: 'failed', detail: String(err) });
            for (const t of vTargets) { backupFailed.add(t); }
            anyFailed = true;
            continue;
          }

          if (!initResult.ok) {
            for (const t of vTargets) { backupFailed.add(t); }
            anyFailed = true;
            continue;
          }
          const session = initResult.sessionKey;

          // Sync step (already done in bwInit, just mark complete)
          updateStep(job, `${account}:backup:${v}:sync`, { state: 'succeeded' });

          // Export each target
          for (const target of vTargets) {
            if ((job.state as string) === 'aborted') break;
            const org = config.orgs.find((o) => o.key === target);
            const isOrg = !!org;
            const ownerKey = isOrg ? org!.owner : target;
            const pw = getPassword(resolvePasswordCacheKey(ownerKey, v));
            if (!pw) {
              addLog(job, 'app', `⚠️ No password cached for ${ownerKey}, skipping export of ${target}`);
              backupFailed.add(target);
              for (const stepSuffix of ['encrypted', 'pass', 'meta']) {
                updateStep(job, `${account}:export:${target}:${stepSuffix}`, { state: 'skipped', detail: 'No password' });
              }
              continue;
            }

            const encStepId = `${account}:export:${target}:encrypted`;
            const passStepId = `${account}:export:${target}:pass`;
            const metaStepId = `${account}:export:${target}:meta`;
            updateStep(job, encStepId, { state: 'running' });

            const encFilename = buildBackupFilename(target, isOrg ? 'org' : 'user', ts, 'encrypted');
            const encPath = `${config.backupFolder}/${encFilename}`;
            const encArgs = ['export', '--output', encPath, '--format', 'encrypted_json', '--session', session];
            if (isOrg) encArgs.push('--organizationid', org!.orgIds[v]);
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

            const passFilename = buildBackupFilename(target, isOrg ? 'org' : 'user', ts, 'encrypted_pass');
            const passPath = `${config.backupFolder}/${passFilename}`;
            const passArgs = ['export', '--output', passPath, '--format', 'encrypted_json', '--session', session, '--password'];
            if (isOrg) passArgs.push('--organizationid', org!.orgIds[v]);
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
              const itemsForMeta = await listItems(vaultDir, session, { organizationId: isOrg ? org!.orgIds[v] : undefined }, log);
              const filteredMeta = isOrg
                ? (itemsForMeta as Array<Record<string, unknown>>).filter((i) => i['organizationId'] === org!.orgIds[v])
                : (itemsForMeta as Array<Record<string, unknown>>).filter((i) => !i['organizationId']);
              const passContent = readFileSync(passPath);
              const sha256 = createHash('sha256').update(passContent).digest('hex');
              const sizeStat = statSync(passPath);
              const meta: BackupMeta = {
                target,
                kind: isOrg ? 'org' : 'user',
                timestamp: ts,
                itemCount: filteredMeta.length,
                folderCount: isOrg ? undefined : (await runBw(['list', 'folders', '--session', session], { profileDir: vaultDir, timeout: 30000, silenceStdout: true }, log).then((r) => { try { return (JSON.parse(r.stdout) as unknown[]).length; } catch { return 0; } })),
                collectionCount: isOrg ? filteredMeta.filter((i) => i['collectionIds']).length : null,
                sourceServer: vault.serverUrl,
                cliVersion: cliVer,
                exportFile: passFilename,
                sizeBytes: sizeStat.size,
                sha256,
              };
              const metaFilename = buildBackupFilename(target, isOrg ? 'org' : 'user', ts, 'meta');
              writeFileSync(`${config.backupFolder}/${metaFilename}`, JSON.stringify(meta, null, 2));
              updateStep(job, metaStepId, { state: 'succeeded' });
            } catch (err: unknown) {
              addLog(job, 'app', `⚠️ Failed to write metadata for ${target}: ${err}`);
              updateStep(job, metaStepId, { state: 'warning', detail: String(err) });
            }
          }

          // Lock this vault's profile
          const lockStepId = `${account}:backup:${v}:lock`;
          updateStep(job, lockStepId, { state: 'running' });
          await lockProfile(vaultDir, log);
          updateStep(job, lockStepId, { state: 'succeeded' });
        }
      }

      // ─── IMPORT PHASE ──────────────────────────────────────────────────────
      if (doImport && (job.state as string) !== 'aborted') {
        const byTo = groupTargetsByVault(groupTargets, config, 'to');
        for (const [v, vTargets] of byTo) {
          if ((job.state as string) === 'aborted') break;
          const vault = vaultByKey(config, v);

          const loginStepId = `${account}:import:${v}:login`;
          updateStep(job, loginStepId, { state: 'running' });

          const vaultDir = profileDir(config.bitwardenConfigDir, account, v);
          let initResult: InitResult;
          try {
            initResult = await loginWithRetry({
              job, account, groupTargets: vTargets, vaultKey: v, vaultName: vault.name,
              email, wantServer: vault.serverUrl, profileDir: vaultDir,
              stepId: loginStepId, log,
            });
          } catch (err: unknown) {
            updateStep(job, loginStepId, { state: 'failed', detail: String(err) });
            anyFailed = true;
            continue;
          }

          if (!initResult.ok) {
            anyFailed = true;
            continue;
          }
          const session = initResult.sessionKey;
          updateStep(job, `${account}:import:${v}:sync`, { state: 'succeeded' });

          // Import each target
          for (const target of vTargets) {
            if ((job.state as string) === 'aborted') break;
            const org = config.orgs.find((o) => o.key === target);
            const isOrg = !!org;
            const ownerKey = isOrg ? org!.owner : target;
            const pw = getPassword(resolvePasswordCacheKey(ownerKey, v));

            // Skip if backup failed
            if (backupFailed.has(target) && doBackup) {
              addLog(job, 'app', `⏭️ Skipping import of ${target}: backup failed this run`);
              const importSteps = job.steps.filter((s) => s.id.startsWith(`${account}:import:${target}:`));
              for (const s of importSteps) {
                updateStep(job, s.id, { state: 'skipped', detail: 'Backup failed' });
              }
              continue;
            }

            const resolveId = `${account}:import:${target}:resolveFile`;
            updateStep(job, resolveId, { state: 'running' });

            let backupFile = backupFiles.get(target) ?? null;
            if (!backupFile) {
              backupFile = findNewestExport(config.backupFolder, target, isOrg ? 'org' : 'user');
            }
            if (!backupFile) {
              addLog(job, 'app', `⚠️ No backup file found for ${target}, skipping`);
              const importSteps = job.steps.filter((s) => s.id.startsWith(`${account}:import:${target}:`));
              for (const s of importSteps) {
                updateStep(job, s.id, { state: 'skipped', detail: 'No backup file' });
              }
              anyFailed = true;
              continue;
            }
            updateStep(job, resolveId, { state: 'succeeded', detail: backupFile });

            // Diff
            const diffId = `${account}:import:${target}:diff`;
            updateStep(job, diffId, { state: 'running' });

            let diffResult: DiffResult | null = null;
            let confirmDecision: 'proceed' | 'skip' | 'abort' = 'proceed';

            try {
              diffResult = await computeDiff({
                destProfileDir: vaultDir,
                destSessionKey: session,
                destOrgId: isOrg ? org!.orgIds[v] : undefined,
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
                  const importSteps = job.steps.filter((s) => s.id.startsWith(`${account}:import:${target}:`));
                  for (const s of importSteps) {
                    if (s.state === 'pending' || s.state === 'running') {
                      updateStep(job, s.id, { state: 'skipped', detail: 'Skipped by user' });
                    }
                  }
                  continue;
                }
              } else {
                updateStep(job, diffId, { state: 'succeeded' });
              }
            } catch (err: unknown) {
              addLog(job, 'app', `⚠️ Diff failed for ${target}: ${err}`);
              updateStep(job, diffId, { state: 'warning', detail: String(err) });
            }

            if ((job.state as string) === 'aborted') break;

            // Purge
            const purgeId = `${account}:import:${target}:purge`;
            updateStep(job, purgeId, { state: 'running' });

            if (!pw) {
              updateStep(job, purgeId, { state: 'failed', detail: 'No password cached' });
              anyFailed = true;
              continue;
            }

            try {
              await purgeVault({
                who: account,
                email,
                destProfileDir: vaultDir,
                sessionKey: session,
                destServerUrl: vault.serverUrl,
                destOrgId: isOrg ? org!.orgIds[v] : undefined,
                password: pw,
              }, log);
              updateStep(job, purgeId, { state: 'succeeded' });
            } catch (err: unknown) {
              updateStep(job, purgeId, { state: 'failed', detail: String(err) });
              addLog(job, 'app', `❌ Purge failed for ${target}: ${err}`);
              const remaining = job.steps.filter((s) =>
                s.id.startsWith(`${account}:import:${target}:`) && s.state === 'pending',
              );
              for (const s of remaining) {
                updateStep(job, s.id, { state: 'skipped', detail: 'Purge failed' });
              }
              anyFailed = true;
              continue;
            }

            // Snapshot pre-import collection ids for org
            let preImportIds: string[] = [];
            if (isOrg) {
              const cols = await listOrgCollections(vaultDir, session, org!.orgIds[v], log);
              preImportIds = (cols as Array<{ id: string }>).map((c) => c.id);
            }

            // Import
            const runId = `${account}:import:${target}:run`;
            updateStep(job, runId, { state: 'running' });
            const importArgs = ['import', 'bitwardenjson', backupFile, '--session', session];
            if (isOrg) importArgs.push('--organizationid', org!.orgIds[v]);
            const importResult = await runBw(importArgs, { profileDir: vaultDir, fifoPassword: pw ?? '', timeout: 120000 }, log);
            if (importResult.exitCode !== 0) {
              updateStep(job, runId, { state: 'failed', detail: 'Import failed' });
              anyFailed = true;
              const remaining = job.steps.filter((s) =>
                s.id.startsWith(`${account}:import:${target}:`) && s.state === 'pending',
              );
              for (const s of remaining) {
                updateStep(job, s.id, { state: 'skipped', detail: 'Import failed' });
              }
              continue;
            }
            updateStep(job, runId, { state: 'succeeded' });

            // Verify
            const verifyId = `${account}:import:${target}:verify`;
            updateStep(job, verifyId, { state: 'running' });
            const verifyItems = await listItems(vaultDir, session, { organizationId: isOrg ? org!.orgIds[v] : undefined }, log);
            const verifyCount = isOrg
              ? verifyItems.filter((i) => (i as Record<string, unknown>)['organizationId'] === org!.orgIds[v]).length
              : verifyItems.filter((i) => !(i as Record<string, unknown>)['organizationId']).length;
            addLog(job, 'app', `📊 Items imported for ${target}: ${verifyCount}`);
            updateStep(job, verifyId, { state: 'succeeded', detail: `${verifyCount} items` });

            // Dedupe collections (org only)
            if (isOrg) {
              const dedupeId = `${account}:import:${target}:dedupe`;
              updateStep(job, dedupeId, { state: 'running' });
              try {
                const dedupeResult = await dedupeOrgCollections({
                  profileDir: vaultDir,
                  sessionKey: session,
                  orgId: org!.orgIds[v],
                  preImportIds,
                  log,
                });
                if (dedupeResult.needsReview > 0) {
                  updateStep(job, dedupeId, { state: 'warning', detail: `${dedupeResult.needsReview} need review` });
                } else {
                  updateStep(job, dedupeId, { state: 'succeeded', detail: `${dedupeResult.merged} merged` });
                }
              } catch (err: unknown) {
                updateStep(job, dedupeId, { state: 'warning', detail: String(err) });
              }
            }
          }

          // Lock this vault's profile
          const lockStepId = `${account}:import:${v}:lock`;
          updateStep(job, lockStepId, { state: 'running' });
          await lockProfile(vaultDir, log);
          updateStep(job, lockStepId, { state: 'succeeded' });

          if (config.homeLogoutAfterImport) {
            const logoutStepId = `${account}:import:${v}:logout`;
            updateStep(job, logoutStepId, { state: 'running' });
            await logoutProfile(vaultDir, log);
            updateStep(job, logoutStepId, { state: 'succeeded' });
          }
        }
      }

      // ─── COUNT PHASE (live item counts, no export) ─────────────────────────
      if (doCount && (job.state as string) !== 'aborted') {
        job.results = job.results ?? {};

        for (const role of ['source', 'dest'] as const) {
          if ((job.state as string) === 'aborted') break;
          const byRole = groupTargetsByVault(groupTargets, config, role === 'source' ? 'from' : 'to');
          for (const [v, vTargets] of byRole) {
            if ((job.state as string) === 'aborted') break;
            const vault = vaultByKey(config, v);

            const loginStepId = `${account}:count:${role}:${v}:login`;
            updateStep(job, loginStepId, { state: 'running' });
            updateJobState(job, 'running');

            const vaultDir = profileDir(config.bitwardenConfigDir, account, v);
            let initResult: InitResult;
            try {
              initResult = await loginWithRetry({
                job, account, groupTargets: vTargets, vaultKey: v, vaultName: vault.name,
                email, wantServer: vault.serverUrl, profileDir: vaultDir,
                stepId: loginStepId, log,
              });
            } catch (err: unknown) {
              updateStep(job, loginStepId, { state: 'failed', detail: String(err) });
              anyFailed = true;
              initResult = { ok: false, reason: 'failed', message: String(err) };
            }

            if (!initResult.ok) {
              anyFailed = true;
              updateStep(job, `${account}:count:${role}:${v}:sync`, { state: 'skipped' });
              for (const t of vTargets) {
                updateStep(job, `${account}:count:${role}:${v}:${t}`, { state: 'skipped', detail: 'Login failed' });
              }
              updateStep(job, `${account}:count:${role}:${v}:lock`, { state: 'skipped' });
              continue;
            }

            const session = initResult.sessionKey;
            updateStep(job, `${account}:count:${role}:${v}:sync`, { state: 'succeeded' });

            for (const target of vTargets) {
              if ((job.state as string) === 'aborted') break;
              const org = config.orgs.find((o) => o.key === target);
              const isOrg = !!org;
              const stepId = `${account}:count:${role}:${v}:${target}`;
              updateStep(job, stepId, { state: 'running' });
              try {
                const items = await listItems(vaultDir, session, { organizationId: isOrg ? org!.orgIds[v] : undefined }, log);
                const filtered = isOrg
                  ? (items as Array<Record<string, unknown>>).filter((i) => i['organizationId'] === org!.orgIds[v])
                  : (items as Array<Record<string, unknown>>).filter((i) => !i['organizationId']);
                job.results[target] = { ...job.results[target], [role]: filtered.length };
                recordLiveCount(target, role, filtered.length);
                updateStep(job, stepId, { state: 'succeeded', detail: `${filtered.length} items` });
              } catch (err: unknown) {
                updateStep(job, stepId, { state: 'failed', detail: String(err) });
                anyFailed = true;
              }
            }

            updateStep(job, `${account}:count:${role}:${v}:lock`, { state: 'running' });
            await lockProfile(vaultDir, log);
            updateStep(job, `${account}:count:${role}:${v}:lock`, { state: 'succeeded' });
          }
        }
      }
    }

    clearAllPasswords();
    clearAllSecrets();
    if ((job.state as string) === 'aborted') {
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
