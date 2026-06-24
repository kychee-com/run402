## Context

`starlight-docs-portal` is live at `docs.run402.com` (static Astro Starlight; flat `llms-*.txt` single-sourced from `docs-site/src/content/docs/{cli,sdk,mcp}/**`; explicit public paths; deployed via OIDC). Its homepage states humans get "the same material" as agents — which produced one orientation page + three reference monoliths. This change keeps the machine source-of-truth model but rebuilds the *human presentation* around the supervising developer, and consolidates error docs here. `docs-site/` is being edited concurrently by other agents, so all work happens in a worktree and rebases on `origin/main`.

## Goals / Non-Goals

**Goals:**
- A human can learn: what authority they grant an agent, what the agent will do, how to verify the result, how to recover on failure.
- Keep the flat agent files byte-complete and single-sourced; extend (not replace) the generator.
- Fix the P0 credibility bugs (dead links, title repetition, duplicate H1s, atomic-deploy overclaim, two-error-systems conflation) before adding traffic.
- `docs.run402.com` becomes the canonical error-doc home.

**Non-Goals:**
- Building server-islands support (a v1.5 `@run402/astro` feature — documented as unsupported here).
- Fixing `@run402/astro` README/peer-range/`getUser` contradictions in *this* repo's docs change (they live in the package source — routed).
- Migrating to `@run402/astro` SSR for the docs site itself (it stays static).
- Changing flat-file canonical URLs or the discovery digest.

## Decisions

### D1 — Audience-separated IA; new sidebar

```
Start      → Overview · Build your first app · Choose a coding harness
Concepts   → How Run402 works · Allowances & spending limits · Projects/orgs/ownership ·
             Credentials & trust boundaries · Releases & atomic activation · Lifecycle & expiration
Build      → Astro SSR · Database & REST · Authentication & RLS · Storage & assets ·
             Functions & routes · Email · Domains
Operate    → Deploy/inspect/promote · Logs & diagnostics · GitHub Actions OIDC · Billing & limits
Reference  → CLI · SDK · MCP · HTTP API · ReleaseSpec · Exposure manifest · Error codes · Compatibility
Examples   → Multi-user Astro app · CMS with ISR · Cloudflare Worker w/ Run402 backend
```
The homepage routes the three audiences (developers → tutorials/trust model; agents → `llms.txt`/`SKILL.md`/task docs; integrators → SDK/CLI/MCP/HTTP/OpenAPI/schemas).

### D2 — Split the reference monoliths via the EXISTING generator (no new mechanism)

`build-agent-flat-docs.mjs` already concatenates ordered pages under a bundle dir into one flat file. So splitting is **pure content reorganization**: replace `cli/reference.md` with `cli/00-overview.md … cli/90-command-index.md` (frontmatter `order`), and the generator re-emits a byte-equivalent `llms-cli.txt` (modulo intentional cleanups). The duplicate body H1 (`# Run402 CLI -- Agent Reference` under frontmatter `title:`) is dropped from the rendered pages; if the flat file must retain a top H1, the generator prepends one per bundle so the human pages stay clean without changing flat output. Platform-operator commands move to a clearly-separated page. **A regen-clean gate already guards byte-drift** — the split must keep the flat files stable (or the diff is reviewed intentionally).

### D3 — Error docs: one registry → generated topic pages, two families, consolidated here

A single `ErrorDoc[]` registry (`{ code, family, category, summary, suggestedFix, topic, anchor, since? }`) generates both the per-topic pages (`astro/errors`, `astro/images`, `functions/errors`, `sdk/errors`, `cache/errors`, `cache/concepts`, `deploy/errors`) and the `/errors/` landing. The landing splits **two families with different envelopes**: control-plane/CLI (`status:"error"`, `retryable`, `safe_to_retry`, `mutation_state`) vs runtime `R402_*` (`ok:false`, `suggestedFix`, `docs`). Anchors match the envelopes' published slugs verbatim.
- **Canonical-home flip (cross-repo):** the in-code `docs:` URLs in `astro-ssr-runtime` (run402-private `packages/astro` + gateway) move from `run402.com/errors/#R402_*` to `docs.run402.com/<topic>#<anchor>`. The registry is authored where the codes are defined (run402-private) and consumed by this portal; the exact sharing mechanism (published JSON vs vendored copy + parity test) is an open question.
- A **CI parity gate** (D5) asserts: every source `R402_*`/control-plane code is in the registry; every registry code exists in source; every emitted `docs` URL resolves to a real route + anchor; no two codes claim the same anchor.

### D4 — Render OpenAPI + JSON Schemas

The repo already ships `openapi.json` + `schemas/*.json`. Add Scalar (or Redoc) at `/reference/http/` (a static embed or an Astro page importing the spec), plus generated reference pages for `ReleaseSpec` (`release-spec.v1.json`) and the exposure manifest, with per-property anchors so schema-validation errors can deep-link. Build-time only; no runtime cost.

### D5 — Build-blocking quality gates (`docs-quality-gates`)

Added to CI (a docs job): (1) every internal link + anchor resolves against the built site; (2) every emitted runtime `docs` URL resolves; (3) every TS/Astro fenced example type-checks against the *current* published package exports; (4) examples cannot use retired exports (e.g. bare `getUser`); (5) documented peer ranges == package `peerDependencies`; (6) error-registry ↔ source parity (both directions); (7) no reference page exceeds a heading/size threshold; (8) flat-doc regen-clean (existing); (9) the docs "status" is an automated result + audited commit SHA/date, never a manual green check. Gates fail the PR.

### D6 — Server islands: document the truth, route the feature

The `R402_ASTRO_SERVER_ISLAND_UNSUPPORTED` hard-fail is intentional (v1, deferred v1.5). This change makes the Astro "rendering modes" page state plainly that server islands are not yet supported and removes the contradictory "working example." A separate `@run402/astro` change implements them (handle Astro's server-island endpoint in the SSR Lambda catchall, retire the detector) — referenced here, not done here.

### D7 — Single-source extends to agent task-docs

The `/agent/*.txt` task slices are generated from the same content (tagged sections / curated subsets), not hand-authored — same discipline as the flat files, so they never drift from the canonical references.

## Risks / Trade-offs

- **Concurrent `docs-site/` edits** → worktree off `origin/main`, rebase before each push; coordinate via small, frequently-merged slices rather than one giant PR.
- **Cross-repo error consolidation** → the registry-sharing mechanism (run402-private ↔ portal) is unresolved; until the envelope URLs are re-pointed, `docs.run402.com/<topic>` and `run402.com/errors/` must both resolve (no dead links during the transition).
- **Scope is large/multi-session** → tasks are phased by the review's execution order; P0 credibility fixes ship first and independently.
- **Reference-split byte-drift** → the regen-clean gate catches it; intentional flat-file cleanups are reviewed diffs.
- **Over-claiming guarantees** → allowance hard-cap and atomic-deploy claims are published only as the implementation actually guarantees (invariant + staged table), verified against gateway behavior.

## Open Questions

- Where does the canonical **error registry** live, and how is it shared run-public ↔ run-private (published JSON artifact, or vendored copy + parity test)?
- Scalar vs Redoc for OpenAPI rendering (bundle size, theming, anchor stability).
- Do we keep `run402.com/errors/` as a redirect to `docs.run402.com` after the flip, or retire it?
- Server-islands feature: schedule it now as its own change, or leave as a tracked v1.5 deferral?
