/**
 * Region rule tests — saas-factory F19.
 *
 * shouldShowBanner is a pure function: given a country code (ISO-3166-1 alpha-2)
 * and an optional region/state code (ISO-3166-2 subdivision), return whether
 * the consent banner must be shown.
 *
 * Required jurisdictions (banner ON):
 *   - All EU member states (GDPR)
 *   - United Kingdom (UK GDPR)
 *   - Brazil (LGPD)
 *   - Canada (PIPEDA)
 *   - Switzerland (revFADP)
 *   - California specifically (CPRA)
 *
 * Permitted jurisdictions (banner OFF):
 *   - United States (anywhere except California)
 *   - Most of the rest of the world
 *
 * Fail-safe: when country is unknown/empty/null → ON (compliant default).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldShowBanner } from './regions.js';

describe('shouldShowBanner — F19', () => {
  describe('European Union (banner required)', () => {
    const EU_SAMPLE = ['DE', 'FR', 'IT', 'ES', 'NL', 'PL', 'SE', 'IE', 'PT', 'AT', 'BE', 'DK', 'FI', 'GR', 'HU', 'CZ', 'RO', 'BG', 'HR', 'SK', 'SI', 'LT', 'LV', 'EE', 'LU', 'CY', 'MT'];
    for (const cc of EU_SAMPLE) {
      it(`shows banner for ${cc}`, () => {
        assert.equal(shouldShowBanner({ country: cc }), true);
      });
    }
  });

  describe('Other strict jurisdictions', () => {
    it('shows banner for UK', () => {
      assert.equal(shouldShowBanner({ country: 'GB' }), true);
    });
    it('shows banner for Brazil', () => {
      assert.equal(shouldShowBanner({ country: 'BR' }), true);
    });
    it('shows banner for Canada', () => {
      assert.equal(shouldShowBanner({ country: 'CA' }), true);
    });
    it('shows banner for Switzerland', () => {
      assert.equal(shouldShowBanner({ country: 'CH' }), true);
    });
  });

  describe('United States — California carve-out', () => {
    it('does NOT show banner for US (no region)', () => {
      assert.equal(shouldShowBanner({ country: 'US' }), false);
    });
    it('does NOT show banner for US Texas', () => {
      assert.equal(shouldShowBanner({ country: 'US', region: 'TX' }), false);
    });
    it('does NOT show banner for US New York', () => {
      assert.equal(shouldShowBanner({ country: 'US', region: 'NY' }), false);
    });
    it('shows banner for US California (region "CA")', () => {
      assert.equal(shouldShowBanner({ country: 'US', region: 'CA' }), true);
    });
    it('shows banner for US California (full region "US-CA")', () => {
      assert.equal(shouldShowBanner({ country: 'US', region: 'US-CA' }), true);
    });
    it('shows banner for US California (lowercase)', () => {
      assert.equal(shouldShowBanner({ country: 'us', region: 'ca' }), true);
    });
  });

  describe('Permitted jurisdictions (no banner)', () => {
    it('does NOT show banner for Japan', () => {
      assert.equal(shouldShowBanner({ country: 'JP' }), false);
    });
    it('does NOT show banner for Australia', () => {
      assert.equal(shouldShowBanner({ country: 'AU' }), false);
    });
    it('does NOT show banner for Mexico', () => {
      assert.equal(shouldShowBanner({ country: 'MX' }), false);
    });
    it('does NOT show banner for India', () => {
      assert.equal(shouldShowBanner({ country: 'IN' }), false);
    });
  });

  describe('Fail-safe (unknown jurisdiction)', () => {
    it('shows banner for empty country', () => {
      assert.equal(shouldShowBanner({ country: '' }), true);
    });
    it('shows banner for null country', () => {
      assert.equal(shouldShowBanner({ country: null as any }), true);
    });
    it('shows banner for undefined country', () => {
      assert.equal(shouldShowBanner({ country: undefined as any }), true);
    });
    it('shows banner for unknown XX code (defensive — only known-permissive lists hide)', () => {
      // Implementation choice: only countries we have explicitly classified as
      // "permissive" hide the banner. Anything else fails safe to ON.
      assert.equal(shouldShowBanner({ country: 'XX' }), true);
    });
  });

  describe('Case insensitivity', () => {
    it('handles lowercase country codes', () => {
      assert.equal(shouldShowBanner({ country: 'de' }), true);
      assert.equal(shouldShowBanner({ country: 'us' }), false);
    });
    it('handles mixed case', () => {
      assert.equal(shouldShowBanner({ country: 'Gb' }), true);
    });
  });
});
