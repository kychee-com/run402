> **Implementation status (v1 spine landed):** the engineering spine is built and
> verified locally — Starlight scaffold builds (7 pages, Pagefind, sitemap), the
> single-source generator round-trips byte-identically, the deploy-manifest
> generator works, and CI is wired (regen-clean gate + docs-build job + deploy
> rewrite). Remaining: finer content authoring, `SKILL.md` single-sourcing, the
> `astro-ssr-runtime` anchor reconciliation, and the live post-merge deploy
> verification (runs in CI on merge to `main`).

## 1. Scaffold the Starlight docs-site

- [x] 1.1 `docs-site/` Astro + `@astrojs/starlight` (`docs-site/package.json`, lockfile committed)
- [x] 1.2 `docs-site/astro.config.mjs`: `output: 'static'`, Starlight (title, social, sidebar), `src/content.config.ts` (extends schema with `order`)
- [x] 1.3 Pagefind search builds in the static `dist/` (verified: 7 HTML files indexed)
- [x] 1.4 Build output + deps gitignored (`docs-site/.gitignore` + root `dist/`/`node_modules/`)

## 2. Seed content (single source) and define bundle structure

- [x] 2.1 Content tree defined: `src/content/docs/{cli,sdk,mcp}` (bundled) + portal-only (`index.mdx`, `getting-started.md`, `reference/`)
- [x] 2.2 Migrated the flat references into Starlight pages via `scripts/seed-docs-content.mjs` _(coarse v1: one `reference.md` per bundle, byte-faithful; finer page-splitting is iterative authoring that does not change the generator)_
- [ ] 2.3 Author `SKILL.md`'s source page — **deferred** (D2: agent-skills frontmatter is digest-bound and conflicts with Starlight's `title` schema; `SKILL.md` stays authored at root)
- [x] 2.4 Seeded `reference/error-codes.md` from run402-private `docs/reference/astro-ssr-runtime/error-codes.md`
- [x] 2.5 Bundle convention (section dir + `order`) documented in `docs-site/README.md` + design D2

## 3. Single-source generator + determinism

- [x] 3.1 `scripts/build-agent-flat-docs.mjs`: walk each bundle, order by `order` then path, strip frontmatter, emit the three flat files to their canonical root paths
- [ ] 3.2 Error loudly on an unsupported Starlight construct inside a bundled page — **not yet** (coarse `.md` seed has no components; add when finer MDX authoring lands)
- [x] 3.3 Normalize output: LF, single trailing newline, no timestamps/build ids
- [x] 3.4 Determinism verified (run twice → unchanged; `--check` idempotent). _Enforced in CI by the `--check` regen-clean gate (task 4.1); a standalone unit test is optional belt-and-suspenders_
- [~] 3.5 `build-agent-skills-index.mjs` / `sync.test.ts` — **no change needed**: `SKILL.md` is out of generator scope, so the discovery digest is unchanged and both pass as-is (verified)

## 4. CI regen-clean gate

- [x] 4.1 `node scripts/build-agent-flat-docs.mjs --check` added to the `test` job AND the deploy preflight (fails on stale committed flat files)
- [~] 4.2 ~~Check that every shipped `R402_*` code has a matching anchor~~ — **dropped** (D7 correction): the envelopes target `run402.com/errors/`, not this portal, so there is no anchor contract to gate here
- [x] 4.3 The three generated flat files remain committed (git-tag `raw.githubusercontent.com` pins resolve)

## 5. Wire the deploy

- [~] 5.1 Flat-file serving — handled by the **manifest generator**, not by copying into `public/` (D3 revision): the generator writes flat files to their canonical root paths; the manifest references them there
- [x] 5.2 `scripts/build-docs-deploy-manifest.mjs`: enumerate `docs-site/dist/**` into `site.replace` + **explicit** `public_paths` (clean URLs) + the four root flat files; `run402.docs.deploy.json` is now a gitignored build artifact
- [x] 5.3 `.github/workflows/deploy-docs.yml`: regen-check → `npm ci` + `astro build` → manifest-gen → `run402 deploy apply` (OIDC); path filters widened to `docs-site/**` + the generator scripts
- [x] 5.4 Post-deploy smoke (`curl` with retry) for `/` (HTML) + the four flat-file paths
- [x] 5.5 `docs-build` CI job (test.yml): builds the portal + manifest on every PR
- [x] 5.6 **Explicit** (not implicit) public paths — implicit + a root `index.html` makes the gateway SPA-fall-back (`release-state.ts` sets `spa_fallback="/index.html"`), serving the home page with HTTP 200 for every unknown URL; explicit clean-URL enumeration yields real 404s

## 6. First deploy + verification — DONE (commit `e5410ed`, verified live)

- [x] 6.1 Deployed to `prj_1780488560350_0018` (provisioning-free; fired on merge via `deploy-docs.yml`, all steps green incl. smoke)
- [x] 6.2 Portal live at `https://docs.run402.com/` (`200 text/html`; nav + Pagefind built)
- [x] 6.3 All four flat files serve at canonical paths with correct content types (`text/plain` / `text/markdown`)
- [x] 6.4 Error-code reference renders (`/reference/error-codes/` → `200`)
- [x] 6.5 Apex discovery digest confirmed **unchanged** — `index.json` digest == live `SKILL.md` sha256
- [ ] 6.6 Redeploy with explicit public paths (5.6) and confirm unknown URLs return `404` (not `200`-home)

## 7. Follow-ups (none blocking)

- [~] 7.1 ~~Reconcile error anchors with `astro-ssr-runtime` before it GAs~~ — **NOT a dependency** (D7 correction): that change already ships its error reference at `run402.com/errors/`. Optional future: consolidate those error docs onto this portal + re-point the in-code `docs:` URLs
- [~] 7.2 Open questions resolved in design: static-deploy via generated manifest (D3), explicit-vs-implicit public paths (D3/5.6), `SKILL.md` deferred (D2/D5), plain-static over `@run402/astro` (D4). Remaining (non-blocking): finer content page-splitting; whether to single-source `SKILL.md` later
