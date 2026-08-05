import express, { Request, Response } from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { createServer, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { join } from 'path';
import { existsSync } from 'fs';

import {
  createSession,
  destroySession,
  isAuthenticated,
  requireAuth,
  requireCsrf,
  getCsrfToken,
  verifyUiPassword,
  loadPersistedSessions,
} from './auth.js';
import {
  createJob,
  getJob,
  listJobs,
  cancelJob,
  submitCredentials,
  submitConfirmation,
  addJobListener,
  removeJobListener,
  loadPersistedJobs,
  setGlobalConfig,
  Job,
} from './runner.js';
import {
  inventoryBackups,
  planRetention,
  deleteSet,
  checkIntegrity,
  BackupSet,
} from './backups.js';
import { getBwStatus } from './session.js';
import { cloudProfileDir, homeProfileDir, allTargetKeys, Config, ConfigLoadResult } from './config.js';
import { getCliVersion } from './bwCli.js';

export function createApp(configResult: ConfigLoadResult): ReturnType<typeof createServer> {
  const app = express();

  // Security headers
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          connectSrc: ["'self'", 'ws:', 'wss:'],
          imgSrc: ["'self'", 'data:'],
        },
      },
    }),
  );

  if (process.env['TRUST_PROXY'] === '1' || process.env['TRUST_PROXY'] === 'true') {
    app.set('trust proxy', 1);
  }

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // ── Auth routes ────────────────────────────────────────────────────────────
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

  app.post('/api/auth/login', authLimiter, async (req: Request, res: Response): Promise<void> => {
    const { password } = req.body as { password?: string };
    if (!password || typeof password !== 'string') {
      res.status(400).json({ error: 'Password required' });
      return;
    }
    const ok = await verifyUiPassword(password);
    if (!ok) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }
    const csrfToken = createSession(res, req);
    res.json({ ok: true, csrfToken });
  });

  app.post('/api/auth/logout', requireAuth, (req: Request, res: Response): void => {
    destroySession(req, res);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req: Request, res: Response): void => {
    const authenticated = isAuthenticated(req);
    res.json({ authenticated, csrfToken: authenticated ? getCsrfToken(req) : null });
  });

  // ── Config ────────────────────────────────────────────────────────────────
  app.get('/api/config', requireAuth, async (req: Request, res: Response): Promise<void> => {
    if (!configResult.ok) {
      res.status(503).json({ error: configResult.error });
      return;
    }
    const { config } = configResult;
    const cliVersion = await getCliVersion().catch(() => 'unknown');
    res.json({
      cloudServerUrl: config.cloudServerUrl,
      homeServerUrl: config.homeServerUrl,
      users: config.users.map((u) => ({ key: u.key, email: u.email, displayName: u.displayName })),
      orgs: config.orgs.map((o) => ({ key: o.key, name: o.name, owner: o.owner })),
      retention: config.retention,
      importGuard: config.importGuard,
      homeLogoutAfterImport: config.homeLogoutAfterImport,
      cliVersion,
    });
  });

  // ── Health ───────────────────────────────────────────────────────────────
  app.get('/api/health', (req: Request, res: Response): void => {
    if (!configResult.ok) {
      res.status(503).json({ status: 'config-error', error: configResult.error });
      return;
    }
    res.json({ status: 'ok' });
  });

  // ── Status ───────────────────────────────────────────────────────────────
  app.get('/api/status', requireAuth, async (req: Request, res: Response): Promise<void> => {
    if (!configResult.ok) {
      res.status(503).json({ error: configResult.error });
      return;
    }
    const { config } = configResult;
    const results: Record<string, unknown> = {};
    const targets = allTargetKeys(config);
    for (const key of targets) {
      const userCfg = config.users.find((u) => u.key === key);
      const orgCfg = config.orgs.find((o) => o.key === key);
      const ownerKey = orgCfg ? orgCfg.owner : key;

      try {
        const cloudDir = cloudProfileDir(config.bitwardenConfigDir, ownerKey);
        const homeDir = homeProfileDir(config.bitwardenConfigDir, ownerKey);
        const [cloudStatus, homeStatus] = await Promise.all([
          getBwStatus(cloudDir).catch(() => null),
          getBwStatus(homeDir).catch(() => null),
        ]);
        results[key] = { cloud: cloudStatus, home: homeStatus };
      } catch {
        results[key] = { cloud: null, home: null };
      }
    }
    res.json(results);
  });

  // ── Jobs ──────────────────────────────────────────────────────────────────
  app.post('/api/jobs', requireAuth, requireCsrf, (req: Request, res: Response): void => {
    if (!configResult.ok) {
      res.status(503).json({ error: configResult.error });
      return;
    }
    const { targets, operations, options } = req.body as {
      targets?: string[];
      operations?: string[];
      options?: Record<string, unknown>;
    };
    if (!Array.isArray(targets) || targets.length === 0) {
      res.status(400).json({ error: 'targets required' });
      return;
    }
    if (!Array.isArray(operations) || operations.length === 0) {
      res.status(400).json({ error: 'operations required' });
      return;
    }
    const { config } = configResult;
    const validTargets = allTargetKeys(config);
    for (const t of targets) {
      if (!validTargets.includes(t)) {
        res.status(400).json({ error: `Unknown target: ${t}` });
        return;
      }
    }
    const job = createJob(targets, operations as never, options as never ?? {}, config);
    res.json({ jobId: job.id });
  });

  app.get('/api/jobs', requireAuth, (req: Request, res: Response): void => {
    const page = parseInt(String(req.query['page'] ?? '0'), 10);
    const jobs = listJobs(page);
    res.json(jobs.map(sanitizeJob));
  });

  app.get('/api/jobs/:id', requireAuth, (req: Request, res: Response): void => {
    const job = getJob(String(req.params['id']));
    if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
    res.json(sanitizeJob(job));
  });

  app.get('/api/jobs/:id/log', requireAuth, (req: Request, res: Response): void => {
    const job = getJob(String(req.params['id']));
    if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
    const text = job.logs.map((l) => `[${l.ts}] [${l.stream}] ${l.line}`).join('\n');
    res.type('text/plain').send(text);
  });

  app.post('/api/jobs/:id/credentials', requireAuth, requireCsrf, (req: Request, res: Response): void => {
    const job = getJob(String(req.params['id']));
    if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
    if (job.state !== 'awaiting-credentials') {
      res.status(409).json({ error: 'Job not awaiting credentials' });
      return;
    }
    const { accountKey, password, otp, otpMethod } = req.body as {
      accountKey?: string;
      password?: string;
      otp?: string;
      otpMethod?: number;
    };
    if (!accountKey || !password) {
      res.status(400).json({ error: 'accountKey and password required' });
      return;
    }
    const ok = submitCredentials(job.id, accountKey, password, otp, otpMethod);
    if (!ok) { res.status(409).json({ error: 'No pending credential prompt for that account' }); return; }
    res.json({ ok: true });
  });

  app.post('/api/jobs/:id/confirm', requireAuth, requireCsrf, (req: Request, res: Response): void => {
    const job = getJob(String(req.params['id']));
    if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
    if (job.state !== 'awaiting-confirmation') {
      res.status(409).json({ error: 'Job not awaiting confirmation' });
      return;
    }
    const { target, decision } = req.body as { target?: string; decision?: string };
    if (!target || !decision) {
      res.status(400).json({ error: 'target and decision required' });
      return;
    }
    if (!['proceed', 'skip', 'abort'].includes(decision)) {
      res.status(400).json({ error: 'decision must be proceed, skip, or abort' });
      return;
    }
    const ok = submitConfirmation(job.id, target, decision as 'proceed' | 'skip' | 'abort');
    if (!ok) { res.status(409).json({ error: 'No pending confirmation for that target' }); return; }
    res.json({ ok: true });
  });

  app.post('/api/jobs/:id/cancel', requireAuth, requireCsrf, (req: Request, res: Response): void => {
    const ok = cancelJob(String(req.params['id']));
    if (!ok) { res.status(409).json({ error: 'Cannot cancel that job' }); return; }
    res.json({ ok: true });
  });

  // ── Backups ───────────────────────────────────────────────────────────────
  app.get('/api/backups', requireAuth, (req: Request, res: Response): void => {
    if (!configResult.ok) { res.status(503).json({ error: configResult.error }); return; }
    const { config } = configResult;
    const inv = inventoryBackups(config.backupFolder, allTargetKeys(config), { deriveCounts: true });
    res.json(inv);
  });

  app.post('/api/backups/verify', requireAuth, requireCsrf, (req: Request, res: Response): void => {
    if (!configResult.ok) { res.status(503).json({ error: configResult.error }); return; }
    const { config } = configResult;
    const { target } = req.body as { target?: string };
    const inv = inventoryBackups(config.backupFolder, allTargetKeys(config));
    const sets = target ? inv.managed.filter((s) => s.targetKey === target) : inv.managed;
    const results = sets.flatMap((s) => checkIntegrity(s));
    res.json({ results });
  });

  app.post('/api/backups/prune', requireAuth, requireCsrf, (req: Request, res: Response): void => {
    if (!configResult.ok) { res.status(503).json({ error: configResult.error }); return; }
    const { config } = configResult;
    const { target, keepDaily, keepMonthly, dryRun = true } = req.body as {
      target?: string;
      keepDaily?: number;
      keepMonthly?: number;
      dryRun?: boolean;
    };
    const inv = inventoryBackups(config.backupFolder, allTargetKeys(config));
    const sets = target ? inv.managed.filter((s) => s.targetKey === target) : inv.managed;
    const retentionCfg = {
      keepDaily: keepDaily ?? config.retention.keepDaily,
      keepMonthly: keepMonthly ?? config.retention.keepMonthly,
    };
    const toDelete = planRetention(sets, retentionCfg);
    const summary = {
      toDelete: toDelete.map((s: BackupSet) => ({
        targetKey: s.targetKey,
        timestamp: s.timestamp,
        files: s.files.map((f) => f.path),
        sizeBytes: s.sizeBytes,
      })),
      totalBytes: toDelete.reduce((acc: number, s: BackupSet) => acc + s.sizeBytes, 0),
      dryRun,
    };
    if (!dryRun) {
      for (const s of toDelete) { try { deleteSet(s); } catch { /* log */ } }
    }
    res.json(summary);
  });

  // ── SPA fallback ──────────────────────────────────────────────────────────
  const publicDir = join(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'), '..', 'public');
  const indexPath = join(publicDir, 'index.html');

  if (existsSync(publicDir)) {
    app.use(express.static(publicDir, { index: false }));
    app.get('*', (req: Request, res: Response): void => {
      if (req.path.startsWith('/api')) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      res.sendFile(indexPath);
    });
  }

  // ── HTTP + WebSocket server ───────────────────────────────────────────────
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    const url = request.url ?? '';
    const match = url.match(/^\/api\/jobs\/([^/]+)\/stream/);
    if (!match) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, match[1]);
    });
  });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, jobId: string) => {
    // Send snapshot
    const job = getJob(jobId);
    if (job) {
      ws.send(JSON.stringify({ type: 'snapshot', job: sanitizeJob(job) }));
    }

    const cb: Parameters<typeof addJobListener>[0] = (id, event, data) => {
      if (id !== jobId) return;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: event, data }));
      }
    };
    addJobListener(cb);
    ws.on('close', () => removeJobListener(cb));
  });

  loadPersistedSessions();

  if (configResult.ok) {
    setGlobalConfig(configResult.config);
    loadPersistedJobs();
  }

  return server;
}

function sanitizeJob(job: Job): Job {
  // Never return passwords in any field; logs are already redacted in runner
  return job;
}
