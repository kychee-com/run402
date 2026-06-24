## Context

`docs.run402.com` is a live run402-hosted static project (`run402-docs` = `prj_1780488560350_0018`, default wallet, Team org), deployed from this repo by `.github/workflows/deploy-docs.yml`:

```
push (main, path-filtered) → npx run402 deploy apply --project prj_... < run402.docs.deploy.json → spec.site → docs.run402.com
```

Today the manifest (`run402.docs.deploy.json`) ships four hand-authored flat files via `site.public_paths`: `cli/llms-cli.txt → /llms-cli.txt`, `sdk/llms-sdk.txt → /llms-sdk.txt`, `llms-mcp.txt → /llms-mcp.txt`, `SKILL.md → /SKILL.md`. Content types are correct out of the box (`.txt → text/plain`, `.md → text/markdown`, `.html → text/html` — verified by the predecessor's D5). The apex `run402.com` keeps the discovery layer (`llms.txt` wayfinder + `/.well-known/agent-skills/index.json`), and the apex serves a **verbatim copy** of this repo's committed `index.json`, whose `digest` is `sha256(SKILL.md)`.

Constraints carried into this change:
- The four flat-file canonical URLs (`docs.run402.com/<doc>`) and their bytes are a contract agents depend on.
- The committed `index.json` digest MUST equal the `sha256` of the `SKILL.md` served at `docs.run402.com/SKILL.md`; `sync.test.ts` enforces this in CI.
- `raw.githubusercontent.com/kychee-com/run402/v<tag>/<path>` is the immutable-pin mechanism (git tags), so the moved/generated files must still exist at stable repo paths.

## Goals / Non-Goals

**Goals:**
- A navigable, searchable, human-readable docs portal at the root of `docs.run402.com`, for the developer supervising the agent.
- **One source of truth:** author once (Starlight content); the flat agent files are generated from it, never drifting.
- Per-error-code anchor pages that satisfy the `docs.run402.com/<topic>#<anchor>` URL contract `astro-ssr-runtime` is shipping.
- Reuse the existing static `spec.site` + OIDC deploy path and the existing project — no new infra, no private-repo change.
- The generated `SKILL.md` is byte-deterministic so the discovery digest stays green.

**Non-Goals:**
- SSR / `@run402/astro` server runtime (deferred; static only — Fork 1).
- Moving the apex discovery layer (`llms.txt`, `index.json`) onto the platform — it stays apex (predecessor's invariant).
- Per-version immutable docs URLs (git tags already cover this — predecessor's D3).
- Mandatory back-compat redirects for path changes (nice-to-have — Fork 3).
- Hosting `run402.com` itself on run402.

## Decisions

### D1 — Starlight content is canonical; flat files are generated from it

`src/content/docs/**` (MDX/Markdown authored for Starlight) is the single source. A build-time generator (`scripts/build-agent-flat-docs.mjs`) walks defined content **bundles** and emits each flat file. Direction is content → flat, never the reverse.

- **Alternative (flat canonical, Starlight generated):** rejected — the flat files are monolithic dumps; splitting them into a navigable, anchored page tree is lossy and would have to be redone by hand on every edit. Authoring structure belongs in the structured source.
- **Alternative (dual-author + drift test):** rejected by Fork 2 — the user explicitly chose single source; a drift test only *detects* divergence, it doesn't prevent the double-edit burden.

### D2 — Bundle mapping (content section → flat file)

| Content section | Generates | Served at |
|---|---|---|
| `docs-site/src/content/docs/cli/**` | `cli/llms-cli.txt` | `/llms-cli.txt` |
| `docs-site/src/content/docs/sdk/**` | `sdk/llms-sdk.txt` | `/llms-sdk.txt` |
| `docs-site/src/content/docs/mcp/**` | `llms-mcp.txt` | `/llms-mcp.txt` |

**`SKILL.md` is intentionally out of generator scope** (decided during implementation). Its agent-skills YAML frontmatter (`name`/`description`) is part of the discovery digest and conflicts with Starlight's `title`-required content schema. It stays authored at the repo root; single-sourcing it is a deferred follow-up. The generated flat files are written back to their **canonical repo-root paths** (`cli/llms-cli.txt`, etc.) so `raw.githubusercontent.com` git-tag pins keep resolving — not into `docs-site/public/`.

Human-only pages (getting-started, the error-code reference, conceptual docs) live elsewhere in `docs-site/src/content/docs/**` and are **portal-only** — they participate in nav/search but feed no flat file. A page joins a bundle by living under its section dir; ordering within a bundle is the frontmatter `order` field.

### D3 — Static-directory deploy via a generated manifest (the `--dir` flag is adapter-only)

Implementation discovery: the CLI's `run402 deploy apply --dir <build>` is **Astro-SSR-adapter only** — `mergeAstroReleaseSlice` imports `@run402/astro/release-slice`, requires `@run402/astro`, and reads `dist/run402/adapter.json`. A **plain static** Starlight `dist/**` (Fork 1) has no adapter manifest, and the CLI's site spec is otherwise per-file. So a build step (`scripts/build-docs-deploy-manifest.mjs`) walks `docs-site/dist/**` and enumerates every file into `site.replace` as a `{ path }` ref, declares `public_paths: { mode: "implicit" }` (filename-derived URLs: `dist/getting-started/index.html` → `/getting-started/`), and adds the four flat files from their canonical repo-root paths (so they serve at `/llms-*.txt` + `/SKILL.md`). The result is fed to the **same** `run402 deploy apply --project … < run402.docs.deploy.json` OIDC invocation the docs project already uses — no SSR runtime, no new auth path. The manifest is a build artifact (gitignored), regenerated each deploy. `.txt`/`.md`/`.html` MIME is correct by extension (predecessor D5); a post-deploy `curl` smoke check guards regression. Starlight's HTML routes (`/`, `/cli/reference/`, …) never collide with the flat-file paths.

### D4 — Plain static Starlight for v1; `@run402/astro` SSR/image is additive-later

The docs-site is plain Astro + `@astrojs/starlight` with `output: 'static'`. It is **not** wired through `@run402/astro` (whose v1.0 default is `output: 'server'` — adopting it naively would force SSR we don't want). The dogfood claim ("an Astro site deployed to run402") holds with the static build alone. The `@run402/astro` *image* integration (`run402Image()` named export, build-time only) is a clean additive follow-up if/when the docs need the run402 image-variant pipeline.

- **Native-dep note:** Starlight pulls Pagefind (wasm — fine) and may pull `sharp` (native) for image optimization. These run at **build time in CI**; only `dist/**` (static assets) ships, so the SSR-runtime native-dep hard-fail does not apply here. Keep image optimization minimal/off in v1 to keep builds simple.

### D5 — Generated flat files are committed; a CI "regen-clean" gate prevents drift

The generator's output (the three `llms-*.txt`) is **committed to git** — required because `raw.githubusercontent.com/.../v<tag>/<path>` pins must resolve and the existing `sync.test.ts` reads the flat files. Authoring flow: edit `docs-site/src/content/docs` → run `node scripts/build-agent-flat-docs.mjs` → it overwrites the three committed files → commit. CI runs `build-agent-flat-docs.mjs --check` (in both the `test` job and the deploy preflight) and **fails if the working tree differs** ("you edited content but didn't regenerate"). Because `SKILL.md` is out of generator scope (D2), the discovery digest is untouched: `scripts/build-agent-skills-index.mjs` and `sync.test.ts` keep asserting `index.digest === sha256(SKILL.md)` against the authored file, unchanged by this change. The round-trip was verified at implementation time: seeding the content tree from the current flat files then regenerating produced byte-identical `cli/llms-cli.txt`, `sdk/llms-sdk.txt`, and `llms-mcp.txt`.

### D6 — Determinism is a hard requirement on the generator

Identical content MUST yield byte-identical flat files (else the digest flaps and CI is non-deterministic). The generator: orders pages by explicit frontmatter `order` then path (never filesystem order); strips frontmatter and unsupported Starlight components; normalizes to `\n` line endings with a single trailing newline; injects no timestamps, build IDs, or hashes. A unit test runs the generator twice and asserts identical output; the regen-clean CI gate (D5) is the integration backstop.

### D7 — Error-reference anchors are coordinated with `astro-ssr-runtime`

Implementation discovery: the real envelope `docs` URLs are `https://docs.run402.com/<topic>/<page>#<anchor>` with **kebab anchors**, not verbatim codes — e.g. `astro/errors#build-failed`, `astro/images#dynamic-cms-images`, `functions/errors#snapstart-init-io`, `sdk/errors#outside-request-context`, `cache/errors#unsupported-vary`, `cache/concepts#auth-taint`, `deploy/errors#stage-failed`. v1 seeds a single consolidated, browsable `reference/error-codes` page (faithfully copied from run402-private `error-codes.md`). The canonical code list and the exact per-topic page split + anchor slugs are owned by the in-flight `astro-ssr-runtime` change; reconciling the topic pages (`astro/errors`, `functions/errors`, `cache/errors`, …) so each envelope URL resolves is the cross-change task, completed before `astro-ssr-runtime` GAs.

## Risks / Trade-offs

- **MDX-to-flat fidelity** (Starlight components/asides don't linearize cleanly) → the generator allowlists a portable-markdown subset for bundled pages and **errors loudly** on an unsupported construct in a single-sourced section, rather than emitting garbage. Portal-only pages may use the full Starlight feature set.
- **Forgot-to-regenerate / digest drift** → D5 regen-clean gate + D6 determinism test; `sync.test.ts` digest assertion is the final guard.
- **Path/route collision between HTML and flat files** → D3 keeps them in disjoint namespaces; post-deploy `curl -I` smoke check on all four flat paths + `/`.
- **Anchor contract divergence with `astro-ssr-runtime`** → D7 pins anchor IDs to envelope codes verbatim; add a check that every shipped `R402_*` code has a matching anchor before that change GAs.
- **Deploy payload grows** (4 text files → full HTML/asset bundle) → static docs are small; well within tier storage; no SSR cost.
- **OIDC binding still tied to one wallet** (inherited) → unchanged from predecessor; documented owning wallet + `run402 ci revoke`/re-link recovery.

## Migration Plan

1. **Scaffold** the `docs-site/` Starlight project; seed `src/content/docs` from the existing four flat files (split into pages) + `error-codes.md`. No deploy change yet.
2. **Build the generator + tests:** `build-agent-flat-docs.mjs`, the determinism unit test, the regen-clean CI gate; re-point `sync.test.ts` to the generated `SKILL.md`; verify `index.json` digest matches.
3. **Extend deploy:** `run402.docs.deploy.json` ships `dist/**` (+ `public_paths` for the four flat files); `deploy-docs.yml` runs generator → `astro build` → `deploy apply`; widen path filters to `docs-site/**`.
4. **First deploy** to `prj_1780488560350_0018`; verify the portal at `/`, all four flat-file paths, content-types (`curl -I`), and Pagefind search.
5. **Coordinate anchors** with `astro-ssr-runtime` so envelope `docs` URLs resolve.
6. Apex `llms.txt` + `index.json` stay as-is (verbatim copy of the committed, now-generated-digest index).

**Rollback:** revert the deploy PR; the project keeps serving its previous release (flat-file URLs and bytes unchanged for agents); the portal simply isn't added. No data migration to undo.

## Open Questions

- **SKILL.md committed-but-generated** (D5 lean) vs fully generated + gitignored — does any external consumer rely on `raw.githubusercontent.com/.../SKILL.md` on a branch other than a release tag? If not, committed-generated is safe.
- **Adopt `@run402/astro` image integration in v1** for the dogfood, or defer (D4 lean: defer)?
- **Exact page split** of today's monolithic flat files into the Starlight page tree, and which pages are portal-only vs bundled.
- **Canonical `R402_*` code source** for the regen check — read from the `astro-ssr-runtime` error-code reference, or a shared JSON manifest both changes import?
- **Search scope** — Starlight default Pagefind indexes portal HTML only; confirm that's the desired search surface (agents use the flat files, not search).
