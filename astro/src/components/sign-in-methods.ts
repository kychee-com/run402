/**
 * Pure HTML builders for the `<SignIn methods={[...]} />` multi-method render.
 *
 * The `.astro` component is a thin wrapper: for the byte-identical default
 * (`methods` omitted or exactly `["password"]`) it renders its original
 * markup verbatim and never touches this module. For any other combination it
 * delegates the *extra* (non-password) method markup + the divider chrome +
 * the extra `<style>` rules to the functions here, then splices them in via
 * `set:html`.
 *
 * Keeping the markup generation in plain TypeScript means the existing
 * `tsx`-based unit harness can assert the emitted HTML directly (the same
 * approach `component.test.ts` takes for `buildPictureHtml` — Astro's compiler
 * is not in the unit-test loader, so the `.astro` wiring is exercised by the
 * `minimal-site` fixture build instead).
 *
 * Route shapes are byte-verified against the deployed gateway
 * (`packages/gateway/src/routes/auth-hosted.ts`):
 *   - `magic_link` → `POST /auth/magic-link/send`     (form-urlencoded {email, returnTo})
 *   - `google`     → `GET  /auth/sign-in/oauth/google/start?returnTo=…`
 *   - `passkey`    → `POST /auth/passkeys/login/options` then `/verify`
 *                    ({options, challenge_id} → {ok, redirectTo})
 *
 * `password`, `magic_link`, and `google` are NO-JS (plain form / anchor).
 * `passkey` is the only method that ships a small WebAuthn `<script>` —
 * `navigator.credentials.get` is a browser-only API with no no-JS fallback.
 *
 * Capability `auth-hosted-surface-parity` / spec `hosted-auth-ui` (§6.1/§6.3).
 */

export type SignInMethod = "password" | "magic_link" | "google" | "passkey";

/** The default when `methods` is omitted. Kept as a named export so the
 *  component and tests agree on the byte-identical-default sentinel. */
export const DEFAULT_METHODS: SignInMethod[] = ["password"];

/**
 * True when the requested `methods` is the byte-identical-default case:
 * omitted/undefined, or exactly `["password"]`. In that case the component
 * MUST render its original DOM verbatim (§6.1/§6.3 "Non-breaking no-slot
 * upgrade") and never reach for any builder here.
 */
export function isDefaultOnly(methods: SignInMethod[] | undefined): boolean {
  if (methods === undefined) return true;
  return methods.length === 1 && methods[0] === "password";
}

/**
 * Normalise/validate the requested methods, preserving caller order and
 * de-duplicating. Unknown strings are dropped. An empty/all-dropped result
 * falls back to the default so the component always renders *something*
 * sign-in-able rather than an empty shell.
 */
