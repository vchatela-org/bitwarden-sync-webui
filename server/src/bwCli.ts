import { spawn, SpawnOptionsWithoutStdio } from 'child_process';
import { mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { randomBytes } from 'crypto';
import { redact } from './redact.js';

const BW_BIN = process.env['BW_BIN'] ?? 'bw';
const PINNED_VERSION = process.env['BW_CLI_PINNED_VERSION'] ?? '2025.12.0';
const FIFO_DIR = process.env['BW_FIFO_DIR'] ?? '/run/bw-fifo';

export interface BwSpawnOpts {
  profileDir: string;
  sessionKey?: string;
  stdin?: string; // written to piped stdin
  fifoPassword?: string; // if set, creates a FIFO and passes its path as --passwordfile arg position
  timeout?: number; // ms
  // Commands like `list items` / `get item` / `edit item` print full vault contents
  // (names, usernames, passwords, TOTP seeds, notes) to stdout as JSON. That output is
  // for this process to parse, not for the job log/UI — set this to keep it out of
  // onLog entirely (redact() only scrubs known secret *shapes*, it can't safely scrub
  // arbitrary vault field values). stdout is still captured and returned to the caller.
  silenceStdout?: boolean;
}

export interface BwResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Sanitised environment for bw child processes */
function buildEnv(profileDir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    NODE_OPTIONS: '--no-deprecation',
    BITWARDENCLI_APPDATA_DIR: profileDir,
    NODE_EXTRA_CA_CERTS: process.env['NODE_EXTRA_CA_CERTS'],
    TMPDIR: '/tmp',
    TMP: '/tmp',
    TEMP: '/tmp',
  };
}

let detectedCliVersion: string | null = null;

export async function getCliVersion(): Promise<string> {
  if (detectedCliVersion) return detectedCliVersion;
  const result = await runBw(['--version'], {
    profileDir: '/tmp',
    timeout: 5000,
  });
  detectedCliVersion = result.stdout.trim();
  return detectedCliVersion;
}

export async function assertCliVersion(): Promise<void> {
  const ver = await getCliVersion();
  if (ver !== PINNED_VERSION) {
    const msg = `bw CLI version mismatch: expected ${PINNED_VERSION}, got ${ver}. Update BW_CLI_PINNED_VERSION or fix the CLI.`;
    console.warn(`[bwCli] WARNING: ${msg}`);
    // Don't hard-fail — just warn, in case the pinned version constant is stale
  }
}

/** Create a FIFO, write password, return path. Cleans up automatically. */
async function createFifo(password: string): Promise<{ path: string; cleanup: () => void }> {
  mkdirSync(FIFO_DIR, { recursive: true, mode: 0o700 });
  const fifoPath = join(FIFO_DIR, `pw-${randomBytes(8).toString('hex')}`);

  // On Linux use mkfifo for secure password passing; fall back to a regular
  // file on Windows (tests, dev). mkfifo is not in Node's fs module — use execFileSync
  // (argv array, not a shell string) so nothing in fifoPath can be interpreted by a shell.
  try {
    const { execFileSync } = await import('child_process');
    execFileSync('mkfifo', ['-m', '600', fifoPath]);
  } catch {
    // mkfifo not available (Windows/tests), fall back to a regular file.
    // fifoPath is server-generated (FIFO_DIR + random hex, never request input),
    // the file is 0600 and unlinked by cleanup() right after the bw CLI reads it —
    // this is the intended password-handoff path, not an arbitrary file write.
    // codeql[js/http-to-file-access]
    writeFileSync(fifoPath, password + '\n', { mode: 0o600 });
    return {
      path: fifoPath,
      cleanup: () => { try { unlinkSync(fifoPath); } catch { /* ignore */ } },
    };
  }

  // Write asynchronously — the FIFO blocks until the reader opens it
  const { createWriteStream } = await import('fs');
  const writePromise = new Promise<void>((res, rej) => {
    const ws = createWriteStream(fifoPath);
    ws.on('open', () => {
      // Same rationale as the fallback write above: fifoPath is server-generated,
      // the FIFO is 0600 and consumed once by the bw CLI, then unlinked.
      // codeql[js/http-to-file-access]
      ws.write(password + '\n', (err) => {
        ws.close();
        if (err) rej(err); else res();
      });
    });
    ws.on('error', rej);
    setTimeout(() => rej(new Error('FIFO write timeout')), 5000);
  });

  // Don't await here — let it write when the child reads
  writePromise.catch(() => { /* child may never open FIFO */ });

  return {
    path: fifoPath,
    cleanup: () => { try { unlinkSync(fifoPath); } catch { /* ignore */ } },
  };
}

