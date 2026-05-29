/**
 * Tests for `<SignIn methods={[...]} />` (auth-hosted-surface-parity §6.1/§6.3).
 *
 * Two layers:
 *
 *  1. **Rendered-DOM tests** — compile the real `SignIn.astro` with
 *     `@astrojs/compiler` + render it through Astro's experimental Container
 *     API (the package's `tsx` unit harness has no `.astro` loader, so we drive
 *     the compiler ourselves; helper inlined below so no test util ships in
 *     `dist`). These assert the actual emitted HTML for each `methods` shape,
 *     including the load-bearing byte-identical-default contract: the default
 *     render is compared against a pinned copy of the PRE-change component
 *     (`test/fixtures/sign-in-baseline/SignIn.original.astro`), normalising
 *     only Astro's build-derived scoped-style hash.
 *
 *  2. **Pure-builder tests** — direct assertions on `sign-in-methods.ts`, the
 *     module the component delegates its non-password markup to.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { transform } from "@astrojs/compiler";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import ts from "typescript";

import {
  type SignInMethod,
  isDefaultOnly,
  normalizeMethods,
  includesPassword,
  buildExtraMethodsHtml,
  buildMethodBlocks,
  magicLinkFormHtml,
  googleOauthHtml,
  passkeyButtonHtml,
  dividerHtml,
  PASSKEY_SCRIPT,
  DEFAULT_METHODS,
} from "./sign-in-methods.js";

// ---------------------------------------------------------------------------
// Inlined render helper (see the file-level doc for the compile pipeline).
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
    `./__rendered_${Date.now()}_${Math.random().toString(36).slice(2)}.mjs`,
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

async function render(
  astroFileUrl: URL,
  props: Record<string, unknown> = {},
): Promise<string> {
  const Component = await loadAstroComponent(astroFileUrl);
  const container = await AstroContainer.create();
  return container.renderToString(Component as never, { props });
}

/** Astro derives the `astro-xxxxxxxx` scope hash from component source and
 *  regenerates it on ANY edit; it is not part of the authored-DOM contract.
 *  Normalise it out before byte-comparing two renders. */
function stripScope(html: string): string {
  return html.replace(/\s*astro-[0-9a-z]+/g, "");
}

/** The DOM markup only — everything before the first `<style>` block. The
 *  non-default render appends an `is:global` `<style>` whose CSS text mentions
 *  `.r402-oauth`, `.r402-divider`, etc.; structural counts and negative
 *  class-presence checks must run against the markup, not the stylesheet. */
function markup(html: string): string {
  const i = html.indexOf("<style");
  return i === -1 ? html : html.slice(0, i);
}

const SIGNIN_URL = new URL("./SignIn.astro", import.meta.url);
const BASELINE_URL = new URL(
  "../../test/fixtures/sign-in-baseline/SignIn.original.astro",
  import.meta.url,
);

// ---------------------------------------------------------------------------
// (a) Default render is unchanged (byte-identical to the pre-change component).
// ---------------------------------------------------------------------------

