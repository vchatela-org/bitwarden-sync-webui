import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TMP = mkdtempSync(join(tmpdir(), 'bw-config-test-'));

function writeConfig(obj: unknown): string {
  const p = join(TMP, `config-${Date.now()}.json`);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

describe('loadConfig', () => {
  afterAll(() => { try { rmSync(TMP, { recursive: true }); } catch {} });

  it('loads a valid config', () => {
    const p = writeConfig({
      cloudServerUrl: 'https://vault.bitwarden.eu',
      homeServerUrl: 'https://home.example.com',
      backupFolder: '/backups',
      bitwardenConfigDir: '/data/bitwarden',
      users: [{ key: 'val', email: 'val@example.com' }],
    });
    const r = loadConfig(p);
    expect(r.ok).toBe(true);
  });

  it('rejects missing required fields', () => {
    const p = writeConfig({
      cloudServerUrl: 'https://vault.bitwarden.eu',
      // missing homeServerUrl etc.
    });
    const r = loadConfig(p);
    expect(r.ok).toBe(false);
  });

  it('rejects org with no owner', () => {
    const p = writeConfig({
      cloudServerUrl: 'https://vault.bitwarden.eu',
      homeServerUrl: 'https://home.example.com',
      backupFolder: '/backups',
      bitwardenConfigDir: '/data/bitwarden',
      users: [{ key: 'val', email: 'val@example.com' }],
      orgs: [{ key: 'org', name: 'My Org', owner: '', saasId: '00000000-0000-0000-0000-000000000001', homeId: '00000000-0000-0000-0000-000000000002' }],
    });
    const r = loadConfig(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/owner/i);
  });

  it('rejects org with owner not in users', () => {
    const p = writeConfig({
      cloudServerUrl: 'https://vault.bitwarden.eu',
      homeServerUrl: 'https://home.example.com',
      backupFolder: '/backups',
      bitwardenConfigDir: '/data/bitwarden',
      users: [{ key: 'val', email: 'val@example.com' }],
      orgs: [{ key: 'org', name: 'My Org', owner: 'unknown-user', saasId: '00000000-0000-0000-0000-000000000001', homeId: '00000000-0000-0000-0000-000000000002' }],
    });
    const r = loadConfig(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/owner/i);
  });

  it('rejects org with missing saasId', () => {
    const p = writeConfig({
      cloudServerUrl: 'https://vault.bitwarden.eu',
      homeServerUrl: 'https://home.example.com',
      backupFolder: '/backups',
      bitwardenConfigDir: '/data/bitwarden',
      users: [{ key: 'val', email: 'val@example.com' }],
      orgs: [{ key: 'org', name: 'My Org', owner: 'val', saasId: '', homeId: '00000000-0000-0000-0000-000000000002' }],
    });
    const r = loadConfig(p);
    expect(r.ok).toBe(false);
  });

  it('returns an error for a non-existent path', () => {
    const r = loadConfig('/nonexistent/path/config.json');
    expect(r.ok).toBe(false);
  });
});
