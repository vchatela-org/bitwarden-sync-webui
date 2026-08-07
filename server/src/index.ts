import { createApp } from './api.js';
import { loadConfig } from './config.js';
import { assertCliVersion } from './bwCli.js';
import { migrateLegacyBackupNames } from './backups.js';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);
const CONFIG_PATH = process.env['CONFIG_PATH'];

// Disable core dumps on Linux (belt-and-suspenders — entrypoint also does this)
(process as NodeJS.Process & { setrlimit?: (r: string, l: object) => void }).setrlimit?.('core', { soft: 0, hard: 0 });

async function main(): Promise<void> {
  const configResult = loadConfig(CONFIG_PATH);
  if (!configResult.ok) {
    console.error(`[startup] Config error: ${configResult.error}`);
    // Continue serving — show config error page rather than CrashLoopBackOff
  } else {
    const { vaults, accounts, syncs, orgs } = configResult.config;
    console.log(
      `[startup] Config loaded: ${vaults.length} vaults, ${accounts.length} accounts, ` +
      `${syncs.length} syncs, ${orgs.length} orgs`,
    );

    // Backups written before v1.6.2 have a stray '.' in their filenames and don't parse;
    // rename them so they show up managed and their item counts stay readable.
    migrateLegacyBackupNames(configResult.config.backupFolder, (msg) => console.log(msg));
  }

  // Boot-time CLI version assertion (non-fatal)
  await assertCliVersion().catch((err: unknown) => {
    console.warn(`[startup] CLI version check failed: ${err}`);
  });

  const server = createApp(configResult);

  server.listen(PORT, () => {
    console.log(`[startup] Bitwarden Web UI listening on :${PORT}`);
  });

  process.on('SIGTERM', () => {
    console.log('[shutdown] SIGTERM received');
    server.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error('[startup] Fatal error:', err);
  process.exit(1);
});
