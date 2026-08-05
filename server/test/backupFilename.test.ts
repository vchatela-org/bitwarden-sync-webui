import { describe, it, expect } from 'vitest';
import { parseBackupFilename, buildBackupFilename, BackupKind } from '../src/backups.js';

describe('parseBackupFilename', () => {
  it('parses a user encrypted file', () => {
    const r = parseBackupFilename('bitwarden_export_val_20260805_101500_encrypted.json');
    expect(r).toMatchObject({ targetKey: 'val', kind: 'user', timestamp: '20260805_101500', fileType: 'encrypted' });
  });

  it('parses a user encrypted_pass file', () => {
    const r = parseBackupFilename('bitwarden_export_val_20260805_101500_encrypted_pass.json');
    expect(r).toMatchObject({ targetKey: 'val', kind: 'user', timestamp: '20260805_101500', fileType: 'encrypted_pass' });
  });

  it('parses an org encrypted file', () => {
    const r = parseBackupFilename('bitwarden_org_export_org_20260805_101500_encrypted.json');
    expect(r).toMatchObject({ targetKey: 'org', kind: 'org', timestamp: '20260805_101500', fileType: 'encrypted' });
  });

  it('parses an org encrypted_pass file', () => {
    const r = parseBackupFilename('bitwarden_org_export_org_20260805_101500_encrypted_pass.json');
    expect(r).toMatchObject({ targetKey: 'org', kind: 'org', timestamp: '20260805_101500', fileType: 'encrypted_pass' });
  });

  it('parses a user meta file', () => {
    const r = parseBackupFilename('bitwarden_export_val_20260805_101500.meta.json');
    expect(r).toMatchObject({ targetKey: 'val', kind: 'user', timestamp: '20260805_101500', fileType: 'meta' });
  });

  it('parses an org meta file', () => {
    const r = parseBackupFilename('bitwarden_org_export_org_20260805_101500.meta.json');
    expect(r).toMatchObject({ targetKey: 'org', kind: 'org', timestamp: '20260805_101500', fileType: 'meta' });
  });

  it('returns null for legacy files (unmanaged)', () => {
    expect(parseBackupFilename('bitwarden_encrypted_export_val_20260805_101500.json')).toBeNull();
    expect(parseBackupFilename('bitwarden_encrypted_org_export_org_20260805_101500.json')).toBeNull();
    expect(parseBackupFilename('random_file.json')).toBeNull();
  });

  it('handles hyphenated target keys (val-pro)', () => {
    const r = parseBackupFilename('bitwarden_export_val-pro_20260805_101500_encrypted_pass.json');
    expect(r).toMatchObject({ targetKey: 'val-pro', kind: 'user', timestamp: '20260805_101500', fileType: 'encrypted_pass' });
  });

  it('personal glob does NOT match org files (prefix distinction)', () => {
    const orgFile = 'bitwarden_org_export_org_20260805_101500_encrypted_pass.json';
    const r = parseBackupFilename(orgFile);
    expect(r!.kind).toBe('org');
    // A regex that matches the user pattern should NOT match org prefix
    const userPrefixRe = /^bitwarden_export_/;
    expect(userPrefixRe.test(orgFile)).toBe(false);
  });
});

describe('buildBackupFilename roundtrip', () => {
  const cases: Array<[string, BackupKind, string, string]> = [
    ['val', 'user', '20260805_101500', 'encrypted'],
    ['val', 'user', '20260805_101500', 'encrypted_pass'],
    ['val', 'user', '20260805_101500', 'meta'],
    ['org', 'org', '20260805_101500', 'encrypted_pass'],
    ['org', 'org', '20260805_101500', 'meta'],
    ['val-pro', 'user', '20260805_101500', 'encrypted_pass'],
  ];

  for (const [key, kind, ts, type] of cases) {
    it(`roundtrip ${kind}/${key}/${type}`, () => {
      const filename = buildBackupFilename(key, kind, ts, type as never);
      const parsed = parseBackupFilename(filename);
      expect(parsed).toMatchObject({ targetKey: key, kind, timestamp: ts, fileType: type });
    });
  }
});
