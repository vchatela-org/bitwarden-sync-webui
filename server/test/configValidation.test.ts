import { describe, it, expect, afterAll } from 'vitest';
import {
  loadConfig,
  profileDir,
  groupSyncsByAccount,
  counterpartAccounts,
  allTargetKeys,
  logoutAfterImport,
  syncOrgId,
  syncByKey,
  Config,
} from '../src/config.js';
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

const ACCOUNTS = [
  { key: 'val@cloud', vault: 'cloud', email: 'val@example.com' },
  { key: 'val@home', vault: 'home', email: 'val@home.example.com' },
];

const ORG_IDS = {
  cloud: '00000000-0000-0000-0000-000000000001',
  home: '00000000-0000-0000-0000-000000000002',
};

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    vaults: VAULTS,
    backupFolder: '/backups',
    bitwardenConfigDir: '/data/bitwarden',
    accounts: ACCOUNTS,
    syncs: [{ key: 'val', from: 'val@cloud', to: 'val@home' }],
    ...overrides,
  };
}

/** Loads a config that is expected to be valid, failing the test with the error if it is not. */
function loadOk(obj: Record<string, unknown>): Config {
  const r = loadConfig(writeConfig(obj));
  if (!r.ok) throw new Error(`expected a valid config, got: ${r.error}`);
  return r.config;
}

