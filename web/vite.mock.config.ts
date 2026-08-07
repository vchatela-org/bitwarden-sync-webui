// Local visual harness: serves fixture data on /api (incl. job-stream websockets)
// so the UI can be reviewed and screenshotted without a live backend + Bitwarden
// CLI. Backs `npm run screenshots` (see scripts/screenshots.mjs) — keep this in
// sync with server/src/api.ts response shapes.
import { createServer as createHttpServer } from 'node:http';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { WebSocketServer } from 'ws';
import type { Connect } from 'vite';

const config = {
  vaults: [
    { key: 'cloud', name: 'Cloud', serverUrl: 'https://vault.bitwarden.eu' },
    { key: 'home', name: 'Home', serverUrl: 'https://vault.home.lan' },
    { key: 'offsite', name: 'Offsite', serverUrl: 'https://vault.offsite.example' },
  ],
  accounts: [
    { key: 'alice@cloud', vault: 'cloud', email: 'alice@example.com', displayName: 'Alice Martin', otp: 'required' },
    { key: 'alice@home', vault: 'home', email: 'alice@home.lan', displayName: 'Alice Martin', otp: 'unknown' },
    { key: 'alice@offsite', vault: 'offsite', email: 'alice@example.com', displayName: 'Alice Martin', otp: 'unknown' },
    { key: 'bob@cloud', vault: 'cloud', email: 'bob@example.com', displayName: 'Bob Nguyen', otp: 'unknown' },
    { key: 'bob@home', vault: 'home', email: 'bob.nguyen@home.lan', displayName: 'Bob Nguyen', otp: 'unknown' },
  ],
  orgs: [
    { key: 'acme', name: 'Acme Corporation', vaults: ['cloud', 'home'] },
    { key: 'side', name: 'Side Project', vaults: ['cloud', 'home'] },
    { key: 'holdings', name: 'Bob Holdings', vaults: ['cloud', 'home'] },
  ],
  syncs: [
    { key: 'alice', from: 'alice@cloud', to: 'alice@home' },
    { key: 'alice-offsite', from: 'alice@cloud', to: 'alice@offsite' },
    { key: 'acme-org', from: 'alice@cloud', to: 'alice@home', org: 'acme' },
    { key: 'side-project', from: 'alice@cloud', to: 'alice@home', org: 'side' },
    { key: 'bob', from: 'bob@cloud', to: 'bob@home' },
    { key: 'bob-org', from: 'bob@cloud', to: 'bob@home', org: 'holdings' },
  ],
  retention: { keepDaily: 7, keepMonthly: 6 },
  importGuard: { minSourceRatio: 0.5, blockOnEmptySource: true },
  logoutAfterImport: true,
  cliVersion: '2026.7.0',
  appVersion: '1.7.3',
};

