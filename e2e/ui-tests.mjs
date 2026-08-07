/**
 * End-to-end browser tests for Bitwarden Sync Web UI.
 *
 * Run:  node e2e/ui-tests.mjs
 *
 * Requires the Docker dev stack to be running on localhost:3000:
 *   docker compose -f docker-compose.dev.yml up --build -d
 */

import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';
const UI_PASSWORD = 'testpassword123';
const DEMO_MASTER_PW = 'VgXrP5Z69o-9sFSPw37m';

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  ✅ ${label}`);
  passed++;
}
function fail(label, detail) {
  console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  failed++;
}

async function main() {
  console.log('=== Bitwarden Sync Web UI — Playwright E2E Tests ===\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  try {
    // ═══════════════════════════════════════════════════════════════════════
    // 1. LOGIN PAGE
    // ═══════════════════════════════════════════════════════════════════════
    console.log('── 1. Login Page ──');
    await page.goto(BASE, { waitUntil: 'networkidle' });

    const title = await page.title();
    title === 'Bitwarden Sync' ? ok('Page title') : fail('Page title', `"${title}"`);

    const heading = await page.textContent('h1');
    heading?.includes('Bitwarden Sync') ? ok('Heading visible') : fail('Heading', `"${heading}"`);

    const pwInput = page.locator('#ui-password');
    (await pwInput.isVisible()) ? ok('Password input visible') : fail('Password input missing');

    const signInBtn = page.locator('button[type="submit"]');
    (await signInBtn.isDisabled()) ? ok('Sign-in disabled when empty') : fail('Sign-in should be disabled');

    // Wrong password → error
    await pwInput.fill('wrongpassword');
    await signInBtn.click();
    await page.waitForTimeout(500);
    const errorAlert = page.locator('[role="alert"]');
    (await errorAlert.isVisible()) ? ok('Error alert on wrong password') : fail('No error alert');

    // Correct password → login
    await pwInput.fill(UI_PASSWORD);
    await signInBtn.click();
    await page.waitForTimeout(1500);

    // ═══════════════════════════════════════════════════════════════════════
    // 2. DASHBOARD
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n── 2. Dashboard ──');

    const header = page.locator('header');
    (await header.isVisible()) ? ok('Header visible') : fail('Header missing');

    // Nav buttons
    const dashboardNav = page.getByRole('button', { name: 'Dashboard' });
    const jobsNav = page.getByRole('button', { name: 'Jobs' });
    const backupsNav = page.getByRole('button', { name: 'Backups' });

    (await dashboardNav.isVisible()) ? ok('Dashboard nav') : fail('Dashboard nav missing');
    (await jobsNav.isVisible()) ? ok('Jobs nav') : fail('Jobs nav missing');
    (await backupsNav.isVisible()) ? ok('Backups nav') : fail('Backups nav missing');

    // Stat cards
    const statCards = page.locator('.grid > div');
    const cardCount = await statCards.count();
    cardCount >= 4 ? ok(`${cardCount} stat cards`) : fail(`Expected >=4 cards, got ${cardCount}`);

    // Targets table
    (await page.locator('table').isVisible()) ? ok('Targets table visible') : fail('Table missing');

    // Demo user in table
    const demoTarget = page.locator('td', { hasText: 'demo' }).first();
    (await demoTarget.isVisible()) ? ok('Demo user in table') : fail('Demo user missing');

    // Action buttons
    const backupBtn = page.getByRole('button', { name: 'Backup', exact: true });
    const importBtn = page.getByRole('button', { name: 'Import', exact: true });
    const bothBtn = page.getByRole('button', { name: 'Backup + Import', exact: true });
    (await backupBtn.isVisible()) ? ok('Backup button') : fail('Backup button missing');
    (await importBtn.isVisible()) ? ok('Import button') : fail('Import button missing');
    (await bothBtn.isVisible()) ? ok('Backup+Import button') : fail('Backup+Import button missing');

    // ═══════════════════════════════════════════════════════════════════════
    // 3. CREATE JOB → CREDENTIAL MODAL
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n── 3. Job Creation & Credential Modal ──');

    // Select demo target
    await demoTarget.click();
    await page.waitForTimeout(200);

    // Click Backup — this creates the job and navigates to the Jobs page
    await backupBtn.click();
    await page.waitForTimeout(1500);

    // We should now be on the Jobs page with the credential modal open
    // The modal is a [role="dialog"]
    const modal = page.locator('[role="dialog"]');
    const modalVisible = await modal.isVisible().catch(() => false);
    modalVisible ? ok('Credential modal appeared') : fail('Modal did not appear');

    if (modalVisible) {
      const modalText = await modal.textContent();
      modalText?.includes('Credentials required') ? ok('Modal title "Credentials required"') : fail('Modal title wrong');
      modalText?.includes('demo') ? ok('Modal shows account "demo"') : fail('Modal missing account');

      // Master password field
      const masterPwInput = modal.locator('#master-password');
      (await masterPwInput.isVisible()) ? ok('Master password field') : fail('Master password field missing');

      // Fill in the real master password
      await masterPwInput.fill(DEMO_MASTER_PW);
      ok('Filled master password');

      // The code field shows immediately when the account is configured `otp: "required"`,
      // otherwise only after the CLI's first login attempt asks for one.
      await page.waitForTimeout(3000);
      const otpInput = modal.locator('#otp-code');
      const otpVisible = await otpInput.isVisible().catch(() => false);
      if (otpVisible) {
        ok('OTP field appeared (from account config or bw CLI)');
      } else {
        console.log('  ⚠️  OTP not shown — expected unless the account has two-step login');
      }

      // Cancel the job (we can't complete without a fresh TOTP)
      const cancelBtn = modal.getByRole('button', { name: 'Cancel job', exact: true });
      (await cancelBtn.isVisible()) ? ok('Cancel button in modal') : fail('Cancel button missing');
      await cancelBtn.click();
      await page.waitForTimeout(1000);

      const modalGone = !(await modal.isVisible().catch(() => false));
      modalGone ? ok('Modal closed after cancel') : fail('Modal still visible');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 4. JOBS PAGE
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n── 4. Jobs Page ──');

    // We should already be on the jobs page. Look for the job list.
    // The page shows either a job detail view or the job list
    const allJobsBtn = page.getByRole('button', { name: 'All jobs' });
    const allJobsVisible = await allJobsBtn.isVisible().catch(() => false);
    if (allJobsVisible) {
      ok('On job detail view (All jobs button visible)');
      await allJobsBtn.click();
      await page.waitForTimeout(500);
    }

    // Now we should see the job list
    const jobsHeading = page.getByRole('heading', { name: 'Job history' });
    (await jobsHeading.isVisible().catch(() => false))
      ? ok('Jobs page heading "Job history"')
      : fail('Jobs heading missing');

    // ═══════════════════════════════════════════════════════════════════════
    // 5. BACKUPS PAGE
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n── 5. Backups Page ──');
    await backupsNav.click();
    await page.waitForTimeout(800);

    const backupsHeading = page.getByRole('heading', { name: 'Retention & pruning' });
    (await backupsHeading.isVisible().catch(() => false))
      ? ok('Backups page heading "Retention & pruning"')
      : fail('Backups heading missing');

    // Check for key elements on backups page
    const verifyBtn = page.getByRole('button', { name: 'Verify integrity' });
    (await verifyBtn.isVisible().catch(() => false))
      ? ok('Verify integrity button')
      : console.log('  ⚠️  Verify integrity button not found');

    // ═══════════════════════════════════════════════════════════════════════
    // 6. NAVIGATE BACK TO DASHBOARD
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n── 6. Navigation ──');
    await dashboardNav.click();
    await page.waitForTimeout(500);
    (await backupBtn.isVisible().catch(() => false))
      ? ok('Back to dashboard (Backup button visible)')
      : fail('Could not navigate back to dashboard');

    // ═══════════════════════════════════════════════════════════════════════
    // 7. LOGOUT
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n── 7. Logout ──');
    const logoutBtn = page.locator('button[aria-label="Sign out"]');
    (await logoutBtn.isVisible()) ? ok('Sign out button visible') : fail('Sign out button missing');

    await logoutBtn.click();
    await page.waitForTimeout(800);

    const loginAgain = page.locator('#ui-password');
    (await loginAgain.isVisible()) ? ok('Returned to login after logout') : fail('Not on login page');

    // ═══════════════════════════════════════════════════════════════════════
    // 8. AUTH GUARDS
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n── 8. Auth Guards ──');
    await page.goto(`${BASE}/api/config`, { waitUntil: 'networkidle' });
    const body = await page.textContent('body');
    body?.includes('Unauthorized') || body?.includes('error')
      ? ok('API rejects unauthenticated requests')
      : fail('API should reject');

  } catch (err) {
    console.error('\n❌ Test error:', err.message);
    failed++;
  } finally {
    await browser.close();
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
