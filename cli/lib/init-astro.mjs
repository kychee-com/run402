/**
 * run402 init astro — scaffold a deployable Astro project for Run402.
 *
 * Capability `astro-ssr-runtime` (Run402 v1.52). Creates a minimal
 * working Astro project pre-wired with:
 *
 *   - `@run402/astro` preset (one-line astro.config.mjs)
 *   - package.json with `dev`/`deploy` scripts pointing at `run402 dev`/`run402 deploy`
 *   - Sample `src/pages/index.astro` and `src/pages/[slug].astro` (DB-backed dynamic page)
 *   - `.env.example` listing the env vars Run402 functions need
 *
 * Refuses to overwrite a non-empty directory unless `--force` is passed.
 *
 * @see https://docs.run402.com/astro
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fail } from "./sdk-errors.mjs";

const HELP = `run402 init astro — Scaffold a deployable Astro project

Usage:
  run402 init astro [<dir>] [--force]

Arguments:
  <dir>        Target directory (default: current directory)

Options:
  --force      Overwrite a non-empty directory

Output:
  Stdout is a JSON summary { dir, files_created, created, next_steps }.
  Progress lines ("Scaffolded ...", "Files created:", "Next steps:") go to
  stderr so a human re-running interactively sees what's happening while
  a script piping stdout to jq stays clean.

The scaffolded project includes:
  - package.json (with 'dev' / 'deploy' scripts)
  - astro.config.mjs (one-line @run402/astro preset)
  - src/pages/index.astro (hello page)
  - src/pages/[slug].astro (DB-backed dynamic page template)
  - .env.example (RUN402_PROJECT_ID + RUN402_SERVICE_KEY placeholders)

After scaffolding:
  cd <dir>
  npm install
  run402 dev          # local dev with Run402 context
  run402 deploy       # build + deploy to your Run402 project

If you don't have a Run402 project yet:
  run402 projects provision    # create one first
`;

export async function runInitAstro(args = []) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }
  const force = args.includes("--force");
  const positionals = args.filter((a) => !a.startsWith("--"));
  const targetDir = resolve(positionals[0] ?? ".");

  // Refuse non-empty dirs without --force.
  if (existsSync(targetDir)) {
    const entries = readdirSync(targetDir).filter((e) => !e.startsWith("."));
    if (entries.length > 0 && !force) {
      fail({
        code: "BAD_USAGE",
        message: `Target directory ${targetDir} is not empty.`,
        hint: "Pass --force to overwrite, or scaffold into a fresh directory.",
        details: { entries: entries.slice(0, 10) },
      });
      return;
    }
  } else {
    mkdirSync(targetDir, { recursive: true });
  }

  // Write files. All paths relative to targetDir.
  const files = [
    {
      path: "package.json",
      content: JSON.stringify(
        {
          name: "my-run402-astro-app",
          version: "0.0.1",
          private: true,
          type: "module",
          scripts: {
            dev: "run402 dev",
            deploy: "run402 deploy",
            build: "astro build",
            preview: "astro preview",
          },
          dependencies: {
            astro: "^7.0.0",
            "@run402/astro": "^2.4.2",
            "@run402/functions": "^3.0.0",
          },
        },
        null,
        2,
      ) + "\n",
    },
    {
      path: "astro.config.mjs",
      content: `// Run402 Astro preset. One config line gets you:
//   - SSR on Lambda with SnapStart
//   - ISR cache with cache.invalidate() admin-edit visibility
//   - AsyncLocalStorage context so db()/auth.* helpers work natively
//   - Build-time detectors for unsupported Astro features
import run402 from "@run402/astro";
export default run402();
`,
    },
    {
      path: ".env.example",
      content: `# Run402 project credentials. Copy to .env.local for 'run402 dev'.
# In production, these are injected automatically.
RUN402_PROJECT_ID=prj_...
RUN402_SERVICE_KEY=...
`,
    },
    {
      path: ".gitignore",
      content: `# build artifacts
dist/
node_modules/
.run402/

# local env
.env
.env.local
`,
    },
    {
      path: "src/pages/index.astro",
      content: `---
import Layout from "../layouts/Layout.astro";
---
<Layout title="Welcome">
  <main>
    <h1>Hello, Run402 + Astro</h1>
    <p>Edit this file at <code>src/pages/index.astro</code>.</p>
    <p>
      The dynamic page at <code>/[slug]</code> shows the DB-backed pattern.
      Try visiting <a href="/the-guys">/the-guys</a> after you create a
      pages row.
    </p>
  </main>
</Layout>
`,
    },
    {
      path: "src/pages/[slug].astro",
      content: `---
// Dynamic page. Fetches a row from your project's 'pages' table at
// SSR time. The first request renders + caches; subsequent requests
// HIT the cache. When an admin edits the row, call cache.invalidate()
// from your save handler for sub-second freshness.
import { db } from "@run402/functions";
import Layout from "../layouts/Layout.astro";

const { slug } = Astro.params;
const page = await db()
  .from("pages")
  .select("title, html, og_image")
  .eq("slug", slug)
  .maybeSingle();

if (!page) {
  return new Response("Not Found", { status: 404 });
}

// Set s-maxage to opt into the SSR cache layer. Without this, the
// response bypasses cache entirely (R402_CACHE_REASON: no_s_maxage).
Astro.response.headers.set(
  "Cache-Control",
  "public, s-maxage=60, stale-while-revalidate=300",
);
---

<Layout title={page.title} ogImage={page.og_image} canonical={Astro.url.href}>
  <article set:html={page.html} />
</Layout>
`,
    },
    {
      path: "src/layouts/Layout.astro",
      content: `---
interface Props {
  title: string;
  ogImage?: string | null;
  canonical?: string;
}
const { title, ogImage, canonical } = Astro.props;
---

<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width" />
    <title>{title}</title>
    {ogImage ? <meta property="og:image" content={ogImage} /> : null}
    {canonical ? <link rel="canonical" href={canonical} /> : null}
  </head>
  <body>
    <slot />
  </body>
</html>
`,
    },
    {
      path: "src/pages/api/save-page.ts",
      content: `// Admin save endpoint. Demonstrates the full CMS flow:
//   1. Auth check (cache layer bypasses entirely when Authorization header is present).
//   2. DB update.
//   3. cache.invalidate() so the public URL re-renders fresh on next visit.
import type { APIRoute } from "astro";
import { db, auth, cache } from "@run402/functions";

export const POST: APIRoute = async ({ request }) => {
  const user = await auth.requireUser();

  const body = (await request.json()) as { slug: string; title: string; html: string };
  if (!body?.slug) return new Response("Missing slug", { status: 400 });

  await db()
    .from("pages")
    .upsert({ slug: body.slug, title: body.title, html: body.html });

  // Invalidate the cached page so the next public request re-renders.
  await cache.invalidate(\`/\${body.slug}\`);

  return new Response(JSON.stringify({ ok: true, slug: body.slug }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
`,
    },
    {
      path: "AGENTS.md",
      content: `# AGENTS.md

This file documents the brutally-small Run402 surface this Astro project
uses. Coding agents: read this first. The platform is intentionally small —
there are no other auth helpers, no other client surfaces, and no other
hidden APIs.

## The auth surface

\`auth\` is the entire user-auth surface. Import from \`@run402/functions\`:

\`\`\`ts
import { auth } from "@run402/functions";

// In SSR pages and API routes:
const user = await auth.user();             // Actor | null
const user = await auth.requireUser();      // Actor; throws R402_AUTH_REQUIRED
const { user, role } = await auth.requireRole("admin");
const { user, membership } = await auth.requireMembership("member");
await auth.requireFresh({ maxAge: "10m", amr: ["passkey"] });

// Rich, ownership-qualified account-security read (backs <AccountSecurity>):
const sec = await auth.account.getSecurity();  // AccountSecurity | null

// CSRF for hosted forms (server-side, in <form> rendering):
const field = auth.csrfField();
// → <input type="hidden" name="_csrf" value="..." />

// Cross-origin-safe fetch (auto-forwards actor context to same-origin):
const res = await auth.fetch("/api/internal");  // relative URLs only
\`\`\`

## The four Never rules

1. **Never \`try\`/\`catch\` auth errors.** Let them bubble. The platform turns
   \`R402_AUTH_REQUIRED\` into a 303 to \`/auth/sign-in?return_to=…\` and
   \`R402_AUTH_INSUFFICIENT_ROLE\` into 403 with a fix-it response. Catching
   them creates silent-null bugs.

2. **Never \`.eq("user_id", user.id)\`.** \`db()\` propagates the actor to
   PostgREST so RLS enforces ownership server-side. The redundant filter is
   a code smell that \`run402 doctor\` flags as
   \`R402_AUTH_REDUNDANT_USER_FILTER\`.

3. **Never set client-supplied actor headers.** \`x-run402-actor-*\`,
   \`run402.actor.*\`, \`x-r402-actor-*\` are platform-owned channel headers.
   The gateway strips inbound spoofing attempts and emits
   \`R402_AUTH_ACTOR_HEADER_SPOOF\` in strict mode.

4. **Never mint a session from a raw \`userId\`.** Use
   \`auth.sessions.createResponseFromIdentity({ provider, subject, proof, amr })\`
   with a verified identity proof. No \`createSessionForUserId(uuid)\` API exists.

## Hosted UI components

For sign-in, sign-up, and sign-out chrome, use the platform's
\`@run402/astro\` components — they emit forms posting to platform hosted
routes (\`/auth/v1/sign-in\` etc.) with the CSRF token already wired:

\`\`\`astro
---
import { SignIn, SignUp, UserButton, AccountSecurity, SignedIn, SignedOut } from "@run402/astro";
---

<SignedIn>
  <UserButton />
</SignedIn>
<SignedOut>
  <SignIn returnTo="/dashboard" />
</SignedOut>

<!-- On an account page (gate on <SignedIn>): change password, manage
     passkeys, list/revoke sessions, sign out everywhere, link/unlink OAuth. -->
<SignedIn>
  <AccountSecurity sections={["password", "passkeys", "sessions", "identities"]} />
</SignedIn>
\`\`\`

The four hosted-auth components — \`<SignIn>\`, \`<SignUp>\`, \`<UserButton>\`,
\`<AccountSecurity>\` — plus the \`<SignedIn>\`/\`<SignedOut>\` gates emit forms
posting to the platform's hosted routes with the CSRF token already wired.
Each accepts a default \`<slot>\` for extras (OAuth buttons, links, panels)
without losing the zero-config default. Do NOT roll your own — the hosted
routes handle CSRF, returnTo validation, OAuth provider bridges, and passkey
ceremonies.

## Rendering-mode quick map

\`auth.*\` calls run at request time, so the page must be SSR or a
server-island. Calling \`auth.user()\` from a prerendered page throws
\`R402_AUTH_PRERENDERED\`.

| Mode                          | When                                | Auth-aware              |
| ----------------------------- | ----------------------------------- | ----------------------- |
| SSR (default)                 | Personalized pages                  | \`auth.user()\` works   |
| Prerendered                   | Marketing pages, never sees actor   | \`auth.*\` throws       |
| Server island                 | Prerendered page + personalized slot| \`auth.*\` in the island|
| Client hydrate                | Visibility-only, no SSR pass        | Component hits session  |

For error-code reference: https://run402.com/errors/#R402_AUTH_REQUIRED
`,
    },
  ];

  for (const file of files) {
    const fullPath = resolve(targetDir, file.path);
    mkdirSync(resolve(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, file.content, "utf-8");
  }

  // Human-readable progress goes to stderr; stdout stays JSON-clean.
  console.error(`Scaffolded Astro project at ${targetDir}`);
  console.error("");
  console.error("Files created:");
  for (const f of files) console.error(`  - ${f.path}`);
  console.error("");
  console.error("Next steps:");
  if (positionals[0]) console.error(`  cd ${positionals[0]}`);
  console.error("  npm install");
  console.error("  run402 deploy");

  console.log(
    JSON.stringify(
      {
        dir: targetDir,
        files_created: files.map((f) => f.path),
        created: true,
        next_steps: [
          `cd ${positionals[0] ?? "."}`,
          "npm install",
          "run402 deploy",
        ],
      },
      null,
      2,
    ),
  );
}
