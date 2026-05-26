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
  run402 init astro [<dir>] [--force] [--json]

Arguments:
  <dir>        Target directory (default: current directory)

Options:
  --force      Overwrite a non-empty directory
  --json       Emit a structured JSON summary on stdout

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
  const json = args.includes("--json");
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
            astro: "^5.0.0",
            "@run402/astro": "^1.0.0",
            "@run402/functions": "^2.5.0",
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
//   - AsyncLocalStorage context so db()/getUser()/cache.* work natively
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
import { db, getUser, cache } from "@run402/functions";
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
import { db, getUser, cache } from "@run402/functions";

export const POST: APIRoute = async ({ request }) => {
  const user = await getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

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
  ];

  for (const file of files) {
    const fullPath = resolve(targetDir, file.path);
    mkdirSync(resolve(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, file.content, "utf-8");
  }

  if (json) {
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
  } else {
    console.log(`Scaffolded Astro project at ${targetDir}`);
    console.log("");
    console.log("Files created:");
    for (const f of files) console.log(`  - ${f.path}`);
    console.log("");
    console.log("Next steps:");
    if (positionals[0]) console.log(`  cd ${positionals[0]}`);
    console.log("  npm install");
    console.log("  run402 deploy");
  }
}