describe('loadConfig', () => {
  afterAll(() => { try { rmSync(TMP, { recursive: true }); } catch { /* ignore */ } });

  it('loads a valid config', () => {
    expect(loadConfig(writeConfig(baseConfig())).ok).toBe(true);
  });

  it('rejects missing required fields', () => {
    const r = loadConfig(writeConfig({ vaults: VAULTS }));
    expect(r.ok).toBe(false);
  });

  it('returns an error for a non-existent path', () => {
    expect(loadConfig('/nonexistent/path/config.json').ok).toBe(false);
  });

  it('points a pre-1.6 config at the migration notes instead of dumping zod issues', () => {
    const r = loadConfig(writeConfig({
      vaults: VAULTS,
      backupFolder: '/backups',
      bitwardenConfigDir: '/data',
      users: [{ key: 'val', email: 'val@example.com', from: 'cloud', to: 'home' }],
      orgs: [{ key: 'org', name: 'Org', owner: 'val', from: 'cloud', to: 'home', orgIds: ORG_IDS }],
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/pre-1\.6/i);
      expect(r.error).toMatch(/accounts/);
    }
  });

  describe('duplicate keys', () => {
    it('rejects a duplicate vault key', () => {
      const r = loadConfig(writeConfig(baseConfig({
        vaults: [...VAULTS, { key: 'cloud', name: 'Cloud again', serverUrl: 'https://vault.bitwarden.com' }],
      })));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/duplicate vault key/i);
    });

    it('rejects a duplicate account key', () => {
      const r = loadConfig(writeConfig(baseConfig({
        accounts: [...ACCOUNTS, { key: 'val@cloud', vault: 'home', email: 'other@example.com' }],
      })));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/duplicate account key/i);
    });

    it('rejects a duplicate sync key', () => {
      const r = loadConfig(writeConfig(baseConfig({
        syncs: [
          { key: 'val', from: 'val@cloud', to: 'val@home' },
          { key: 'val', from: 'val@home', to: 'val@cloud' },
        ],
      })));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/duplicate sync key/i);
    });

    it('rejects a sync key that collides with an account key', () => {
      const r = loadConfig(writeConfig(baseConfig({
        syncs: [{ key: 'val@home', from: 'val@cloud', to: 'val@home' }],
      })));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/same key as an account/i);
    });

    it('rejects a duplicate org key', () => {
      const r = loadConfig(writeConfig(baseConfig({
        orgs: [
          { key: 'org', name: 'One', ids: ORG_IDS },
          { key: 'org', name: 'Two', ids: ORG_IDS },
        ],
      })));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/duplicate org key/i);
    });
  });

  describe('accounts', () => {
    it('rejects an account on an unknown vault', () => {
      const r = loadConfig(writeConfig(baseConfig({
        accounts: [...ACCOUNTS, { key: 'ghost', vault: 'nope', email: 'ghost@example.com' }],
      })));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/unknown vault 'nope'/i);
    });

    it('rejects an account key that is not safe as a directory name', () => {
      for (const key of ['../escape', 'has/slash', '.hidden']) {
        const r = loadConfig(writeConfig(baseConfig({
          accounts: [...ACCOUNTS, { key, vault: 'home', email: 'x@example.com' }],
        })));
        expect(r.ok, `expected '${key}' to be rejected`).toBe(false);
      }
    });

    it('accepts @ in an account key and defaults otp to unknown', () => {
      const config = loadOk(baseConfig());
      expect(config.accounts[0]!.key).toBe('val@cloud');
      expect(config.accounts[0]!.otp).toBe('unknown');
    });

    it('keeps an explicit otp requirement and method', () => {
      const config = loadOk(baseConfig({
        accounts: [
          { ...ACCOUNTS[0], otp: 'required', otpMethod: 1 },
          ACCOUNTS[1],
        ],
      }));
      expect(config.accounts[0]!.otp).toBe('required');
      expect(config.accounts[0]!.otpMethod).toBe(1);
    });
  });

  describe('syncs', () => {
    it('rejects an unknown from-account', () => {
      const r = loadConfig(writeConfig(baseConfig({
        syncs: [{ key: 'val', from: 'nope', to: 'val@home' }],
      })));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/unknown from-account/i);
    });

    it('rejects an unknown to-account', () => {
      const r = loadConfig(writeConfig(baseConfig({
        syncs: [{ key: 'val', from: 'val@cloud', to: 'nope' }],
      })));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/unknown to-account/i);
    });

    it('rejects both endpoints living on the same vault', () => {
      const r = loadConfig(writeConfig(baseConfig({
        accounts: [...ACCOUNTS, { key: 'val2@cloud', vault: 'cloud', email: 'val2@example.com' }],
        syncs: [{ key: 'val', from: 'val@cloud', to: 'val2@cloud' }],
      })));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/same vault/i);
    });

    it('accepts endpoints with different emails — the point of the account model', () => {
      const config = loadOk(baseConfig());
      const [from, to] = [config.accounts[0]!, config.accounts[1]!];
      expect(from.email).not.toBe(to.email);
    });

    it('accepts several syncs sharing one source account', () => {
      const config = loadOk(baseConfig({
        accounts: [...ACCOUNTS, { key: 'val@offsite', vault: 'offsite', email: 'val@example.com' }],
        vaults: [...VAULTS, { key: 'offsite', name: 'Offsite', serverUrl: 'https://offsite.example.com' }],
        syncs: [
          { key: 'val-home', from: 'val@cloud', to: 'val@home' },
          { key: 'val-offsite', from: 'val@cloud', to: 'val@offsite' },
        ],
      }));
      expect(config.syncs).toHaveLength(2);
    });
  });

  describe('orgs', () => {
    it('loads a valid org sync', () => {
      const config = loadOk(baseConfig({
        orgs: [{ key: 'acme', name: 'Acme', ids: ORG_IDS }],
        syncs: [
          { key: 'val', from: 'val@cloud', to: 'val@home' },
          { key: 'acme-sync', from: 'val@cloud', to: 'val@home', org: 'acme' },
        ],
      }));
      const sync = syncByKey(config, 'acme-sync');
      expect(syncOrgId(config, sync, 'cloud')).toBe(ORG_IDS.cloud);
      expect(syncOrgId(config, sync, 'home')).toBe(ORG_IDS.home);
      // A personal route has no org id on any vault.
      expect(syncOrgId(config, syncByKey(config, 'val'), 'cloud')).toBeUndefined();
    });

    it('rejects a sync pointing at an unknown org', () => {
      const r = loadConfig(writeConfig(baseConfig({
        syncs: [{ key: 'val', from: 'val@cloud', to: 'val@home', org: 'ghost' }],
      })));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/unknown org 'ghost'/i);
    });

    it('rejects an org missing the id for a route endpoint vault', () => {
      const r = loadConfig(writeConfig(baseConfig({
        orgs: [{ key: 'acme', name: 'Acme', ids: { cloud: ORG_IDS.cloud } }],
        syncs: [{ key: 'acme-sync', from: 'val@cloud', to: 'val@home', org: 'acme' }],
      })));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/missing ids\['home'\]/);
    });

    it('rejects an org id for a vault that does not exist', () => {
      const r = loadConfig(writeConfig(baseConfig({
        orgs: [{ key: 'acme', name: 'Acme', ids: { ...ORG_IDS, ghost: ORG_IDS.cloud } }],
      })));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/unknown vault 'ghost'/i);
    });

    it('allows an org that only exists on some vaults, as long as its routes are covered', () => {
      // Three vaults, org absent from the third — the cloud→home route is still valid.
      const config = loadOk(baseConfig({
        vaults: [...VAULTS, { key: 'offsite', name: 'Offsite', serverUrl: 'https://offsite.example.com' }],
        orgs: [{ key: 'acme', name: 'Acme', ids: ORG_IDS }],
        syncs: [{ key: 'acme-sync', from: 'val@cloud', to: 'val@home', org: 'acme' }],
      }));
      expect(syncOrgId(config, syncByKey(config, 'acme-sync'), 'offsite')).toBeUndefined();
    });
  });

  describe('logoutAfterImport', () => {
    it('defaults to true for every vault', () => {
      const config = loadOk(baseConfig());
      expect(logoutAfterImport(config, 'home')).toBe(true);
      expect(logoutAfterImport(config, 'cloud')).toBe(true);
    });

    it('lets a vault override the global default in both directions', () => {
      const config = loadOk(baseConfig({
        logoutAfterImport: false,
        vaults: [VAULTS[0], { ...VAULTS[1], logoutAfterImport: true }],
      }));
      expect(logoutAfterImport(config, 'cloud')).toBe(false);
      expect(logoutAfterImport(config, 'home')).toBe(true);
    });
  });
});