describe("SignIn.astro — byte-identical default (§6.1/§6.3)", () => {
  // The authored DOM the default branch emits is character-for-character the
  // pre-change component: same tags, attributes, classes, text, comments,
  // inter-element whitespace, and `<slot/>`. The ONLY normalisations applied
  // are (1) Astro's build-derived `astro-xxxxxxxx` scope hash (regenerated on
  // any source edit; not a stable contract) and (2) trailing whitespace —
  // wrapping the form in the new `{defaultOnly ? … : …}` expression makes
  // Astro emit a few literal source newlines after `</form>` (before the
  // hoisted `<style>`); that trailing whitespace is collapsed by every browser
  // and is not part of the DOM. The body — `<form …>` through `</form>` — is
  // asserted byte-for-byte unchanged below.
  const norm = (html: string) => stripScope(html).trimEnd();

  it("no methods prop: render matches the pinned pre-change baseline", async () => {
    const current = norm(await render(SIGNIN_URL, { returnTo: "/dashboard" }));
    const baseline = norm(await render(BASELINE_URL, { returnTo: "/dashboard" }));
    assert.equal(current, baseline);
  });

  it("methods=['password']: render matches the pinned pre-change baseline", async () => {
    const current = norm(await render(SIGNIN_URL, { returnTo: "/x", methods: ["password"] }));
    const baseline = norm(await render(BASELINE_URL, { returnTo: "/x" }));
    assert.equal(current, baseline);
  });

  it("default render body (<form>…</form>) is byte-for-byte the pre-change DOM", async () => {
    // Stronger than the trimEnd() comparison: extract the form subtree and
    // require an exact match, leaving no room for a stray internal whitespace
    // change to hide behind the trailing-whitespace normalisation.
    const formOf = (html: string) => {
      const s = stripScope(html);
      const start = s.indexOf("<form");
      const end = s.indexOf("</form>") + "</form>".length;
      return s.slice(start, end);
    };
    const current = formOf(await render(SIGNIN_URL, { returnTo: "/dashboard" }));
    const baseline = formOf(await render(BASELINE_URL, { returnTo: "/dashboard" }));
    assert.equal(current, baseline);
    assert.match(current, /^<form method="POST" action="\/auth\/sign-in"/);
  });

  it("default render: the password form is present, the multi-method wrapper is NOT", async () => {
    const html = await render(SIGNIN_URL, { returnTo: "/dashboard" });
    assert.match(html, /<form[^>]*method="POST"[^>]*action="\/auth\/sign-in"/);
    assert.match(html, /class="r402-sign-in[^"]*"/);
    assert.match(html, /<input type="hidden" name="returnTo" value="\/dashboard"/);
    assert.doesNotMatch(html, /r402-sign-in-methods/);
  });

  it("default render: no magic-link / oauth / passkey / divider / script", async () => {
    const html = await render(SIGNIN_URL, { returnTo: "/" });
    assert.doesNotMatch(html, /\/auth\/magic-link\/send/);
    assert.doesNotMatch(html, /r402-magic-link/);
    assert.doesNotMatch(html, /\/auth\/sign-in\/oauth\/google\/start/);
    assert.doesNotMatch(html, /r402-oauth/);
    assert.doesNotMatch(html, /data-r402-passkey/);
    assert.doesNotMatch(html, /r402-divider/);
    assert.doesNotMatch(html, /<script/);
  });
});

// ---------------------------------------------------------------------------
// (b)–(e) Per-method rendered DOM.
// ---------------------------------------------------------------------------

