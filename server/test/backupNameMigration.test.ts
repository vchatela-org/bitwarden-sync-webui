import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  correctedBackupFilename,
  migrateLegacyBackupNames,
  parseBackupFilename,
  BackupMeta,
} from '../src/backups.js';

/**
 * Names as the pre-v1.6.2 builder produced them: the timestamp carries a trailing '.'
 * because the ISO string was sliced at 15 characters instead of 14.
 */
const LEGACY_USER_ENC = 'bitwarden_export_val_20260807_122405._encrypted.json';
const LEGACY_USER_PASS = 'bitwarden_export_val_20260807_122405._encrypted_pass.json';
const LEGACY_USER_META = 'bitwarden_export_val_20260807_122405..meta.json';
const LEGACY_ORG_PASS = 'bitwarden_org_export_org_20260807_122405._encrypted_pass.json';

describe('correctedBackupFilename', () => {
  it('drops the stray dot from a user export', () => {
    expect(correctedBackupFilename(LEGACY_USER_ENC))
      .toBe('bitwarden_export_val_20260807_122405_encrypted.json');
  });

  it('drops the stray dot from a password-protected export', () => {
    expect(correctedBackupFilename(LEGACY_USER_PASS))
      .toBe('bitwarden_export_val_20260807_122405_encrypted_pass.json');
  });

  it('drops the stray dot from an org export', () => {
    expect(correctedBackupFilename(LEGACY_ORG_PASS))
      .toBe('bitwarden_org_export_org_20260807_122405_encrypted_pass.json');
  });

  it('collapses the doubled dot in a sidecar', () => {
    expect(correctedBackupFilename(LEGACY_USER_META))
      .toBe('bitwarden_export_val_20260807_122405.meta.json');
  });

  it('leaves an already-correct name alone', () => {
    expect(correctedBackupFilename('bitwarden_export_val_20260807_122405_encrypted.json')).toBeNull();
    expect(correctedBackupFilename('bitwarden_export_val_20260807_122405.meta.json')).toBeNull();
  });

  it('ignores unrelated files', () => {
    expect(correctedBackupFilename('notes.txt')).toBeNull();
    expect(correctedBackupFilename('bitwarden_export_val.json')).toBeNull();
  });

  it('handles a target key containing underscores', () => {
    expect(correctedBackupFilename('bitwarden_export_val_home_20260807_122405._encrypted.json'))
      .toBe('bitwarden_export_val_home_20260807_122405_encrypted.json');
  });

  it('produces names that parseBackupFilename accepts', () => {
    for (const legacy of [LEGACY_USER_ENC, LEGACY_USER_PASS, LEGACY_USER_META, LEGACY_ORG_PASS]) {
      expect(parseBackupFilename(legacy)).toBeNull(); // the bug: none of these parse
      expect(parseBackupFilename(correctedBackupFilename(legacy)!)).not.toBeNull();
    }
  });
});

describe('migrateLegacyBackupNames', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bw-migrate-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, content = '{}'): void {
    writeFileSync(join(dir, name), content);
  }

  it('renames a whole legacy set and leaves nothing behind', () => {
    write(LEGACY_USER_ENC);
    write(LEGACY_USER_PASS);
    write(LEGACY_USER_META, JSON.stringify({
      target: 'val',
      kind: 'user',
      timestamp: '20260807_122405.',
      itemCount: 2100,
      exportFile: LEGACY_USER_PASS,
    } satisfies BackupMeta));

    const result = migrateLegacyBackupNames(dir);
    expect(result).toEqual({ renamed: 3, skipped: 0 });

    const files = readdirSync(dir).sort();
    expect(files).toEqual([
      'bitwarden_export_val_20260807_122405.meta.json',
      'bitwarden_export_val_20260807_122405_encrypted.json',
      'bitwarden_export_val_20260807_122405_encrypted_pass.json',
    ]);
    expect(files.every((f) => parseBackupFilename(f) !== null)).toBe(true);
  });

  it('rewrites the sidecar so exportFile still names the file it describes', () => {
    write(LEGACY_USER_PASS);
    write(LEGACY_USER_META, JSON.stringify({
      target: 'val',
      kind: 'user',
      timestamp: '20260807_122405.',
      itemCount: 2100,
      exportFile: LEGACY_USER_PASS,
      sha256: 'abc',
    } satisfies BackupMeta));

    migrateLegacyBackupNames(dir);

    const meta = JSON.parse(
      readFileSync(join(dir, 'bitwarden_export_val_20260807_122405.meta.json'), 'utf-8'),
    ) as BackupMeta;
    expect(meta.timestamp).toBe('20260807_122405');
    expect(meta.exportFile).toBe('bitwarden_export_val_20260807_122405_encrypted_pass.json');
    expect(meta.itemCount).toBe(2100); // untouched
    expect(meta.sha256).toBe('abc');
  });

  it('leaves already-correct files untouched', () => {
    write('bitwarden_export_val_20260807_122405_encrypted.json');
    write('unrelated.txt');

    expect(migrateLegacyBackupNames(dir)).toEqual({ renamed: 0, skipped: 0 });
    expect(readdirSync(dir).sort()).toEqual([
      'bitwarden_export_val_20260807_122405_encrypted.json',
      'unrelated.txt',
    ]);
  });

  it('never overwrites an existing correctly-named file', () => {
    write(LEGACY_USER_ENC, 'legacy');
    write('bitwarden_export_val_20260807_122405_encrypted.json', 'current');

    const result = migrateLegacyBackupNames(dir);
    expect(result).toEqual({ renamed: 0, skipped: 1 });
    expect(readFileSync(join(dir, 'bitwarden_export_val_20260807_122405_encrypted.json'), 'utf-8'))
      .toBe('current');
    expect(readFileSync(join(dir, LEGACY_USER_ENC), 'utf-8')).toBe('legacy');
  });

  it('renames the export even when its sidecar is corrupt', () => {
    write(LEGACY_USER_PASS);
    write(LEGACY_USER_META, 'not json');

    const result = migrateLegacyBackupNames(dir);
    expect(result.renamed).toBe(2);
    expect(readdirSync(dir).sort()).toEqual([
      'bitwarden_export_val_20260807_122405.meta.json',
      'bitwarden_export_val_20260807_122405_encrypted_pass.json',
    ]);
  });

  it('is a no-op on a missing folder', () => {
    expect(migrateLegacyBackupNames(join(dir, 'nope'))).toEqual({ renamed: 0, skipped: 0 });
  });

  it('is idempotent', () => {
    write(LEGACY_USER_ENC);
    migrateLegacyBackupNames(dir);
    expect(migrateLegacyBackupNames(dir)).toEqual({ renamed: 0, skipped: 0 });
  });
});

describe('backup timestamp format', () => {
  // The exact expression runner.ts uses to stamp a backup set.
  function stamp(iso: string): string {
    return new Date(iso).toISOString().replace(/[-T:]/g, '').slice(0, 14).replace(/(\d{8})(\d{6})/, '$1_$2');
  }

  it('produces a timestamp with no trailing dot', () => {
    expect(stamp('2026-08-07T12:24:05.420Z')).toBe('20260807_122405');
  });

  it('produces filenames the parser round-trips', () => {
    const ts = stamp('2026-08-07T12:24:05.420Z');
    const name = `bitwarden_export_val_${ts}_encrypted_pass.json`;
    expect(parseBackupFilename(name)).toMatchObject({
      targetKey: 'val',
      kind: 'user',
      timestamp: '20260807_122405',
      fileType: 'encrypted_pass',
    });
  });
});
