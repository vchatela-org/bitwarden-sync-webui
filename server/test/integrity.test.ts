import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { checkIntegrity, BackupSet, BackupFile } from '../src/backups.js';

let folder: string;

function write(name: string, content: string): BackupFile {
  const path = join(folder, name);
  writeFileSync(path, content);
  return {
    path,
    filename: name,
    targetKey: 'val',
    kind: 'user',
    timestamp: '20260805_101500',
    fileType: name.endsWith('_encrypted_pass.json') ? 'encrypted_pass' : 'encrypted',
    sizeBytes: Buffer.byteLength(content),
  };
}

beforeEach(() => { folder = mkdtempSync(join(tmpdir(), 'bw-integrity-')); });
afterEach(() => { rmSync(folder, { recursive: true, force: true }); });

describe('checkIntegrity', () => {
  it('checks the sidecar hash only against the file the sidecar names', () => {
    const encContent = JSON.stringify({ encrypted: true, items: [{ id: 'a' }] });
    const passContent = JSON.stringify({ encrypted: true, passwordProtected: true, data: 'blob' });
    const enc = write('bitwarden_export_val_20260805_101500_encrypted.json', encContent);
    const pass = write('bitwarden_export_val_20260805_101500_encrypted_pass.json', passContent);

    const set: BackupSet = {
      targetKey: 'val',
      kind: 'user',
      timestamp: '20260805_101500',
      files: [enc, pass],
      sizeBytes: enc.sizeBytes + pass.sizeBytes,
      meta: {
        target: 'val',
        kind: 'user',
        timestamp: '20260805_101500',
        exportFile: pass.filename,
        sizeBytes: pass.sizeBytes,
        sha256: createHash('sha256').update(passContent).digest('hex'),
      },
    };

    // The account-key export has a different hash and size by construction; it
    // must still pass rather than be reported as corrupt.
    expect(checkIntegrity(set)).toEqual([
      { path: enc.path, ok: true },
      { path: pass.path, ok: true },
    ]);
  });

  it('reports a hash mismatch on the file the sidecar covers', () => {
    const pass = write('bitwarden_export_val_20260805_101500_encrypted_pass.json', '{"data":"tampered"}');
    const set: BackupSet = {
      targetKey: 'val',
      kind: 'user',
      timestamp: '20260805_101500',
      files: [pass],
      sizeBytes: pass.sizeBytes,
      meta: {
        target: 'val',
        kind: 'user',
        timestamp: '20260805_101500',
        exportFile: pass.filename,
        sha256: 'deadbeef',
      },
    };
    const [result] = checkIntegrity(set);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/SHA256 mismatch/);
  });

  it('reports malformed JSON with or without a sidecar', () => {
    const broken = write('bitwarden_export_val_20260805_101500_encrypted.json', '{ truncated');
    const set: BackupSet = {
      targetKey: 'val',
      kind: 'user',
      timestamp: '20260805_101500',
      files: [broken],
      sizeBytes: broken.sizeBytes,
    };
    expect(checkIntegrity(set)[0].ok).toBe(false);
  });
});
