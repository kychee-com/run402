/**
 * Region rule — saas-factory F19.
 *
 * Decides whether the cookie consent banner must be shown for a given user
 * jurisdiction. Pure function — no DOM, no I/O. The deploying site provides
 * the country (and optionally region) from a server-side header like
 * Cloudflare's `CF-IPCountry` / `CF-IPRegion` or CloudFront's
 * `cloudfront-viewer-country` / `cloudfront-viewer-country-region`.
 *
 * Behavior is **fail-safe to compliant**: if we don't recognize the input,
 * we show the banner.
 *
 * Scope: this module is shipped to saas-factory product sites (kysigned,
 * run402, bld402, etc.). Use across other Kychee surfaces is a separate
 * decision.
 */

/** ISO-3166-1 alpha-2 codes for the 27 EU member states. */
const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

/** Other jurisdictions where the banner is required. */
const OTHER_STRICT_COUNTRIES = new Set([
  'GB', // United Kingdom — UK GDPR + PECR
  'BR', // Brazil — LGPD
  'CA', // Canada — PIPEDA
  'CH', // Switzerland — revFADP
]);

/** Countries we have explicitly classified as banner-NOT-required. */
const PERMISSIVE_COUNTRIES = new Set([
  'US', // (with California carve-out, handled separately)
  'JP', 'AU', 'NZ', 'MX', 'IN', 'SG', 'KR', 'ZA', 'AR', 'CL',
]);

export interface JurisdictionInput {
  /** ISO-3166-1 alpha-2 country code. */
  country: string | null | undefined;
  /** Optional region/state — accepts "CA", "US-CA", or any subdivision code. */
  region?: string | null;
}

function isCalifornia(region: string | null | undefined): boolean {
  if (!region) return false;
  const normalized = region.trim().toUpperCase();
  return normalized === 'CA' || normalized === 'US-CA';
}

/**
 * Returns true when the consent banner must be shown for this jurisdiction.
 * Fails safe (returns true) on unknown / empty input.
 */
export function shouldShowBanner(input: JurisdictionInput): boolean {
  const country = (input.country ?? '').trim().toUpperCase();
  if (!country) return true; // fail-safe

  if (EU_COUNTRIES.has(country)) return true;
  if (OTHER_STRICT_COUNTRIES.has(country)) return true;

  // California carve-out: US is permissive except for California (CPRA).
  if (country === 'US') {
    return isCalifornia(input.region);
  }

  // Explicitly permissive — banner not needed.
  if (PERMISSIVE_COUNTRIES.has(country)) return false;

  // Anything else: fail-safe to compliant.
  return true;
}
