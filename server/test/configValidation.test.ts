import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TMP = mkdtempSync(join(tmpdir(), 'bw-config-test-'));

function writeConfig(obj: unknown): string {
  const p = join(TMP, `config-${Date.now()}-${Math.random()}.json`);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

const VAULTS = [
  { key: 'cloud', name: 'Cloud', serverUrl: 'https://vault.bitwarden.eu' },
  { key: 'home', name: 'Home', serverUrl: 'https://home.example.com' },
];

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    vaults: VAULTS,
    backupFolder: '/backups',
    bitwardenConfigDir: '/data/bitwarden',
    users: [{ key: 'val', email: 'val@example.com', from: 'cloud', to: 'home' }],
    ...overrides,
  };
}

describe('loadConfig', () => {
  afterAll(() => { try { rmSync(TMP, { recursive: true }); } catch {} });

  it('loads a valid config', () => {
    const p = writeConfig(baseConfig());
    const r = loadConfig(p);
    expect(r.ok).toBe(true);
  });

  it('rejects missing required fields', () => {
    const p = writeConfig({
      vaults: VAULTS,
      // missing backupFolder, bitwardenConfigDir, users etc.
    });
    const r = loadConfig(p);
    expect(r.ok).toBe(false);
  });

  it('rejects a duplicate vault key', () => {
    const p = writeConfig(baseConfig({
      vaults: [...VAULTS, { key: 'cloud', name: 'Cloud again', serverUrl: 'https://vault.bitwarden.com' }],
    }));
    const r = loadConfig(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/duplicate vault key/i);
  });

  it('rejects a user with an unknown from-vault', () => {
    const p = writeConfig(baseConfig({
      users: [{ key: 'val', email: 'val@example.com', from: 'nope', to: 'home' }],
    }));
    const r = loadConfig(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown from-vault/i);
  });

  it('rejects a user with an unknown to-vault', () => {
    const p = writeConfig(baseConfig({
      users: [{ key: 'val', email: 'val@example.com', from: 'cloud', to: 'nope' }],
    }));
    const r = loadConfig(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown to-vault/i);
  });

  it('rejects a user with the same from and to vault', () => {
    const p = writeConfig(baseConfig({
      users: [{ key: 'val', email: 'val@example.com', from: 'cloud', to: 'cloud' }],
    }));
    const r = loadConfig(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/same from and to vault/i);
  });

  it('rejects org with no owner', () => {
    const p = writeConfig(baseConfig({
      orgs: [{
        key: 'org', name: 'My Org', owner: '', from: 'cloud', to: 'home',
        orgIds: { cloud: '00000000-0000-0000-0000-000000000001', home: '00000000-0000-0000-0000-000000000002' },
      }],
    }));
    const r = loadConfig(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/owner/i);
  });

  it('rejects org with owner not in users', () => {
    const p = writeConfig(baseConfig({
      orgs: [{
        key: 'org', name: 'My Org', owner: 'unknown-user', from: 'cloud', to: 'home',
        orgIds: { cloud: '00000000-0000-0000-0000-000000000001', home: '00000000-0000-0000-0000-000000000002' },
      }],
    }));
    const r = loadConfig(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/owner/i);
  });

  it('rejects org with the same from and to vault', () => {
    const p = writeConfig(baseConfig({
      orgs: [{
        key: 'org', name: 'My Org', owner: 'val', from: 'cloud', to: 'cloud',
        orgIds: { cloud: '00000000-0000-0000-0000-000000000001', home: '00000000-0000-0000-0000-000000000002' },
      }],
    }));
    const r = loadConfig(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/same from and to vault/i);
  });

  it('rejects org with missing orgIds entry for its from-vault', () => {
    const p = writeConfig(baseConfig({
      orgs: [{
        key: 'org', name: 'My Org', owner: 'val', from: 'cloud', to: 'home',
        orgIds: { home: '00000000-0000-0000-0000-000000000002' },
      }],
    }));
    const r = loadConfig(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/orgIds\['cloud'\]/);
  });

  it('rejects org with missing orgIds entry for its to-vault', () => {
    const p = writeConfig(baseConfig({
      orgs: [{
        key: 'org', name: 'My Org', owner: 'val', from: 'cloud', to: 'home',
        orgIds: { cloud: '00000000-0000-0000-0000-000000000001' },
      }],
    }));
    const r = loadConfig(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/orgIds\['home'\]/);
  });

  it('loads a valid config with an org', () => {
    const p = writeConfig(baseConfig({
      orgs: [{
        key: 'org', name: 'My Org', owner: 'val', from: 'cloud', to: 'home',
        orgIds: { cloud: '00000000-0000-0000-0000-000000000001', home: '00000000-0000-0000-0000-000000000002' },
      }],
    }));
    const r = loadConfig(p);
    expect(r.ok).toBe(true);
  });

  it('returns an error for a non-existent path', () => {
    const r = loadConfig('/nonexistent/path/config.json');
    expect(r.ok).toBe(false);
  });
});
