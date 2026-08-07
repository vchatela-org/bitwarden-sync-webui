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

/** Where `sourceCount` came from — see the server's diff module. */
export type SourceCountOrigin = 'live' | 'captured' | 'meta' | 'export';

export interface DiffResult {
  sourceCount: number | 'unknown';
  sourceCountOrigin?: SourceCountOrigin;
  destCount: number;
  added: DiffItem[];
  removed: DiffItem[];
  unchanged: number;
  guardTripped: boolean;
  guardReason?: string;
}

export type CredentialDiffReason = 'password' | 'totp' | 'notes' | 'fields' | 'card';

export interface CredentialDiffItem extends DiffItem {
  reasons: CredentialDiffReason[];
}

/** Result of a secure (hashed) credential diff between source and destination vaults. */
export interface SecureDiffResult {
  sourceCount: number;
  destCount: number;
  onlyInSource: DiffItem[];
  onlyInDest: DiffItem[];
  credentialsDiffer: CredentialDiffItem[];
  identical: number;
}

export interface CredentialPrompt {
  kind: 'credentials';
  accountKey: string;
  accountEmail: string;
  displayName?: string;
  /** Sync keys this one login covers. */
  targets: string[];
  vaultKey: string;
  vaultName: string;
  needsOtp: boolean;
  otpMethod?: number;
  /** The code field is showing because the account is configured `otp: "required"`. */
  otpHinted?: boolean;
  /** Other endpoint accounts of `targets` — offered as "reuse this password for …". */
  counterparts: string[];
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
  secureDiffResults?: Record<string, SecureDiffResult>;
}

export interface VaultConfig {
  key: string;
  name: string;
  serverUrl: string;
  logoutAfterImport?: boolean;
}

/** One Bitwarden identity on one vault. */
export interface AccountConfig {
  key: string;
  vault: string;
  email: string;
  displayName?: string;
  otp: 'unknown' | 'required';
}

export interface OrgConfig {
  key: string;
  name: string;
  /** Vault keys this org exists on. */
  vaults: string[];
}

/** One directed route between two accounts — the unit jobs and backups are keyed on. */
export interface SyncConfig {
  key: string;
  displayName?: string;
  /** Account key on the source side. */
  from: string;
  /** Account key on the destination side. */
  to: string;
  /** Org key, when this route syncs an org rather than a personal vault. */
  org?: string;
}

export interface AppConfig {
  vaults: VaultConfig[];
  accounts: AccountConfig[];
  orgs: OrgConfig[];
  syncs: SyncConfig[];
  retention: { keepDaily: number; keepMonthly: number };
  importGuard: { minSourceRatio: number; blockOnEmptySource: boolean };
  logoutAfterImport: boolean;
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
