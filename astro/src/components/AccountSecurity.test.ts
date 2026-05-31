/**
 * Tests for the `<AccountSecurity sections={["identities"]} />` "Connect Google"
 * control (account-security spec §"The identities section links and unlinks
 * OAuth to an already-signed-in account").
 *
 * Compiles the real `AccountSecurity.astro` with `@astrojs/compiler` and renders
 * it through Astro's experimental Container API — the same pipeline `SignIn.test.ts`
 * uses (the package's `tsx` harness has no `.astro` loader, so we drive the
 * compiler ourselves). The component reads `auth.account.getSecurity()` and
 * `auth.csrfToken()` from `@run402/functions` at render time, so we mock that
 * namespace for a signed-in user with no connected accounts (→ the Connect
 * Google control is shown).
 *
 * What this pins (the component half of the hosted Connect-Google fix):
 *   - the control links to the hosted OAuth start route with `?intent=link`
 *     (link-to-existing; the gateway resolves the browser-session cookie and
 *     stamps the signed-in actor as the link transaction's `linkingUserId`),
 *   - `returnTo` round-trips the current page so the user lands back on the
 *     panel after the Google round-trip,
 *   - it is NOT the pre-fix bare anchor (`?intent=link` with no `returnTo`).
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, mock } from "node:test";
import { transform } from "@astrojs/compiler";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import ts from "typescript";

// `<AccountSecurity>` calls `auth.account.getSecurity()` (rich read) and
// `auth.csrfToken()` in its frontmatter. We stub both. `securityState` is a
// mutable so individual tests can vary `run402_identities` (empty → "No
// connected accounts." + Connect Google; non-empty → an Unlink control per
// connected identity). `beforeEach` resets it to the no-identities default.
type Run402Identity = { provider: string; provider_sub: string; provider_email: string | null };

function makeSecurity(run402_identities: Run402Identity[] = []) {
  return {
    user: { id: "u1", email: "u@test.com", email_verified: true, display_name: null, avatar_url: null },
    has_run402_password: true,
    run402_passkey_count: 0,
    has_run402_passkey_for_current_rp: null,
    run402_identities,
    current_rp_id: null,
    passkey_rp_scope: "host",
    tenant_assertions: [],
  };
}

let securityState: ReturnType<typeof makeSecurity> = makeSecurity();

mock.module("@run402/functions", {
  namedExports: {
    auth: {
      account: {
        getSecurity: async () => securityState,
      },
      csrfToken: () => "0123456789abcdef0123456789abcdef",
    },
  },
});

beforeEach(() => {
  securityState = makeSecurity();
});

// ---------------------------------------------------------------------------
// Inlined render helper (mirrors SignIn.test.ts's compile pipeline).
// ---------------------------------------------------------------------------

async function loadAstroComponent(astroFileUrl: URL): Promise<unknown> {
  const filename = fileURLToPath(astroFileUrl);
  const src = readFileSync(filename, "utf8");
  const result = await transform(src, {
    filename,
    sourcemap: false,
    internalURL: "astro/runtime/server/index.js",
  });
  let code = ts.transpileModule(result.code, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  // No Vite here, so drop the virtual scoped-style side-effect import.
  code = code.replace(/^import\s+["'][^"']*\?astro&type=style[^"']*["'];?\s*$/gm, "");
  // Rewrite component-local ./x.js | ../x.js specifiers to .ts so tsx loads source.
  code = code.replace(/(from\s+")(\.\.?\/[^"]*)\.js(")/g, "$1$2.ts$3");
  // Modern Astro's runtime dropped the legacy createMetadata export — strip it.
  code = code.replace(/,\s*createMetadata as \$\$createMetadata/, "");
  code = code.replace(/const \$\$metadata = \$\$createMetadata\([\s\S]*?\);\n/, "");
  const tmpUrl = new URL(
    `./__rendered_acctsec_${Date.now()}_${Math.random().toString(36).slice(2)}.mjs`,
    astroFileUrl,
  );
  const tmpPath = fileURLToPath(tmpUrl);
  writeFileSync(tmpPath, code, "utf8");
  try {
    return ((await import(tmpUrl.href)) as { default: unknown }).default;
  } finally {
    rmSync(tmpPath, { force: true });
  }
}

const ACCOUNT_SECURITY_URL = new URL("./AccountSecurity.astro", import.meta.url);

/** Render the identities panel as if served from `currentUrl` (drives
 *  `Astro.url`, which the component reads to build the `returnTo`). */
