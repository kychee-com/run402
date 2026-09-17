// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import sitemap from "@astrojs/sitemap";

// Static (SSG) docs portal — no @run402/astro SSR adapter (Fork 1). The whole
// dist/** is shipped to the existing run402 docs project by the deploy workflow;
// the flat agent files (llms-*.txt, SKILL.md) are served from the repo root via
// the generated manifest's public_paths (scripts/build-docs-deploy-manifest.mjs).
export default defineConfig({
  site: "https://docs.run402.com",
  integrations: [
    sitemap(),
    starlight({
      title: "Run402 Docs",
      description:
        "Documentation for Run402 — Postgres, REST, auth, content-addressed storage, serverless functions, email and staged releases, operated through a machine-friendly CLI.",
      social: [
        { icon: "external", label: "Run402 homepage", href: "https://run402.com/" },
        { icon: "github", label: "GitHub", href: "https://github.com/kychee-com/run402" },
      ],
      // Agents fetch the flat llms-*.txt; humans navigate here.
      sidebar: [
        { label: "Start", items: [
          { label: "Overview", slug: "getting-started" },
          { label: "Your first deploy", slug: "start/first-deploy" },
          { label: "Agent setup", slug: "start/harness" },
        ] },
        { label: "Concepts", items: [{ autogenerate: { directory: "concepts" } }] },
        { label: "Build", items: [{ autogenerate: { directory: "build" } }] },
        { label: "Operate", items: [{ autogenerate: { directory: "operate" } }] },
        { label: "Reference", items: [
          { label: "CLI", items: [{ autogenerate: { directory: "cli" } }] },
          { label: "SDK", items: [{ autogenerate: { directory: "sdk" } }] },
          { label: "MCP", items: [{ autogenerate: { directory: "mcp" } }] },
          { label: "HTTP API", slug: "reference/http" },
          { label: "Release schemas", slug: "reference/schemas" },
          { label: "Errors", slug: "errors" },
        ] },
        { label: "Examples", items: [{ autogenerate: { directory: "examples" } }] },
      ],
      editLink: {
        baseUrl: "https://github.com/kychee-com/run402/edit/main/docs-site/",
      },
    }),
  ],
});