export type LogCallback = (stream: 'stdout' | 'stderr', line: string) => void;

export async function runBw(
  args: string[],
  opts: BwSpawnOpts,
  onLog?: LogCallback,
): Promise<BwResult> {
  const env = buildEnv(opts.profileDir);
  const spawnOpts: SpawnOptionsWithoutStdio = {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  };

  let fifoCleanup: (() => void) | null = null;
  let finalArgs = [...args];

  if (opts.fifoPassword !== undefined) {
    const fifo = await createFifo(opts.fifoPassword);
    fifoCleanup = fifo.cleanup;
    // Insert --passwordfile <path> before --nointeraction if present
    const niIdx = finalArgs.indexOf('--nointeraction');
    if (niIdx >= 0) {
      finalArgs.splice(niIdx, 0, '--passwordfile', fifo.path);
    } else {
      finalArgs.push('--passwordfile', fifo.path);
    }
  }

  // Always add --nointeraction to prevent CLI from blocking on TTY
  if (!finalArgs.includes('--nointeraction')) {
    finalArgs.push('--nointeraction');
  }

  const child = spawn(BW_BIN, finalArgs, spawnOpts);

  // Write stdin if provided
  if (opts.stdin !== undefined) {
    child.stdin!.write(opts.stdin + '\n');
    child.stdin!.end();
  } else {
    child.stdin!.end();
  }

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  child.stdout!.setEncoding('utf-8');
  child.stderr!.setEncoding('utf-8');

  let stdoutBuf = '';
  child.stdout!.on('data', (chunk: string) => {
    stdoutBuf += chunk;
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() ?? '';
    for (const line of lines) {
      const redacted = redact(line);
      stdoutChunks.push(redacted);
      if (!opts.silenceStdout) onLog?.('stdout', redacted);
    }
  });

  let stderrBuf = '';
  child.stderr!.on('data', (chunk: string) => {
    stderrBuf += chunk;
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop() ?? '';
    for (const line of lines) {
      const redacted = redact(line);
      stderrChunks.push(redacted);
      onLog?.('stderr', redacted);
    }
  });

  return new Promise((resolve, reject) => {
    const timer = opts.timeout
      ? setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error(`bw command timed out after ${opts.timeout}ms`));
        }, opts.timeout)
      : null;

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      fifoCleanup?.();

      // Flush remaining buffered lines
      if (stdoutBuf) {
        const redacted = redact(stdoutBuf);
        stdoutChunks.push(redacted);
        if (!opts.silenceStdout) onLog?.('stdout', redacted);
      }
      if (stderrBuf) {
        const redacted = redact(stderrBuf);
        stderrChunks.push(redacted);
        onLog?.('stderr', redacted);
      }

      resolve({
        stdout: stdoutChunks.join('\n'),
        stderr: stderrChunks.join('\n'),
        exitCode: code ?? 1,
      });
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      fifoCleanup?.();
      reject(err);
    });
  });
}

/** Parse a --response JSON payload from the CLI */
export interface BwResponse {
  success: boolean;
  message?: string;
  data?: unknown;
}

export function parseBwResponse(stdout: string): BwResponse | null {
  try {
    return JSON.parse(stdout.trim()) as BwResponse;
  } catch {
    return null;
  }
}

/** Validate that a string looks like a Bitwarden session key */
export function isValidSessionKey(s: string): boolean {
  return /^[A-Za-z0-9+/=]{20,}$/.test(s.trim());
}