async function renderIdentities(currentUrl: string): Promise<string> {
  const Component = await loadAstroComponent(ACCOUNT_SECURITY_URL);
  const container = await AstroContainer.create();
  return container.renderToString(Component as never, {
    props: { sections: ["identities"] },
    request: new Request(currentUrl),
  });
}

describe("AccountSecurity.astro — Connect Google control (link-to-existing)", () => {
  it("links to the hosted OAuth start route with ?intent=link", async () => {
    const html = await renderIdentities("https://kychon.run402.app/settings/security");
    assert.match(html, /href="\/auth\/sign-in\/oauth\/google\/start\?intent=link/);
    assert.match(html, />Connect Google</);
  });

  it("round-trips the current page through returnTo (user lands back on the panel)", async () => {
    const html = await renderIdentities("https://kychon.run402.app/settings/security");
    // `&` is HTML-escaped to `&amp;` inside the attribute; accept either form.
    assert.match(
      html,
      /href="\/auth\/sign-in\/oauth\/google\/start\?intent=link&(?:amp;)?returnTo=%2Fsettings%2Fsecurity"/,
    );
  });

  it("preserves the current query string in returnTo", async () => {
    const html = await renderIdentities("https://kychon.run402.app/account?tab=security");
    // encodeURIComponent("/account?tab=security")
    assert.match(html, /returnTo=%2Faccount%3Ftab%3Dsecurity/);
  });

  it("is NOT the pre-fix bare anchor (?intent=link with no returnTo)", async () => {
    const html = await renderIdentities("https://kychon.run402.app/settings/security");
    assert.doesNotMatch(html, /href="\/auth\/sign-in\/oauth\/google\/start\?intent=link"/);
  });
});

describe("AccountSecurity.astro — Unlink control (OAuth identities)", () => {
  beforeEach(() => {
    securityState = makeSecurity([
      { provider: "google", provider_sub: "google-sub-xyz", provider_email: "u@test.com" },
    ]);
  });

  it("renders an Unlink form per connected identity posting to the hosted route", async () => {
    const html = await renderIdentities("https://kychon.run402.app/settings/security");
    assert.match(html, /action="\/auth\/account\/identities\/unlink"/);
    assert.match(html, />Unlink</);
    // The provider label is shown alongside the unlink control.
    assert.match(html, /google — u@test\.com/);
  });

  it("posts the provider's subject id under name=\"subject\" (the field the route reads)", async () => {
    const html = await renderIdentities("https://kychon.run402.app/settings/security");
    // The wire field is `subject`, carrying the row's provider_sub value — this
    // matches the hosted route + SDK `unlink({ provider, subject })`.
    assert.match(html, /name="provider"[^>]*value="google"/);
    assert.match(html, /name="subject"[^>]*value="google-sub-xyz"/);
  });

  it("does NOT use the pre-fix name=\"provider_sub\" (which the route ignored → 400)", async () => {
    const html = await renderIdentities("https://kychon.run402.app/settings/security");
    // The old form posted `provider_sub`; the route reads `subject`, so the
    // OAuth subject arrived as undefined and every unlink 400'd.
    assert.doesNotMatch(html, /name="provider_sub"/);
  });

  it("includes the CSRF token in the unlink form", async () => {
    const html = await renderIdentities("https://kychon.run402.app/settings/security");
    assert.match(html, /name="_csrf"[^>]*value="0123456789abcdef0123456789abcdef"/);
  });
});
