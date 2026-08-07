#!/usr/bin/env node
/**
 * Regenerates full-page screenshots of each tab against the mock API (web/vite.mock.config.ts),
 * so they reflect totally fake data — no live backend or Bitwarden CLI required.
 *
 * Usage: npm run screenshots
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.join(ROOT, 'web');
const VITE_BIN = path.join(WEB_DIR, 'node_modules', '.bin', 'vite');
const OUT_DIR = path.join(ROOT, 'screenshots');
const PORT = 5199;
const BASE_URL = `http://localhost:${PORT}`;

async function waitForServer(url, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  throw new Error(`Mock server did not come up at ${url} within ${timeoutMs}ms`);
}

async function shoot(page, filename) {
  await page.screenshot({ path: path.join(OUT_DIR, filename), fullPage: true, type: 'jpeg', quality: 82 });
  console.log(`  ✓ ${filename}`);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  console.log('Starting mock dev server...');
  const server = spawn(VITE_BIN, ['--config', 'vite.mock.config.ts'], {
    cwd: WEB_DIR,
    stdio: 'inherit',
  });
  let stopped = false;
  const stopServer = () => {
    if (!stopped) {
      stopped = true;
      server.kill();
    }
  };
  process.on('exit', stopServer);

  try {
    await waitForServer(BASE_URL);

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

    // ── Dashboard ──────────────────────────────────────────────────────────
    await page.getByRole('table').waitFor();
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/status')),
      page.getByRole('button', { name: 'Vault status' }).click(),
    ]);
    await page.waitForTimeout(300); // let the freshly-loaded status render
    await shoot(page, '01-dashboard.jpg');

    // ── Jobs: list ─────────────────────────────────────────────────────────
    await page.getByRole('button', { name: 'Jobs', exact: true }).click();
    await page.getByRole('heading', { name: 'Job history' }).waitFor();
    await shoot(page, '02-jobs-list.jpg');

    // ── Jobs: detail (the running job) ──────────────────────────────────────
    await Promise.all([
      page.waitForResponse((r) => /\/api\/jobs\/[^/]+$/.test(r.url())),
      page.getByText('a1b2c3d4', { exact: true }).click(),
    ]);
    await page.getByText('Output', { exact: true }).waitFor();
    await page.waitForTimeout(800); // let the mocked job-stream snapshot arrive
    await shoot(page, '03-job-detail.jpg');

    // ── Jobs: credential diff panel ─────────────────────────────────────────
    await page.getByText('Credential Diff', { exact: true }).waitFor();
    // Scroll the diff panel into view for a clean screenshot
    await page.getByText('Credential Diff', { exact: true }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await shoot(page, '05-diff.jpg');

    // ── Backups ───────────────────────────────────────────────────────────
    await page.getByRole('button', { name: 'Backups', exact: true }).click();
    await page.getByRole('heading', { name: 'Retention & pruning' }).waitFor();
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/backups/verify')),
      page.getByRole('button', { name: 'Verify integrity' }).click(),
    ]);
    await page.getByText('acme-org', { exact: true }).click(); // expand a target's history
    await page.waitForTimeout(200);
    await shoot(page, '04-backups.jpg');

    await browser.close();
    console.log(`\nDone. Screenshots written to ${path.relative(ROOT, OUT_DIR)}/`);
  } finally {
    stopServer();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
