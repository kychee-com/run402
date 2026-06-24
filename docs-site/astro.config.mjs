// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// Static (SSG) docs portal — no @run402/astro SSR adapter (Fork 1). The whole
// dist/** is shipped to the existing run402 docs project by the deploy workflow;
// the flat agent files (llms-*.txt, SKILL.md) are served from the repo root via
// the generated manifest's public_paths (scripts/build-docs-deploy-manifest.mjs).
export default defineConfig({
  site: "https://docs.run402.com",
  integrations: [
    starlight({
      title: "Run402 Docs",
      description:
        "Documentation for Run402 — Postgres, REST, auth, content-addressed storage, serverless functions, email and atomic deploys an AI agent can provision and pay for on its own.",
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/kychee-com/run402" },
      ],
      // Agents fetch the flat llms-*.txt; humans navigate here.
      sidebar: [
        {
          label: "Start here",
          items: [{ label: "Getting started", slug: "getting-started" }],
        },
        {
          label: "References (rendered from the agent docs)",
          items: [
            { label: "CLI", slug: "cli/reference" },
            { label: "SDK", slug: "sdk/reference" },
            { label: "MCP", slug: "mcp/reference" },
          ],
        },
        {
          label: "Reference",
          items: [{ label: "Error codes (R402_*)", slug: "reference/error-codes" }],
        },
      ],
      editLink: {
        baseUrl: "https://github.com/kychee-com/run402/edit/main/docs-site/",
      },
    }),
  ],
});
