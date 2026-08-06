const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const REDACTED = '••••••••';

/** Redacts email addresses inside free-form text, e.g. log lines. */
export function maskEmails(text: string): string {
  return text.replace(EMAIL_RE, REDACTED);
}

/** Fully redacts a discrete sensitive value (a name, username, or account key). */
export function maskValue(value: string): string {
  return value ? REDACTED : value;
}

const STORAGE_KEY = 'bw-sync:mask-sensitive';

export function loadMaskPreference(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveMaskPreference(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch { /* localStorage unavailable (private mode, etc.) — preference just won't persist */ }
}
