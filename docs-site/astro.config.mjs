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
        "Documentation for Run402 — Postgres, REST, auth, content-addressed storage, serverless functions, email and atomic deploys an AI agent can provision and pay for on its own.",
      social: [
        { icon: "external", label: "Run402 homepage", href: "https://run402.com/" },
        { icon: "github", label: "GitHub", href: "https://github.com/kychee-com/run402" },
      ],
      // Agents fetch the flat llms-*.txt; humans navigate here.
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Your first deploy", slug: "start/first-deploy" },
            { label: "Getting started", slug: "getting-started" },
          ],
        },
        {
          label: "References (rendered from the agent docs)",
          items: [
            {
              label: "CLI",
              // One entry per slice of llms-cli.txt (agent-docs-slices): the
              // index page is the first-deploy contract, the rest are the
              // fetchable llms-cli-<slice>.txt files.
              items: [
                { label: "Index (start here)", slug: "cli/reference" },
                { label: "Deploying apps", slug: "cli/deploy" },
                { label: "Core commands", slug: "cli/commands" },
                { label: "Repos", slug: "cli/repos" },
                { label: "Orgs, events, rooms", slug: "cli/orgs" },
                { label: "Functions, secrets, jobs", slug: "cli/functions" },
                { label: "Assets, sites, email, AI", slug: "cli/assets" },
                { label: "Auth, billing, operator, doctor", slug: "cli/ops" },
                { label: "R402_* error codes", slug: "cli/errors" },
                { label: "REST + user auth for frontends", slug: "cli/frontend" },
                { label: "Ideas, pricing, Core, Buzz", slug: "cli/platform" },
              ],
            },
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