describe('config helpers', () => {
  const config = loadOk(baseConfig({
    vaults: [...VAULTS, { key: 'offsite', name: 'Offsite', serverUrl: 'https://offsite.example.com' }],
    accounts: [...ACCOUNTS, { key: 'val@offsite', vault: 'offsite', email: 'val@example.com' }],
    orgs: [{ key: 'acme', name: 'Acme', ids: ORG_IDS }],
    syncs: [
      { key: 'val', from: 'val@cloud', to: 'val@home' },
      { key: 'acme-sync', from: 'val@cloud', to: 'val@home', org: 'acme' },
      { key: 'val-offsite', from: 'val@cloud', to: 'val@offsite' },
    ],
  }));

  it('gives each account its own profile directory', () => {
    expect(profileDir('/data', 'val@cloud')).toBe('/data/val@cloud');
    expect(profileDir('/data', 'val@home')).toBe('/data/val@home');
    expect(profileDir('/data', 'val@cloud')).not.toBe(profileDir('/data', 'val@home'));
  });

  it('groups every sync of one source account under a single login', () => {
    const bySource = groupSyncsByAccount(allTargetKeys(config), config, 'from');
    expect([...bySource.keys()]).toEqual(['val@cloud']);
    expect(bySource.get('val@cloud')).toEqual(expect.arrayContaining(['val', 'acme-sync', 'val-offsite']));
  });

  it('fans the destination side out per account', () => {
    const byDest = groupSyncsByAccount(allTargetKeys(config), config, 'to');
    expect(byDest.get('val@home')).toEqual(expect.arrayContaining(['val', 'acme-sync']));
    expect(byDest.get('val@offsite')).toEqual(['val-offsite']);
  });

  it('lists the other endpoints of the syncs a prompt covers', () => {
    expect(counterpartAccounts(['val', 'acme-sync'], config, 'val@cloud')).toEqual(['val@home']);
    expect(counterpartAccounts(['val', 'val-offsite'], config, 'val@cloud').sort())
      .toEqual(['val@home', 'val@offsite']);
    // From the destination side, the counterpart is the source.
    expect(counterpartAccounts(['val'], config, 'val@home')).toEqual(['val@cloud']);
  });

  it('orders target keys personal-first, then orgs', () => {
    expect(allTargetKeys(config)).toEqual(['val', 'val-offsite', 'acme-sync']);
  });
});
