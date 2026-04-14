/**
 * Vanilla DOM consent banner — F19.
 *
 * Drop-in module for any saas-factory product site (static HTML or React).
 * Pure browser code — no framework dependency. The init function:
 *
 *   1. Decides whether to show the banner based on jurisdiction + stored
 *      consent + version.
 *   2. If a banner is required, builds it once and inserts it at the bottom
 *      of <body>.
 *   3. Wires Accept all / Reject all / Save preferences buttons.
 *   4. Calls back into the host site so it can flip GA4 / ad pixels on or off.
 *
 * Usage (typical static site):
 *
 *   <script type="module">
 *     import { initConsentBanner } from "/site-modules/consent-banner.js";
 *     initConsentBanner({
 *       country: "{{ CF_IPCOUNTRY }}",   // injected by edge / template
 *       region:  "{{ CF_REGION }}",      // optional
 *       policyVersion: 1,
 *       cookieNoticeUrl: "/cookie-notice",
 *       onConsentChange: (c) => {
 *         if (c.analytics) gtag('consent', 'update', { analytics_storage: 'granted' });
 *         if (c.marketing) gtag('consent', 'update', { ad_storage: 'granted' });
 *       },
 *     });
 *   </script>
 *
 * The host site is responsible for:
 *   - Loading GA4 / pixels with `default: denied` *before* this module runs.
 *   - Calling the host's analytics SDK from `onConsentChange`.
 *   - Adding a "Cookie settings" link in the footer that calls
 *     `openConsentSettings()` which this module exposes on `window`.
 */
import { shouldShowBanner } from './regions.js';
import {
  defaultConsent,
  loadConsent,
  saveConsent,
  shouldRePrompt,
  type ConsentChoice,
} from './storage.js';

export interface InitOptions {
  /** ISO-3166-1 alpha-2 country code (e.g. "DE"). Empty/missing = fail-safe to ON. */
  country: string | null | undefined;
  /** Optional region/state — used for the California carve-out. */
  region?: string | null;
  /** Bump this whenever the cookie/policy categories change to re-prompt all users. */
  policyVersion: number;
  /** Where to link "Read our Cookie Notice". */
  cookieNoticeUrl: string;
  /** Called whenever consent is recorded or updated. */
  onConsentChange?: (consent: ConsentChoice) => void;
  /** Override DOM root (default: document.body). */
  root?: HTMLElement;
}

const BANNER_ID = 'kychee-consent-banner';

export function initConsentBanner(opts: InitOptions): void {
  const root = opts.root ?? (typeof document !== 'undefined' ? document.body : null);
  if (!root) return; // SSR no-op

  // Always expose openConsentSettings so the footer link works regardless
  // of whether the banner was auto-shown.
  (window as unknown as { openConsentSettings: () => void }).openConsentSettings = () => buildBanner(opts, root, true);

  // Notify host of the current effective consent (for analytics init flow).
  const stored = loadConsent(window.localStorage);
  if (stored) opts.onConsentChange?.(stored);

  const required = shouldShowBanner({ country: opts.country, region: opts.region });
  if (!required) return;

  if (shouldRePrompt(window.localStorage, { version: opts.policyVersion })) {
    buildBanner(opts, root, false);
  }
}

function buildBanner(opts: InitOptions, root: HTMLElement, forced: boolean): void {
  // Re-open path: remove any existing banner.
  const existing = document.getElementById(BANNER_ID);
  if (existing) existing.remove();

  const stored = loadConsent(window.localStorage);
  const initial: ConsentChoice = stored ?? defaultConsent();

  const wrap = document.createElement('div');
  wrap.id = BANNER_ID;
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-live', 'polite');
  wrap.setAttribute('aria-label', 'Cookie consent');
  wrap.innerHTML = `
    <div class="kcb-card">
      <div class="kcb-body">
        <h2 class="kcb-title">Cookies</h2>
        <p class="kcb-text">
          We use cookies to make this site work, measure how it's used, and (when running campaigns) measure which ads bring real users.
          Essential cookies are always on. The rest are off by default — your choice.
          <a href="${escapeAttr(opts.cookieNoticeUrl)}">Read our Cookie Notice</a>.
        </p>
        <div class="kcb-toggles">
          <label class="kcb-toggle"><input type="checkbox" checked disabled> <span>Essential</span><small>Required to make the site work.</small></label>
          <label class="kcb-toggle"><input type="checkbox" data-cat="analytics" ${initial.analytics ? 'checked' : ''}> <span>Analytics</span><small>Anonymous usage stats so we can improve the product.</small></label>
          <label class="kcb-toggle"><input type="checkbox" data-cat="marketing" ${initial.marketing ? 'checked' : ''}> <span>Marketing</span><small>Measure which ad campaigns deliver real users. No cross-site profiling.</small></label>
        </div>
      </div>
      <div class="kcb-actions">
        <button type="button" class="kcb-btn kcb-btn-secondary" data-action="reject">Reject all</button>
        <button type="button" class="kcb-btn kcb-btn-secondary" data-action="save">Save preferences</button>
        <button type="button" class="kcb-btn kcb-btn-primary" data-action="accept">Accept all</button>
      </div>
    </div>
  `;
  root.appendChild(wrap);

  const close = (choice: ConsentChoice) => {
    saveConsent(window.localStorage, choice, {
      country: opts.country,
      region: opts.region,
      version: opts.policyVersion,
    });
    opts.onConsentChange?.(choice);
    wrap.remove();
  };

  wrap.querySelector('[data-action="accept"]')?.addEventListener('click', () => {
    close({ essential: true, analytics: true, marketing: true });
  });
  wrap.querySelector('[data-action="reject"]')?.addEventListener('click', () => {
    close({ essential: true, analytics: false, marketing: false });
  });
  wrap.querySelector('[data-action="save"]')?.addEventListener('click', () => {
    const analytics = (wrap.querySelector('[data-cat="analytics"]') as HTMLInputElement).checked;
    const marketing = (wrap.querySelector('[data-cat="marketing"]') as HTMLInputElement).checked;
    close({ essential: true, analytics, marketing });
  });

  // If this was a forced re-open and the user clicks outside, leave the
  // current consent in place — they're editing, not rejecting.
  void forced;
}

function escapeAttr(s: string): string {
  return s.replace(/[&"'<>]/g, (c) =>
    ({ '&': '&amp;', '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;' }[c]!)
  );
}
