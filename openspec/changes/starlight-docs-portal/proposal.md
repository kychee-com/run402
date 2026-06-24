## Why

`docs.run402.com` already exists as a run402-hosted project (shipped by `agent-docs-self-host`), but it serves only **flat text files for agents** (`llms-cli.txt`, `llms-sdk.txt`, `llms-mcp.txt`, `SKILL.md`). There is no human-readable documentation site for the **developer supervising the agent** — no navigation, search, syntax highlighting, or deep-linkable reference pages.

Two forces make now the moment:

1. **The human-docs gap.** Run402's surface (CLI, SDK, MCP, error codes, the growing `@run402/astro` story) has no navigable, searchable home for the developer behind the agent — only monolithic `.txt` dumps. A structured portal closes that gap, and single-sourcing keeps the agent flat files in lockstep with it.
2. **Dogfood-of-the-dogfood.** `@run402/astro` v1.0 is shipping now. A documentation site built on Astro and deployed to run402 is the canonical, always-current reference implementation of "deploy an Astro site to run402" — the exact thing the docs teach. It stress-tests the toolchain on a real, non-trivial site on every publish.

> **Not a driver (corrected):** an earlier draft justified this by the `astro-ssr-runtime` error envelopes pointing at `docs.run402.com/<topic>#<anchor>`. That is **not** a dependency — that change already shipped its error reference at `run402.com/errors/` (it routed around this site not existing yet). Consolidating those error docs onto this portal is an optional future change, not a reason to build it.

## What Changes

- **Add a static Astro Starlight documentation portal at the root (`/`) of the existing docs project** (`run402-docs`, `prj_1780488560350_0018`, `docs.run402.com`): human-readable HTML with sidebar navigation, client-side search (Pagefind), syntax highlighting, and light/dark theming. Audience: the developer supervising the agent.
- **Single source of truth (the load-bearing decision).** Docs are authored once as Starlight content (`src/content/docs/**`). A build-time generator emits the flat agent files (`llms-cli.txt`, `llms-sdk.txt`, `llms-mcp.txt`, `SKILL.md`) from that same content. One edit updates both the human HTML surface and the agent flat-file surface. This replaces today's hand-authored, drift-prone `.txt` files.
- **The flat files keep serving at their stable paths.** Starlight HTML owns `/` and topic routes; the flat files continue to serve at `/llms-cli.txt`, `/llms-sdk.txt`, `/llms-mcp.txt`, `/SKILL.md` via the manifest's `site.public_paths`. Agents and the apex discovery index depend on those exact URLs.
- **An R402_* error-code reference page** for the supervising developer — an informational mirror. (The error envelopes' canonical `docs` URLs resolve to `run402.com/errors/`, shipped separately by `astro-ssr-runtime`; this page is not their target.)
- **Static (SSG) output, deployed via the existing path.** Plain `astro build` → `dist/` → `spec.site` through the existing `deploy-docs.yml` OIDC workflow, using **explicit** `public_paths` (clean URLs) so unknown paths 404 instead of SPA-falling-back to the home page. No SSR runtime is introduced. (Migrating to `@run402/astro` SSR is a deferred future option, not in scope.)
- **BREAKING (authoring surface):** the three `llms-*.txt` become **generated artifacts** — authors edit Starlight content, not the `.txt` directly. (`SKILL.md` stays authored at the repo root — its agent-skills frontmatter is part of the discovery digest — so single-sourcing it is deferred.)
- Stable flat-file paths are preferred but **link changes are acceptable**; apex/path back-compat redirects are nice-to-have, not mandatory.

## Capabilities

### New Capabilities
- `docs-portal`: the human-facing run402 documentation portal — a static Astro Starlight site served at the root of `docs.run402.com`, with navigable structure, client-side search, and an informational `R402_*` error-code reference (a mirror; the error envelopes' canonical `docs` URLs resolve to `run402.com/errors/`). Covers coexistence with the flat agent files on the same project and static deployment via the existing OIDC CI path.

### Modified Capabilities
- `agent-docs-distribution`: the flat agent docs (`llms-cli.txt`, `llms-sdk.txt`, `llms-mcp.txt`, `SKILL.md`) become **single-sourced** — generated from the portal's canonical content rather than hand-authored. Their canonical serving URLs are unchanged; the generated `SKILL.md` remains byte-stable for the apex discovery-index digest; the apex-served wayfinder and discovery index are unaffected.

## Impact

- **run402-public repo (primary):**
  - New Astro Starlight site (proposed `docs-site/`) with `src/content/docs/**`, `astro.config.mjs`, and `package.json` deps (`astro`, `@astrojs/starlight`, optionally `@run402/astro`).
  - New generator (proposed `scripts/build-agent-flat-docs.mjs`) emitting the four flat files from the Starlight content; wired into the build.
  - `run402.docs.deploy.json` manifest extended: `site` files become the Astro `dist/**`; `public_paths` keep mapping the flat-file URLs to the generated bytes.
  - `.github/workflows/deploy-docs.yml` extended: `astro build` + run generator + deploy; path filters widened to the docs-site sources.
  - `sync.test.ts` digest assertion re-pointed to the **generated** `SKILL.md`; add a generator-determinism test.
  - Content migration: seed `src/content/docs` from the existing flat files **plus** the currently-homeless `docs/reference/astro-ssr-runtime/error-codes.md` (authored in run402-private).
- **run402 platform:** same project `prj_1780488560350_0018`, same managed subdomain `docs.run402.com` — **no new infrastructure, no private-repo gateway change required**. Deploy payload grows from 4 text files to an HTML/asset bundle (well within tier storage).
- **Agents / discovery:** flat-file canonical URLs and the apex `llms.txt` / `index.json` discovery layer are unchanged.
- **run402-private:** none required to ship; the seed reference content (`error-codes.md`) is copied into the public docs source.
