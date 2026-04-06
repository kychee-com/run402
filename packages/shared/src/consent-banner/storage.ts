/**
 * Consent storage — F19.
 *
 * Pure load/save/should-re-prompt logic for the consent banner. The functions
 * take a Storage adapter (compatible with the browser `localStorage` interface
 * — `getItem`, `setItem`) and an injected `now` so they're trivially testable
 * without jsdom.
 *
 * The persistence shape is intentionally small and stable across products:
 *
 *   {
 *     "essential":  true,
 *     "analytics":  false,
 *     "marketing":  false,
 *     "ts":         1745000000000,
 *     "region":     { "country": "DE", "regionCode": null },
 *     "version":    1
 *   }
 *
 * Re-prompt rules:
 *   - no stored record           → prompt
 *   - stored.version !== current → prompt
 *   - now - stored.ts >= 12mo    → prompt
 *   - otherwise                  → don't prompt
 */

export const CONSENT_KEY = 'kychee_consent';
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ConsentChoice {
  essential: boolean;
  analytics: boolean;
  marketing: boolean;
}

export interface ConsentRecord extends ConsentChoice {
  ts: number;
  region: { country: string | null; regionCode: string | null };
  version: number;
}

export interface SaveOptions {
  country: string | null | undefined;
  region?: string | null;
  version: number;
  now?: Date;
}

export interface RePromptOptions {
  version: number;
  now?: Date;
}

export function defaultConsent(): ConsentChoice {
  return { essential: true, analytics: false, marketing: false };
}

export function saveConsent(
  storage: StorageAdapter,
  choice: ConsentChoice,
  opts: SaveOptions
): ConsentRecord {
  const record: ConsentRecord = {
    essential: true, // Cannot be opted out — coerced.
    analytics: !!choice.analytics,
    marketing: !!choice.marketing,
    ts: (opts.now ?? new Date()).getTime(),
    region: {
      country: opts.country ? opts.country.toUpperCase() : null,
      regionCode: opts.region ? opts.region.toUpperCase() : null,
    },
    version: opts.version,
  };
  storage.setItem(CONSENT_KEY, JSON.stringify(record));
  return record;
}

export function loadConsent(storage: StorageAdapter): ConsentRecord | null {
  const raw = storage.getItem(CONSENT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ConsentRecord;
    // Coerce essential — never trust stored value.
    parsed.essential = true;
    return parsed;
  } catch {
    return null;
  }
}

export function shouldRePrompt(storage: StorageAdapter, opts: RePromptOptions): boolean {
  const stored = loadConsent(storage);
  if (!stored) return true;
  if (stored.version !== opts.version) return true;
  const now = (opts.now ?? new Date()).getTime();
  if (now - stored.ts >= ONE_YEAR_MS) return true;
  return false;
}
