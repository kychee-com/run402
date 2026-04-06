/**
 * Consent storage tests — F19.
 *
 * The consent record is shaped: { essential, analytics, marketing, ts, region, version }
 * - `essential` is always true (cannot be toggled off).
 * - `analytics` and `marketing` default to false (must be opt-IN).
 * - `ts` is the unix-ms timestamp at which consent was recorded.
 * - `region` is the country (and optional region code) the user was in when
 *   they answered the banner.
 * - `version` lets us re-prompt the user when the policy changes.
 *
 * Re-prompt rules:
 *   - No record    → prompt
 *   - Older than 12 months → prompt
 *   - Version differs from current → prompt
 *   - Otherwise → don't prompt
 *
 * The pure functions take a Storage adapter (compatible with `localStorage`)
 * and a `now: Date` so we don't need jsdom.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadConsent,
  saveConsent,
  shouldRePrompt,
  defaultConsent,
  CONSENT_KEY,
} from './storage.js';

function memoryStorage() {
  const data: Record<string, string> = {};
  return {
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => { data[k] = v; },
    removeItem: (k: string) => { delete data[k]; },
    raw: data,
  };
}

const NOW = new Date('2026-04-15T12:00:00Z');
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

describe('defaultConsent — F19', () => {
  it('returns essential=true, analytics=false, marketing=false', () => {
    const c = defaultConsent();
    assert.equal(c.essential, true);
    assert.equal(c.analytics, false);
    assert.equal(c.marketing, false);
  });
});

describe('saveConsent / loadConsent', () => {
  it('stores under the documented key', () => {
    const s = memoryStorage();
    saveConsent(s, { essential: true, analytics: true, marketing: false }, {
      country: 'DE', version: 1, now: NOW,
    });
    assert.ok(s.raw[CONSENT_KEY]);
  });

  it('round-trips a consent record', () => {
    const s = memoryStorage();
    saveConsent(s, { essential: true, analytics: true, marketing: true }, {
      country: 'FR', region: null, version: 1, now: NOW,
    });
    const loaded = loadConsent(s);
    assert.equal(loaded!.essential, true);
    assert.equal(loaded!.analytics, true);
    assert.equal(loaded!.marketing, true);
    assert.equal(loaded!.region.country, 'FR');
    assert.equal(loaded!.version, 1);
    assert.equal(loaded!.ts, NOW.getTime());
  });

  it('returns null when nothing is stored', () => {
    const s = memoryStorage();
    assert.equal(loadConsent(s), null);
  });

  it('returns null on corrupt JSON (defensive)', () => {
    const s = memoryStorage();
    s.setItem(CONSENT_KEY, '{not json');
    assert.equal(loadConsent(s), null);
  });

  it('forces essential=true even if caller passes false', () => {
    const s = memoryStorage();
    saveConsent(s, { essential: false as any, analytics: false, marketing: false }, {
      country: 'US', version: 1, now: NOW,
    });
    const loaded = loadConsent(s);
    assert.equal(loaded!.essential, true);
  });
});

describe('shouldRePrompt — F19', () => {
  it('prompts when there is no stored consent', () => {
    const s = memoryStorage();
    assert.equal(shouldRePrompt(s, { version: 1, now: NOW }), true);
  });

  it('does not prompt when consent is fresh and version matches', () => {
    const s = memoryStorage();
    saveConsent(s, { essential: true, analytics: false, marketing: false }, {
      country: 'DE', version: 1, now: new Date(NOW.getTime() - 1000),
    });
    assert.equal(shouldRePrompt(s, { version: 1, now: NOW }), false);
  });

  it('prompts when stored consent is older than 12 months', () => {
    const s = memoryStorage();
    saveConsent(s, { essential: true, analytics: true, marketing: false }, {
      country: 'DE', version: 1, now: new Date(NOW.getTime() - ONE_YEAR_MS - 1000),
    });
    assert.equal(shouldRePrompt(s, { version: 1, now: NOW }), true);
  });

  it('does not prompt right at the 12-month boundary (still fresh)', () => {
    const s = memoryStorage();
    saveConsent(s, { essential: true, analytics: true, marketing: false }, {
      country: 'DE', version: 1, now: new Date(NOW.getTime() - ONE_YEAR_MS + 1000),
    });
    assert.equal(shouldRePrompt(s, { version: 1, now: NOW }), false);
  });

  it('prompts when the version has been bumped', () => {
    const s = memoryStorage();
    saveConsent(s, { essential: true, analytics: true, marketing: false }, {
      country: 'DE', version: 1, now: NOW,
    });
    assert.equal(shouldRePrompt(s, { version: 2, now: NOW }), true);
  });
});