export function normalizeMethods(methods: SignInMethod[] | undefined): SignInMethod[] {
  if (methods === undefined) return [...DEFAULT_METHODS];
  const allowed: ReadonlySet<string> = new Set<SignInMethod>([
    "password",
    "magic_link",
    "google",
    "passkey",
  ]);
  const seen = new Set<string>();
  const out: SignInMethod[] = [];
  for (const m of methods) {
    if (allowed.has(m) && !seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out.length > 0 ? out : [...DEFAULT_METHODS];
}

/** Minimal HTML-attribute-value escape for the values we interpolate
 *  (`returnTo`). Mirrors the escaping Astro applies to `{expr}` attributes so
 *  the spliced `set:html` markup is consistent with the rest of the tree. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** The "or" separator rendered between adjacent methods. */
export function dividerHtml(): string {
  return `<div class="r402-divider" role="separator" aria-label="or"><span>or</span></div>`;
}

/** `magic_link` — a SEPARATE no-JS form posting to the hosted send route. */
export function magicLinkFormHtml(returnTo: string): string {
  const rt = escapeAttr(returnTo);
  return (
    `<form method="POST" action="/auth/magic-link/send" class="r402-magic-link">` +
    `<input type="hidden" name="returnTo" value="${rt}" />` +
    `<label class="r402-field">` +
    `<span class="r402-label">Email</span>` +
    `<input type="email" name="email" required autocomplete="email" class="r402-input" />` +
    `</label>` +
    `<button type="submit" class="r402-method-button">Email me a sign-in link</button>` +
    `</form>`
  );
}

/** `google` — a no-JS link/button to the hosted OAuth start route (GET).
 *  `errorReturnTo` (hosted-auth-signin-error-ssr): the same-origin sign-in-page
 *  URL the gateway returns to on a FAILED sign-in, with `?r402_auth_error=<code>`.
 *  When provided it rides the start link so the error round-trip is zero-config. */
export function googleOauthHtml(returnTo: string, errorReturnTo?: string): string {
  // The href is built with encodeURIComponent at render time; the resulting
  // string is then attribute-escaped so `&` becomes `&amp;` in the markup.
  const qs =
    `returnTo=${encodeURIComponent(returnTo)}` +
    (errorReturnTo ? `&errorReturnTo=${encodeURIComponent(errorReturnTo)}` : "");
  const href = escapeAttr(`/auth/sign-in/oauth/google/start?${qs}`);
  return `<a class="r402-oauth r402-oauth-google" href="${href}">Continue with Google</a>`;
}

/** `passkey` — the button. The accompanying `<script>` is emitted once by the
 *  component (it is hoisted/bundled by Astro and shared across instances). */
export function passkeyButtonHtml(returnTo: string): string {
  const rt = escapeAttr(returnTo);
  return (
    `<button type="button" class="r402-passkey" data-r402-passkey data-return-to="${rt}">` +
    `Sign in with a passkey` +
    `</button>`
  );
}

/**
 * Build the ordered list of EXTRA (non-password) method markup blocks, each as
 * a discrete HTML string. Dividers are NOT included here — the caller (the
 * component, or `buildExtraMethodsHtml`) interleaves them so a divider renders
 * between every adjacent pair across the full ordered method list (including
 * the password form, which the component owns).
 */
export function buildMethodBlocks(methods: SignInMethod[], returnTo: string, errorReturnTo?: string): string[] {
  const out: string[] = [];
  for (const m of methods) {
    switch (m) {
      case "magic_link":
        out.push(magicLinkFormHtml(returnTo));
        break;
      case "google":
        out.push(googleOauthHtml(returnTo, errorReturnTo));
        break;
      case "passkey":
        out.push(passkeyButtonHtml(returnTo));
        break;
      case "password":
        // The password form is rendered natively by the .astro file (so its
        // markup stays byte-identical to the original); it is never built here.
        break;
    }
  }
  return out;
}

/**
 * Build the full set:html payload for the EXTRA methods that follow the
 * native password form. `passwordIsFirst` controls whether a leading divider
 * is emitted before the first extra block (true when the password form was
 * rendered just above these siblings, so the "or" sits between password and
 * the next method). When `password` is NOT among the methods there is no
 * leading divider and the blocks are simply divider-joined.
 */
export function buildExtraMethodsHtml(
  methods: SignInMethod[],
  returnTo: string,
  passwordIsFirst: boolean,
  errorReturnTo?: string,
): string {
  const blocks = buildMethodBlocks(methods, returnTo, errorReturnTo);
  if (blocks.length === 0) return "";
  const divider = dividerHtml();
  const joined = blocks.join(divider);
  return passwordIsFirst ? divider + joined : joined;
}

/** Whether the requested methods include the native password form. */
export function includesPassword(methods: SignInMethod[]): boolean {
  return methods.includes("password");
}

/**
 * The browser glue that drives the hosted WebAuthn ceremony for the `passkey`
 * method. Emitted verbatim inside an Astro `<script>` (bundled/hoisted by
 * Astro). Mirrors the route contract proven by the gateway e2e:
 *   POST /auth/passkeys/login/options  → {options, challenge_id}
 *   navigator.credentials.get(...)
 *   POST /auth/passkeys/login/verify   → {ok, redirectTo}
 *
 * Exported as a string so a unit test can assert its presence/shape and so the
 * exact same source is used by the component (single source of truth).
 */
export const PASSKEY_SCRIPT = `
(() => {
  if (!window.PublicKeyCredential) {
    document.querySelectorAll('[data-r402-passkey]').forEach((el) => {
      el.setAttribute('hidden', '');
      el.setAttribute('disabled', '');
    });
    return;
  }
  const b2b = (s) => {
    const p = '='.repeat((4 - (s.length % 4)) % 4);
    const b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/'));
    const u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u.buffer;
  };
  const a2b = (buf) => {
    const u = new Uint8Array(buf);
    let s = '';
    for (const x of u) s += String.fromCharCode(x);
    return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  };
  document.querySelectorAll('[data-r402-passkey]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const returnTo = btn.getAttribute('data-return-to') || '/';
      try {
        const r = await fetch('/auth/passkeys/login/options', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ app_origin: location.origin }),
        });
        const j = await r.json();
        const o = j.options;
        const publicKey = {
          ...o,
          challenge: b2b(o.challenge),
          allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: b2b(c.id) })),
        };
        const cred = await navigator.credentials.get({ publicKey });
        const resp = {
          id: cred.id,
          rawId: a2b(cred.rawId),
          type: cred.type,
          response: {
            authenticatorData: a2b(cred.response.authenticatorData),
            clientDataJSON: a2b(cred.response.clientDataJSON),
            signature: a2b(cred.response.signature),
            userHandle: cred.response.userHandle ? a2b(cred.response.userHandle) : null,
          },
        };
        const v = await fetch('/auth/passkeys/login/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ challenge_id: j.challenge_id, response: resp, returnTo }),
        });
        const vj = await v.json().catch(() => ({}));
        if (v.ok && vj.redirectTo) {
          location.assign(vj.redirectTo);
        } else {
          location.reload();
        }
      } catch (_err) {
        // Ceremony aborted/failed — do nothing destructive; leave the page.
      }
    });
  });
})();
`;

/** The extra `<style>` rules appended (only in the multi-method branch) for
 *  the new `.r402-*` method chrome. Kept consistent with the minimal
 *  `.r402-*` styling pattern already in the component. */
export const EXTRA_METHOD_CSS = `
  .r402-divider {
    display: flex;
    align-items: center;
    text-align: center;
    color: var(--r402-divider-fg, #888);
    font-size: 0.8125rem;
    gap: 0.75rem;
  }
  .r402-divider::before,
  .r402-divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--r402-border, #ccc);
  }
  .r402-magic-link {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin: 0;
  }
  .r402-method-button,
  .r402-oauth,
  .r402-passkey {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.625rem 1rem;
    font-size: 1rem;
    font-weight: 500;
    text-decoration: none;
    color: var(--r402-method-fg, #111);
    background: var(--r402-method-bg, #fff);
    border: 1px solid var(--r402-border, #ccc);
    border-radius: var(--r402-radius, 0.375rem);
    cursor: pointer;
  }
  .r402-method-button:hover,
  .r402-oauth:hover,
  .r402-passkey:hover {
    background: var(--r402-method-hover-bg, #f5f5f5);
  }
  .r402-passkey[hidden] {
    display: none;
  }
  .r402-auth-error {
    padding: 0.625rem 0.75rem;
    font-size: 0.875rem;
    color: var(--r402-error-fg, #8a1c1c);
    background: var(--r402-error-bg, #fdecea);
    border: 1px solid var(--r402-error-border, #f5c2c0);
    border-radius: var(--r402-radius, 0.375rem);
  }
`;

/**
 * hosted-auth-signin-error-ssr: surfacing hosted sign-in errors in <SignIn>.
 *
 * On a FAILED hosted OAuth sign-in the gateway returns the visitor to the
 * sign-in page with `?<AUTH_ERROR_PARAM>=<code>` — a SERVER-READABLE query param
 * (not the legacy URL hash), so the no-JS SSR component renders a message with
 * zero consumer code. The codes mirror the gateway callback's recoverable
 * reasons (see the gateway's `redirectError`).
 */
export const AUTH_ERROR_PARAM = "r402_auth_error";

/** Specific, user-actionable copy for codes a visitor can act on. Infra /
 *  transient codes intentionally fall through to the generic message. */
export const AUTH_ERROR_MESSAGES: Record<string, string> = {
  domain_not_allowed:
    "This site is restricted to approved email domains. Sign in with your work account.",
  account_exists_requires_link:
    "An account with this email already exists. Sign in with your original method, then link Google from your account settings.",
  identity_already_linked:
    "This Google account is already linked to a different account.",
};

const GENERIC_AUTH_ERROR = "Sign-in could not be completed. Please try again.";

/**
 * Map a delivered `r402_auth_error` code to user-facing copy. Returns null for
 * no/empty code (nothing to show). Known user-actionable codes get specific
 * copy; anything else (incl. infra codes like `token_exchange_failed`) gets a
 * safe generic message rather than leaking a raw code or rendering blank.
 */
export function messageForAuthError(code: string | null | undefined): string | null {
  if (!code) return null;
  return AUTH_ERROR_MESSAGES[code] ?? GENERIC_AUTH_ERROR;
}
