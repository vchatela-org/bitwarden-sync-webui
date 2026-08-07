import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { countExportItems } from '../src/backups.js';
import { resetCountCache } from '../src/backupCounts.js';
import { computeDiff, DiffItem } from '../src/diff.js';

let root: string;
let folder: string;

function writeExport(name: string, items: number, folders = 0): void {
  writeFileSync(
    join(folder, name),
    JSON.stringify({
      encrypted: true,
      folders: Array.from({ length: folders }, (_, i) => ({ id: `f${i}` })),
      items: Array.from({ length: items }, (_, i) => ({ id: `i${i}` })),
    }),
  );
}

function writePassExport(name: string): void {
  writeFileSync(
    join(folder, name),
    JSON.stringify({ encrypted: true, passwordProtected: true, data: '2.abc==|def|ghi=' }),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bw-srccount-'));
  folder = join(root, 'backups');
  mkdirSync(folder);
  process.env['DATA_DIR'] = join(root, 'data');
  resetCountCache();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env['DATA_DIR'];
  resetCountCache();
});

describe('countExportItems', () => {
  const passName = 'bitwarden_export_val_20260805_101500_encrypted_pass.json';

  it('prefers the sidecar when one exists', () => {
    writePassExport(passName);
    writeExport('bitwarden_export_val_20260805_101500_encrypted.json', 999);
    writeFileSync(
      join(folder, 'bitwarden_export_val_20260805_101500.meta.json'),
      JSON.stringify({ target: 'val', kind: 'user', timestamp: '20260805_101500', itemCount: 2097 }),
    );

    expect(countExportItems(join(folder, passName))).toEqual({ itemCount: 2097, source: 'meta' });
  });

  it('falls back to the account-key export when there is no sidecar', () => {
    writePassExport(passName);
    writeExport('bitwarden_export_val_20260805_101500_encrypted.json', 2097, 13);

    expect(countExportItems(join(folder, passName))).toEqual({ itemCount: 2097, source: 'export' });
  });

  it('ignores a corrupt sidecar and falls through to the export', () => {
    writePassExport(passName);
    writeExport('bitwarden_export_val_20260805_101500_encrypted.json', 42);
    writeFileSync(join(folder, 'bitwarden_export_val_20260805_101500.meta.json'), '{ not json');

    expect(countExportItems(join(folder, passName))).toEqual({ itemCount: 42, source: 'export' });
  });

  it('resolves an org set through the org filename prefix', () => {
    const orgPass = 'bitwarden_org_export_acme_20260805_101500_encrypted_pass.json';
    writePassExport(orgPass);
    writeExport('bitwarden_org_export_acme_20260805_101500_encrypted.json', 7);

    expect(countExportItems(join(folder, orgPass))).toEqual({ itemCount: 7, source: 'export' });
  });

  it('returns null when only the opaque password-protected export survives', () => {
    writePassExport(passName);
    expect(countExportItems(join(folder, passName))).toBeNull();
  });

  it('returns null for a filename it cannot parse', () => {
    writeFileSync(join(folder, 'random.json'), '{}');
    expect(countExportItems(join(folder, 'random.json'))).toBeNull();
  });
});

/** `computeDiff` reaches the vault through listItems; stub it per test. */
vi.mock('../src/session.js', () => ({ listItems: vi.fn() }));
const { listItems } = await import('../src/session.js');

function vaultItem(name: string, username?: string): Record<string, unknown> {
  return { type: 1, name, login: { username: username ?? null } };
}

describe('computeDiff source resolution', () => {
  const dest = { destProfileDir: '/tmp/p', destSessionKey: 'sess' };

  beforeEach(() => {
    vi.mocked(listItems).mockReset();
  });

  it('uses items captured during the backup phase and diffs them by name', async () => {
    vi.mocked(listItems).mockResolvedValue([vaultItem('github', 'me'), vaultItem('stale')]);
    const captured: DiffItem[] = [
      { type: 1, name: 'github', username: 'me' },
      { type: 1, name: 'fresh', username: null },
    ];

    const result = await computeDiff({ ...dest, sourceItems: captured });

    expect(result.sourceCount).toBe(2);
    expect(result.sourceCountOrigin).toBe('captured');
    expect(result.guardTripped).toBe(false);
    expect(result.unchanged).toBe(1);
    expect(result.added.map((i) => i.name)).toEqual(['fresh']);
    expect(result.removed.map((i) => i.name)).toEqual(['stale']);
    // The source was never listed live — only the destination was.
    expect(listItems).toHaveBeenCalledTimes(1);
  });

  it('accepts a bare count when the items are not available', async () => {
    vi.mocked(listItems).mockResolvedValue([vaultItem('a'), vaultItem('b')]);

    const result = await computeDiff({ ...dest, sourceCount: 2, sourceCountOrigin: 'meta' });

    expect(result.sourceCount).toBe(2);
    expect(result.sourceCountOrigin).toBe('meta');
    expect(result.guardTripped).toBe(false);
    // No item list, so no name-level diff to show.
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it('still reports unknown when nothing about the source is supplied', async () => {
    vi.mocked(listItems).mockResolvedValue([vaultItem('a')]);

    const result = await computeDiff(dest);

    expect(result.sourceCount).toBe('unknown');
    expect(result.guardTripped).toBe(true);
    expect(result.guardReason).toMatch(/unknown/i);
  });

  it('trips the guard on a real shortfall rather than on missing data', async () => {
    vi.mocked(listItems).mockResolvedValue(
      Array.from({ length: 100 }, (_, i) => vaultItem(`item${i}`)),
    );

    const result = await computeDiff({
      ...dest,
      sourceItems: Array.from({ length: 10 }, (_, i) => ({ type: 1, name: `item${i}`, username: null })),
    });

    expect(result.guardTripped).toBe(true);
    expect(result.guardReason).toMatch(/10/);
    expect(result.sourceCount).toBe(10);
  });

  it('diffs past the old 200-item cap', async () => {
    // 300 destination items, the same 300 on the source: nothing added or removed.
    const names = Array.from({ length: 300 }, (_, i) => `item${i}`);
    vi.mocked(listItems).mockResolvedValue(names.map((n) => vaultItem(n)));

    const result = await computeDiff({
      ...dest,
      sourceItems: names.map((n) => ({ type: 1, name: n, username: null })),
    });

    expect(result.unchanged).toBe(300);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });
});