const ts = (daysAgo: number) => {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}00`;
};

const set = (targetKey: string, kind: 'user' | 'org', daysAgo: number, items: number, bytes: number) => ({
  targetKey,
  kind,
  timestamp: ts(daysAgo),
  files: [
    { path: `/backups/${targetKey}_${ts(daysAgo)}.json`, filename: 'x.json', targetKey, kind, timestamp: ts(daysAgo), fileType: 'export', sizeBytes: bytes },
    { path: `/backups/${targetKey}_${ts(daysAgo)}.meta.json`, filename: 'x.meta.json', targetKey, kind, timestamp: ts(daysAgo), fileType: 'meta', sizeBytes: 412 },
  ],
  sizeBytes: bytes,
  meta: { target: targetKey, kind, timestamp: ts(daysAgo), itemCount: items, folderCount: 12, sourceServer: config.vaults[0]!.serverUrl, cliVersion: '2026.7.0', sizeBytes: bytes },
  itemCount: items,
  folderCount: 12,
  collectionCount: kind === 'org' ? 4 : null,
  countSource: 'meta',
});

const backups = {
  managed: [
    set('alice', 'user', 0.2, 412, 884_000),
    set('alice', 'user', 1.2, 410, 880_100),
    set('alice', 'user', 3.2, 402, 871_400),
    set('alice-offsite', 'user', 1.1, 412, 884_000),
    set('acme-org', 'org', 0.3, 871, 1_942_000),
    set('acme-org', 'org', 4.3, 864, 1_930_500),
    set('side-project', 'org', 9.5, 63, 121_000),
    set('bob', 'user', 2.1, 188, 402_300),
  ],
  unmanaged: ['/backups/legacy-dump-2024.json', '/backups/manual_export.json'],
};

// Steps are grouped by source account, and labelled per account (logins) or per sync (work),
// mirroring server/src/runner.ts buildSteps().
const STEP_LABELS = [
  '[alice@cloud] Cloud login',
  '[alice@cloud] Cloud sync',
  '[alice] Export encrypted',
  '[alice] Export password-protected',
  '[alice] Write sidecar metadata',
  '[alice@home] Home login',
  '[alice] Pre-import diff',
  '[alice] Purge destination vault',
  '[alice] Import',
];

const steps = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    label: STEP_LABELS[i % STEP_LABELS.length],
    state: i < 4 ? 'succeeded' : i === 4 ? 'running' : 'pending',
    group: 'alice@cloud',
    startedAt: new Date(Date.now() - (n - i) * 4000).toISOString(),
    endedAt: i < 4 ? new Date(Date.now() - (n - i) * 3000).toISOString() : undefined,
    detail: i === 2 ? 'exported 412 items, 12 folders' : undefined,
  }));

const logs = Array.from({ length: 40 }, (_, i) => ({
  ts: new Date(Date.now() - (40 - i) * 1500).toISOString(),
  stream: i % 11 === 0 ? 'app' : i % 17 === 0 ? 'stderr' : 'stdout',
  step: `s${Math.floor(i / 5)}`,
  line: i % 17 === 0
    ? 'warning: collection "Shared" already exists, reusing id'
    : `[${i}] bw export --organizationid 4f2a --format json --output /backups/alice_export.json`,
}));

const secureDiffResults = {
  alice: {
    sourceCount: 415,
    destCount: 412,
    onlyInSource: [
      { type: 1, name: 'New Bank Account', username: 'alice.bank' },
      { type: 1, name: 'VPN Provider', username: 'alice@example.com' },
      { type: 2, name: 'Meeting notes – Q3 planning' },
    ],
    onlyInDest: [
      { type: 1, name: 'Old WiFi Network', username: null },
      { type: 1, name: 'Retired Service', username: 'alice.old' },
    ],
    credentialsDiffer: [
      { type: 1, name: 'Email Provider', username: 'alice@example.com', reasons: ['password'] },
      { type: 1, name: 'Cloud Dashboard', username: 'admin', reasons: ['password', 'totp'] },
      { type: 1, name: 'Shared Team Login', username: 'team@acme.corp', reasons: ['notes', 'fields'] },
      { type: 3, name: 'Corporate Card', username: null, reasons: ['card'] },
    ],
    identical: 406,
  },
  'acme-org': {
    sourceCount: 874,
    destCount: 871,
    onlyInSource: [
      { type: 1, name: 'New Vendor Portal', username: 'procurement@acme.corp' },
    ],
    onlyInDest: [],
    credentialsDiffer: [
      { type: 1, name: 'CI/CD Token', username: 'bot-ci', reasons: ['password', 'totp'] },
      { type: 1, name: 'Database Admin', username: 'dba', reasons: ['password'] },
    ],
    identical: 870,
  },
};

const jobs = [
  { id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', createdAt: new Date(Date.now() - 90_000).toISOString(), startedAt: new Date(Date.now() - 88_000).toISOString(), state: 'running', targets: ['alice', 'acme-org'], operations: ['both'], options: {}, steps: steps(9), logs, secureDiffResults },
  { id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', createdAt: new Date(Date.now() - 3_600_000).toISOString(), startedAt: new Date(Date.now() - 3_599_000).toISOString(), endedAt: new Date(Date.now() - 3_480_000).toISOString(), state: 'succeeded', targets: ['alice'], operations: ['backup'], options: {}, steps: steps(5).map((s) => ({ ...s, state: 'succeeded' })), logs: [] },
  { id: 'c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f', createdAt: new Date(Date.now() - 86_400_000).toISOString(), startedAt: new Date(Date.now() - 86_399_000).toISOString(), endedAt: new Date(Date.now() - 86_100_000).toISOString(), state: 'failed', targets: ['bob', 'bob-org'], operations: ['import'], options: {}, steps: steps(6).map((s, i) => ({ ...s, state: i < 3 ? 'succeeded' : i === 3 ? 'failed' : 'skipped' })), logs: [] },
  { id: 'd4e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f80', createdAt: new Date(Date.now() - 172_800_000).toISOString(), startedAt: new Date(Date.now() - 172_799_000).toISOString(), endedAt: new Date(Date.now() - 172_500_000).toISOString(), state: 'partial', targets: ['alice', 'bob', 'acme-org'], operations: ['backup'], options: {}, steps: steps(7).map((s, i) => ({ ...s, state: i === 5 ? 'warning' : 'succeeded' })), logs: [] },
];

const aliceCloud = { status: 'unlocked', serverUrl: config.vaults[0]!.serverUrl, userEmail: 'alice@example.com', lastSync: new Date(Date.now() - 3_600_000).toISOString() };
const aliceHome = { status: 'locked', serverUrl: config.vaults[1]!.serverUrl, userEmail: 'alice@home.lan', lastSync: new Date(Date.now() - 90_000_000).toISOString() };

const hAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const liveCounts = {
  alice:          { source: 412, sourceAt: hAgo(1.2), dest: 411, destAt: hAgo(1.2) },
  'alice-offsite': { source: 412, sourceAt: hAgo(1.3), dest: 411, destAt: hAgo(1.3) },
  'acme-org':     { source: 874, sourceAt: hAgo(1.1), dest: 871, destAt: hAgo(1.1) },
  'side-project': { source: 64,  sourceAt: hAgo(1.4), dest: 63,  destAt: hAgo(1.4) },
  bob:            { source: 188, sourceAt: hAgo(2.1), dest: 188, destAt: hAgo(2.1) },
  'bob-org':      { source: 44,  sourceAt: hAgo(2.1), dest: 44,  destAt: hAgo(2.1) },
};

const status = {
  alice: { source: aliceCloud, dest: aliceHome },
  'alice-offsite': {
    source: aliceCloud,
    dest: { status: 'unauthenticated', serverUrl: config.vaults[2]!.serverUrl },
  },
  'acme-org': {
    source: aliceCloud,
    dest: { status: 'unlocked', serverUrl: config.vaults[1]!.serverUrl, userEmail: 'alice@home.lan', lastSync: new Date(Date.now() - 7_200_000).toISOString() },
  },
  'side-project': { source: aliceCloud, dest: aliceHome },
  bob: {
    source: { status: 'unauthenticated', serverUrl: config.vaults[0]!.serverUrl },
    dest: null,
  },
};

// Job detail view opens a websocket for live updates. Attaching a raw 'upgrade'
// listener to Vite's own httpServer races with Vite's HMR websocket (which claims
// the connection first and rejects it, showing a "lost connection" banner) — so
// instead we run a tiny companion websocket server on its own port and reach it
// the same way vite.config.ts reaches the real backend: a `ws: true` dev proxy.
const STREAM_PORT = 5198;
const streamServer = createHttpServer();
const wss = new WebSocketServer({ server: streamServer });
wss.on('connection', (ws, req) => {
  ws.on('error', () => { /* React StrictMode opens+closes a throwaway connection on mount; ignore */ });
  const match = (req.url ?? '').match(/^\/api\/jobs\/([^/?]+)\/stream/);
  const job = jobs.find((j) => j.id === match?.[1]) ?? jobs[0];
  // Delay past React StrictMode's dev-only mount→cleanup→mount cycle so we don't
  // write to the throwaway first connection while it's closing (which the proxy
  // surfaces as an ECONNRESET the browser reports as a lost connection).
  setTimeout(() => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'snapshot', job }));
  }, 150);
});
streamServer.listen(STREAM_PORT);

function mockApi(): { name: string; configureServer: (s: { middlewares: Connect.Server }) => void } {
  return {
    name: 'mock-api',
    configureServer(server) {
      server.middlewares.use('/api', (req, res, next) => {
        const url = (req.url ?? '').split('?')[0]!;
        const send = (body: unknown) => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(body));
        };
        if (url === '/auth/me') return send({ authenticated: true, csrfToken: 'mock' });
        if (url === '/auth/login') return send({ ok: true, csrfToken: 'mock' });
        if (url === '/auth/logout') return send({ ok: true });
        if (url === '/config') return send(config);
        if (url === '/status') return send(status);
        if (url === '/live-counts') return send(liveCounts);
        if (url === '/backups') return send(backups);
        if (url === '/backups/verify') {
          return send({
            results: [
              ...backups.managed.slice(0, 5).map((s) => ({ path: s.files[0]!.path, ok: true })),
              { path: '/backups/side-project_20260727_0300.json', ok: false, reason: 'SHA256 mismatch' },
            ],
          });
        }
        if (url === '/backups/prune') {
          const doomed = backups.managed.slice(4);
          return send({
            toDelete: doomed.map((s) => ({ targetKey: s.targetKey, timestamp: s.timestamp, files: s.files.map((f) => f.path), sizeBytes: s.sizeBytes })),
            totalBytes: doomed.reduce((a, s) => a + s.sizeBytes, 0),
            dryRun: true,
          });
        }
        if (url === '/jobs') return send(jobs);
        if (url.startsWith('/jobs/')) {
          const id = url.split('/')[2];
          return send(jobs.find((j) => j.id === id) ?? jobs[0]);
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), mockApi()],
  server: {
    port: 5199,
    strictPort: true,
    proxy: {
      '^/api/jobs/.*/stream': { target: `ws://localhost:${STREAM_PORT}`, ws: true },
    },
  },
});
