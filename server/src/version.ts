import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let cachedVersion: string | null = null;

/** App version, read from package.json next to the compiled dist/ (or src/ in dev). */
export function getAppVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const raw = readFileSync(resolve(__dirname, '../package.json'), 'utf-8');
    cachedVersion = (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}
