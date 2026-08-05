import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { inventoryBackups } from '../src/backups.js';
import { resetCountCache } from '../src/backupCounts.js';

let root: string;
let folder: string;
let dataDir: string;

/** An account-key encrypted export: ciphertext fields, countable envelope. */
function writeExport(name: string, items: number, folders = 0, collections = 0): void {
  writeFileSync(
    join(folder, name),
    JSON.stringify({
      encrypted: true,
      folders: Array.from({ length: folders }, (_, i) => ({ id: `f${i}`, name: '2.abc==|def|ghi=' })),
      collections: Array.from({ length: collections }, (_, i) => ({ id: `c${i}` })),
      items: Array.from({ length: items }, (_, i) => ({ id: `i${i}`, name: '2.abc==|def|ghi=' })),
    }),
  );
}

/** A password-protected export: one opaque blob, nothing to count. */
function writePassExport(name: string): void {
  writeFileSync(
    join(folder, name),
    JSON.stringify({ encrypted: true, passwordProtected: true, salt: 'x', data: '2.abc==|def|ghi=' }),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bw-counts-'));
  folder = join(root, 'backups');
  dataDir = join(root, 'data');
  mkdirSync(folder);
  process.env['DATA_DIR'] = dataDir;
  resetCountCache();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env['DATA_DIR'];
  resetCountCache();
});

describe('inventoryBackups counts', () => {
  it('derives counts from the encrypted export when no sidecar exists', () => {
    writeExport('bitwarden_export_val_20260805_101500_encrypted.json', 2097, 13);
    writePassExport('bitwarden_export_val_20260805_101500_encrypted_pass.json');

    const [set] = inventoryBackups(folder, ['val'], { deriveCounts: true }).managed;
    expect(set.itemCount).toBe(2097);
    expect(set.folderCount).toBe(13);
    expect(set.countSource).toBe('export');
  });

  it('reports no collection count for a personal vault', () => {
    writeExport('bitwarden_export_val_20260805_101500_encrypted.json', 10);
    const [set] = inventoryBackups(folder, ['val'], { deriveCounts: true }).managed;
    expect(set.collectionCount).toBeNull();
  });

  it('derives collection counts for an org export', () => {
    writeExport('bitwarden_org_export_org_20260805_101500_encrypted.json', 420, 0, 3);
    const [set] = inventoryBackups(folder, ['org'], { deriveCounts: true }).managed;
    expect(set.itemCount).toBe(420);
    expect(set.collectionCount).toBe(3);
  });

  it('prefers the sidecar over the export when both are present', () => {
    writeExport('bitwarden_export_val_20260805_101500_encrypted.json', 10);
    writeFileSync(
      join(folder, 'bitwarden_export_val_20260805_101500.meta.json'),
      JSON.stringify({ target: 'val', kind: 'user', timestamp: '20260805_101500', itemCount: 42, folderCount: 7 }),
    );

    const [set] = inventoryBackups(folder, ['val'], { deriveCounts: true }).managed;
    expect(set.itemCount).toBe(42);
    expect(set.folderCount).toBe(7);
    expect(set.countSource).toBe('meta');
  });

  it('leaves counts undefined when only a password-protected export survives', () => {
    writePassExport('bitwarden_export_val_20260805_101500_encrypted_pass.json');
    const [set] = inventoryBackups(folder, ['val'], { deriveCounts: true }).managed;
    expect(set.itemCount).toBeUndefined();
    expect(set.countSource).toBeUndefined();
  });

  it('does not read export contents unless asked to', () => {
    writeExport('bitwarden_export_val_20260805_101500_encrypted.json', 10);
    const [set] = inventoryBackups(folder, ['val']).managed;
    expect(set.itemCount).toBeUndefined();
  });

  it('persists derived counts so a restart does not re-read every export', () => {
    const name = 'bitwarden_export_val_20260805_101500_encrypted.json';
    writeExport(name, 314);
    expect(inventoryBackups(folder, ['val'], { deriveCounts: true }).managed[0].itemCount).toBe(314);

    const cached = JSON.parse(readFileSync(join(dataDir, 'backup-counts.json'), 'utf-8'));
    expect(cached[join(folder, name)]).toMatchObject({ itemCount: 314, folderCount: 0 });
  });

  it('answers from the cache instead of parsing the export again', () => {
    const name = 'bitwarden_export_val_20260805_101500_encrypted.json';
    const path = join(folder, name);
    writeExport(name, 314);

    // Seed a deliberately wrong count under the file's real identity. Getting it
    // back proves the export itself was never opened.
    const stat = statSync(path);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, 'backup-counts.json'),
      JSON.stringify({
        [path]: { itemCount: 999, folderCount: 1, collectionCount: 0, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) },
      }),
    );

    resetCountCache();
    expect(inventoryBackups(folder, ['val'], { deriveCounts: true }).managed[0].itemCount).toBe(999);
  });

  it('re-reads an export whose size or mtime changed', () => {
    const name = 'bitwarden_export_val_20260805_101500_encrypted.json';
    writeExport(name, 314);
    expect(inventoryBackups(folder, ['val'], { deriveCounts: true }).managed[0].itemCount).toBe(314);

    writeExport(name, 315);
    resetCountCache();
    expect(inventoryBackups(folder, ['val'], { deriveCounts: true }).managed[0].itemCount).toBe(315);
  });

  it('survives a corrupt export file', () => {
    writeFileSync(join(folder, 'bitwarden_export_val_20260805_101500_encrypted.json'), '{ truncated');
    const [set] = inventoryBackups(folder, ['val'], { deriveCounts: true }).managed;
    expect(set.itemCount).toBeUndefined();
  });
});