describe("SignIn.astro — methods rendering", () => {
  it("(b) methods=['magic_link'] renders a form action='/auth/magic-link/send' and no password form", async () => {
    const html = await render(SIGNIN_URL, { returnTo: "/portal", methods: ["magic_link"] });
    const dom = markup(html);
    assert.match(dom, /<form method="POST" action="\/auth\/magic-link\/send" class="r402-magic-link">/);
    assert.match(dom, /<input type="hidden" name="returnTo" value="\/portal" \/>/);
    assert.match(dom, /name="email" required autocomplete="email"/);
    assert.match(dom, /Email me a sign-in link/);
    // No password form, no other methods (markup, not the stylesheet).
    assert.doesNotMatch(dom, /action="\/auth\/sign-in"/);
    assert.doesNotMatch(dom, /<a class="r402-oauth/);
    assert.doesNotMatch(dom, /data-r402-passkey/);
    // Single method → no divider in the DOM.
    assert.doesNotMatch(dom, /<div class="r402-divider"/);
    // No WebAuthn script for a no-JS method.
    assert.doesNotMatch(dom, /<script/);
  });

  it("(c) methods=['google'] renders an anchor href containing /auth/sign-in/oauth/google/start", async () => {
    const html = await render(SIGNIN_URL, { returnTo: "/portal", methods: ["google"] });
    const dom = markup(html);
    assert.match(
      dom,
      /<a class="r402-oauth r402-oauth-google" href="\/auth\/sign-in\/oauth\/google\/start\?returnTo=%2Fportal">Continue with Google<\/a>/,
    );
    assert.doesNotMatch(dom, /action="\/auth\/sign-in"/);
    assert.doesNotMatch(dom, /<script/);
  });

  it("(d) methods=['passkey'] renders [data-r402-passkey] + the passkey script", async () => {
    const html = await render(SIGNIN_URL, { returnTo: "/portal", methods: ["passkey"] });
    assert.match(
      html,
      /<button type="button" class="r402-passkey" data-r402-passkey data-return-to="\/portal">Sign in with a passkey<\/button>/,
    );
    // The WebAuthn glue ships exactly once.
    assert.match(html, /<script>/);
    assert.match(html, /\/auth\/passkeys\/login\/options/);
    assert.match(html, /navigator\.credentials\.get/);
    assert.match(html, /\/auth\/passkeys\/login\/verify/);
    assert.match(html, /if \(!window\.PublicKeyCredential\)/);
    assert.match(html, /location\.assign\(vj\.redirectTo\)/);
    // No password form for passkey-only.
    assert.doesNotMatch(html, /action="\/auth\/sign-in"/);
  });

  it("(e) methods=[all four] renders all four + three dividers + the script", async () => {
    const html = await render(SIGNIN_URL, {
      returnTo: "/dash",
      methods: ["password", "magic_link", "google", "passkey"],
    });
    const dom = markup(html);
    // Wrapper + password form.
    assert.match(dom, /class="r402-sign-in-methods[^"]*"/);
    assert.match(dom, /action="\/auth\/sign-in"/);
    // The three credential methods.
    assert.match(dom, /\/auth\/magic-link\/send/);
    assert.match(dom, /\/auth\/sign-in\/oauth\/google\/start\?returnTo=%2Fdash/);
    assert.match(dom, /data-r402-passkey/);
    // Four methods in a row → exactly three "or" divider elements in the DOM.
    const dividers = dom.match(/<div class="r402-divider"/g) ?? [];
    assert.equal(dividers.length, 3);
    // The passkey script is present once (whole HTML).
    const scripts = html.match(/<script>/g) ?? [];
    assert.equal(scripts.length, 1);
    // Order: password form before magic-link before google before passkey.
    const iPw = dom.indexOf('action="/auth/sign-in"');
    const iMl = dom.indexOf("/auth/magic-link/send");
    const iGo = dom.indexOf("/auth/sign-in/oauth/google/start");
    const iPk = dom.indexOf("data-r402-passkey");
    assert.ok(iPw < iMl && iMl < iGo && iGo < iPk, "methods render in the order given");
  });

  it("custom order is preserved (passkey, google) and a single divider sits between", async () => {
    const html = await render(SIGNIN_URL, { returnTo: "/", methods: ["passkey", "google"] });
    const dom = markup(html);
    const iPk = dom.indexOf("data-r402-passkey");
    const iGo = dom.indexOf("/auth/sign-in/oauth/google/start");
    assert.ok(iPk < iGo, "passkey renders before google");
    const dividers = dom.match(/<div class="r402-divider"/g) ?? [];
    assert.equal(dividers.length, 1);
    // No password form (not requested), but passkey still ships its script.
    assert.doesNotMatch(dom, /action="\/auth\/sign-in"/);
    assert.match(html, /<script>/);
  });

  it("returnTo is HTML-attribute-escaped where interpolated", async () => {
    const html = await render(SIGNIN_URL, {
      returnTo: '/a&b"c',
      methods: ["magic_link", "google"],
    });
    // magic-link hidden input value escaped
    assert.match(html, /name="returnTo" value="\/a&amp;b&quot;c"/);
    // google href: encodeURIComponent then attribute-escape (& → &amp;)
    assert.match(html, /href="\/auth\/sign-in\/oauth\/google\/start\?returnTo=%2Fa%26b%22c"/);
  });
});

// ---------------------------------------------------------------------------
// Pure-builder unit tests (sign-in-methods.ts).
// ---------------------------------------------------------------------------

describe("sign-in-methods — isDefaultOnly / normalizeMethods", () => {
  it("isDefaultOnly: undefined and ['password'] are the default", () => {
    assert.equal(isDefaultOnly(undefined), true);
    assert.equal(isDefaultOnly(["password"]), true);
  });

  it("isDefaultOnly: any other shape is NOT the default", () => {
    assert.equal(isDefaultOnly([]), false);
    assert.equal(isDefaultOnly(["magic_link"]), false);
    assert.equal(isDefaultOnly(["password", "google"]), false);
  });

  it("DEFAULT_METHODS is exactly ['password']", () => {
    assert.deepEqual(DEFAULT_METHODS, ["password"]);
  });

  it("normalizeMethods: undefined → default copy (not the shared array)", () => {
    const out = normalizeMethods(undefined);
    assert.deepEqual(out, ["password"]);
    assert.notEqual(out, DEFAULT_METHODS);
  });

  it("normalizeMethods: preserves order, de-dupes, drops unknowns", () => {
    const out = normalizeMethods([
      "google",
      "password",
      "google",
      // @ts-expect-error — exercise the runtime unknown-drop path
      "facebook",
      "passkey",
    ] as SignInMethod[]);
    assert.deepEqual(out, ["google", "password", "passkey"]);
  });

  it("normalizeMethods: empty / all-unknown falls back to default", () => {
    assert.deepEqual(normalizeMethods([]), ["password"]);
    // @ts-expect-error — runtime unknown-drop
    assert.deepEqual(normalizeMethods(["nope"]), ["password"]);
  });

  it("includesPassword reflects membership", () => {
    assert.equal(includesPassword(["password", "google"]), true);
    assert.equal(includesPassword(["google", "passkey"]), false);
  });
});

describe("sign-in-methods — markup builders", () => {
  it("magicLinkFormHtml posts to /auth/magic-link/send with escaped returnTo", () => {
    const html = magicLinkFormHtml("/a&b");
    assert.match(html, /^<form method="POST" action="\/auth\/magic-link\/send" class="r402-magic-link">/);
    assert.match(html, /name="returnTo" value="\/a&amp;b"/);
    assert.match(html, /<button type="submit" class="r402-method-button">Email me a sign-in link<\/button>/);
  });

  it("googleOauthHtml builds the encoded + escaped start href", () => {
    assert.equal(
      googleOauthHtml("/portal?x=1"),
      '<a class="r402-oauth r402-oauth-google" href="/auth/sign-in/oauth/google/start?returnTo=%2Fportal%3Fx%3D1">Continue with Google</a>',
    );
  });

  it("passkeyButtonHtml emits the data hooks + escaped returnTo", () => {
    assert.equal(
      passkeyButtonHtml('/x"y'),
      '<button type="button" class="r402-passkey" data-r402-passkey data-return-to="/x&quot;y">Sign in with a passkey</button>',
    );
  });

  it("dividerHtml is the 'or' separator", () => {
    assert.equal(dividerHtml(), '<div class="r402-divider" role="separator" aria-label="or"><span>or</span></div>');
  });

  it("buildMethodBlocks excludes the password form (rendered natively)", () => {
    const blocks = buildMethodBlocks(["password", "magic_link", "google", "passkey"], "/");
    assert.equal(blocks.length, 3);
    assert.ok(blocks[0]!.includes("/auth/magic-link/send"));
    assert.ok(blocks[1]!.includes("/auth/sign-in/oauth/google/start"));
    assert.ok(blocks[2]!.includes("data-r402-passkey"));
  });

  it("buildExtraMethodsHtml: passwordIsFirst adds a leading divider", () => {
    const html = buildExtraMethodsHtml(["password", "google"], "/", true);
    assert.ok(html.startsWith('<div class="r402-divider"'));
    const dividers = html.match(/r402-divider/g) ?? [];
    assert.equal(dividers.length, 1);
  });

  it("buildExtraMethodsHtml: no password → no leading divider, joined between", () => {
    const html = buildExtraMethodsHtml(["magic_link", "google", "passkey"], "/", false);
    assert.ok(!html.startsWith('<div class="r402-divider"'));
    const dividers = html.match(/r402-divider/g) ?? [];
    assert.equal(dividers.length, 2); // two separators between three methods
  });

  it("buildExtraMethodsHtml: empty when only password", () => {
    assert.equal(buildExtraMethodsHtml(["password"], "/", true), "");
  });

  it("PASSKEY_SCRIPT drives the hosted ceremony contract", () => {
    assert.match(PASSKEY_SCRIPT, /\/auth\/passkeys\/login\/options/);
    assert.match(PASSKEY_SCRIPT, /app_origin: location\.origin/);
    assert.match(PASSKEY_SCRIPT, /navigator\.credentials\.get/);
    assert.match(PASSKEY_SCRIPT, /\/auth\/passkeys\/login\/verify/);
    assert.match(PASSKEY_SCRIPT, /challenge_id: j\.challenge_id/);
    assert.match(PASSKEY_SCRIPT, /if \(v\.ok && vj\.redirectTo\)/);
    assert.match(PASSKEY_SCRIPT, /location\.assign\(vj\.redirectTo\)/);
    assert.match(PASSKEY_SCRIPT, /location\.reload\(\)/);
    // WebAuthn-unavailable guard hides/disables the button.
    assert.match(PASSKEY_SCRIPT, /if \(!window\.PublicKeyCredential\)/);
    assert.match(PASSKEY_SCRIPT, /\[data-r402-passkey\]/);
    // try/catch so a failed ceremony does nothing destructive.
    assert.match(PASSKEY_SCRIPT, /catch \(_err\)/);
  });
});
