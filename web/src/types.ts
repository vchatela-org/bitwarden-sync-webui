export type StepState = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'warning' | 'awaiting-input';
export type JobState = 'queued' | 'running' | 'awaiting-credentials' | 'awaiting-confirmation' | 'succeeded' | 'failed' | 'partial' | 'aborted';

export interface Step {
  id: string;
  label: string;
  state: StepState;
  startedAt?: string;
  endedAt?: string;
  detail?: string;
  group: string;
}

export interface LogLine {
  ts: string;
  stream: 'stdout' | 'stderr' | 'app';
  step?: string;
  line: string;
}

export interface DiffItem {
  type: number;
  name: string;
  username?: string | null;
}

export interface DiffResult {
  sourceCount: number | 'unknown';
  destCount: number;
  added: DiffItem[];
  removed: DiffItem[];
  unchanged: number;
  guardTripped: boolean;
  guardReason?: string;
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
  operations: string[];
  options: Record<string, unknown>;
  steps: Step[];
  logs: LogLine[];
  prompt?: Prompt;
  results?: Record<string, { source?: number; dest?: number }>;
}

export interface VaultConfig {
  key: string;
  name: string;
  serverUrl: string;
}

export interface UserConfig {
  key: string;
  email: string;
  displayName?: string;
  from: string;
  to: string;
}

export interface OrgConfig {
  key: string;
  name: string;
  owner: string;
  from: string;
  to: string;
}

export interface AppConfig {
  vaults: VaultConfig[];
  users: UserConfig[];
  orgs: OrgConfig[];
  retention: { keepDaily: number; keepMonthly: number };
  importGuard: { minSourceRatio: number; blockOnEmptySource: boolean };
  homeLogoutAfterImport: boolean;
  cliVersion: string;
  appVersion: string;
}

export interface BackupFile {
  path: string;
  filename: string;
  targetKey: string;
  kind: 'user' | 'org';
  timestamp: string;
  fileType: string;
  sizeBytes: number;
}

export interface BackupMeta {
  target: string;
  kind: 'user' | 'org';
  timestamp: string;
  itemCount?: number;
  folderCount?: number;
  collectionCount?: number | null;
  sourceServer?: string;
  cliVersion?: string;
  exportFile?: string;
  sizeBytes?: number;
  sha256?: string;
}

export interface BackupSet {
  targetKey: string;
  kind: 'user' | 'org';
  timestamp: string;
  files: BackupFile[];
  sizeBytes: number;
  meta?: BackupMeta;
  /** Items in the set — from the sidecar when it exists, else read off the export itself. */
  itemCount?: number;
  folderCount?: number;
  collectionCount?: number | null;
  countSource?: 'meta' | 'export';
}

export interface BackupInventory {
  managed: BackupSet[];
  unmanaged: string[];
}

export interface IntegrityResult {
  path: string;
  ok: boolean;
  reason?: string;
}

export interface PruneCandidate {
  targetKey: string;
  timestamp: string;
  files: string[];
  sizeBytes: number;
}

export interface PruneSummary {
  toDelete: PruneCandidate[];
  totalBytes: number;
  dryRun: boolean;
}

export type VaultStatus = {
  status: string;
  serverUrl: string;
  userEmail?: string;
  lastSync?: string;
} | null;

export interface TargetStatus {
  source: VaultStatus;
  dest: VaultStatus;
}
