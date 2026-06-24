> Phased per the review's execution order. **Phase 1 (P0 credibility) ships first and independently.** Cross-repo / routed items are marked `[C]` — they are tracked dependencies, not delivered by editing `docs-site/`. All work happens in a worktree off `origin/main` (concurrent agents are editing `docs-site/`); rebase before each push; prefer small frequently-merged slices over one giant PR.

## 1. P0 credibility fixes (ship first)

- [x] 1.1 Stripped the 17 dead `**Docs:**` `docs.run402.com/<topic>#...` links from `reference/error-codes.md` (the per-code 404 promises; the 2 remaining refs are the scheme-description placeholder, not links). Real topic pages land in Phase 7.
- [x] 1.2 Homepage title → `Overview` (renders `Overview | Run402 Docs`, repetition gone)
- [x] 1.3 Removed the duplicate body **title** H1 from cli/sdk/mcp pages via a generator `flatHeader` (the agent-file H1 is now generator-owned; flat files verified **byte-identical**, regen-clean passes). _Note: the cli/sdk pages still render a few stray `<h1>` from raw HTML inside agent **code/JSON examples** (`"data":"<h1>v2</h1>"`); that is the "agent text rendered literally" artifact — fixed properly in **Phase 5** (restructure/fence the references), not a Phase 1 quick fix._
- [x] 1.4 Tightened the atomic-deploy claim (getting-started) to the staged/resumable formulation + the guarantee table
- [~] 1.5 `[C]` `@run402/astro` contradictions **spawned as a separate run402-private task** (`task_6e170f55`): retired `getUser`→`auth.user()`, false server-islands example removed (they're deliberately deferred v1.5), Astro peer-range = actual `peerDependencies`, migration history → changelog

## 2. Positioning + homepage + first-app tutorial

- [ ] 2.1 Rewrite `index.mdx`: new positioning hero, `template: splash`, audience split (developers / agents / integrators)
- [ ] 2.2 `/start/first-app/` — prompt-first tutorial: the prompt, what the agent needs/does/must-not-do, success criteria, human verification checklist; commands in a collapsed section
- [ ] 2.3 `/start/choose-a-coding-harness/` — tool-using harnesses with shell access

## 3. Concept pages (human mental models)

- [ ] 3.1 `/concepts/allowances/` — authorization, prepaid vs on-chain, behavior at zero, holds/reservations, replenishment, refunds, revocation, audit, what is NOT capped; hard-cap invariant stated only as implemented
- [ ] 3.2 `/concepts/credentials/` — trust-boundary table (allowance key, operator session, anon_key, service_key, user session, OIDC binding, runtime secrets) + rotation/compromise-recovery (keys don't expire ⇒ mandatory)
- [ ] 3.3 `/concepts/releases/` — desired state, base, plan/stage/activate, replace vs patch, carry-forward, warnings, conflicts, resume, promotion, why promotion ≠ migration rollback
- [ ] 3.4 `/concepts/` overview + projects/orgs/ownership + lifecycle/expiration

## 4. Build / Operate guides

- [ ] 4.1 `/build/astro/*` — overview, first-astro-app, rendering-modes (**document current server-islands = unsupported/deferred**), authentication, data-access, images, caching-and-isr, environment-and-secrets, deploy-and-debug, limitations
- [ ] 4.2 `/build/auth-and-rls/` — three lanes (Astro hosted components / non-Astro hosted routes / bearer-JWT) + data-access matrices
- [ ] 4.3 `/build/` database & REST, storage & assets, functions & routes, email, domains
- [ ] 4.4 `/operate/` deploy-inspect-promote, logs & diagnostics (by request id), GitHub OIDC, billing & resource limits
- [ ] 4.5 `/reference/release-spec/` — render `release-spec.v1.json` + one canonical complete example

## 5. Split the reference monoliths

- [ ] 5.1 Split `cli/reference.md` → `cli/00-overview … 90-command-index` (frontmatter `order`); generator re-emits byte-stable `llms-cli.txt`
- [ ] 5.2 Same for `sdk/reference.md` and `mcp/reference.md`
- [ ] 5.3 Move platform-operator/admin commands to a separated "Platform operators" page
- [ ] 5.4 New sidebar: `Start / Concepts / Build / Operate / Reference / Examples`

## 6. Render OpenAPI + schemas

- [ ] 6.1 `/reference/http/` — Scalar (or Redoc) rendering `openapi.json` with per-operation anchors
- [ ] 6.2 Generated ReleaseSpec + exposure-manifest reference pages with per-property anchors + deep-linkable validation errors

## 7. Error registry + consolidate onto docs.run402.com

- [ ] 7.1 Author the single error registry (`ErrorDoc[]`: code, family, category, summary, suggestedFix, topic, anchor, since) — canonical where the codes are defined
- [ ] 7.2 Generate the topic pages (`astro/errors`, `astro/images`, `functions/errors`, `sdk/errors`, `cache/errors`, `cache/concepts`, `deploy/errors`) with envelope-matching kebab anchors
- [ ] 7.3 `/errors/` landing splitting the two families (control-plane `status:"error"` vs runtime `ok:false`) with their distinct envelope shapes
- [ ] 7.4 `[C]` Re-point the ~13 in-code `docs:` URLs (run402-private `packages/astro` + gateway) from `run402.com/errors/#R402_*` → `docs.run402.com/<topic>#<anchor>`; decide the registry-sharing mechanism (published JSON vs vendored + parity test); keep both hosts resolving during transition
- [ ] 7.5 `[C]` Decide whether `run402.com/errors/` becomes a redirect to `docs.run402.com` or is retired

## 8. CI quality gates (build-blocking)

- [ ] 8.1 Internal link + anchor resolution check (fails on any dead link/anchor)
- [ ] 8.2 Runtime `docs` URL resolution check (every emitted code URL resolves to page+anchor)
- [ ] 8.3 Example type-check against current published package exports + retired-export ban (bare `getUser`, etc.)
- [ ] 8.4 Documented peer-range == package `peerDependencies`
- [ ] 8.5 Error-registry ↔ source parity (both directions) + no duplicate anchors
- [ ] 8.6 Page heading/size threshold gate
- [ ] 8.7 Automated docs status (audited commit SHA + date), replacing manual "green" marks

## 9. Agent-facing layer

- [ ] 9.1 Correct `SKILL.md` discovery `description` (product + allowance first; payment rails in the payment section); confirm discovery digest still matches
- [ ] 9.2 Generate task-specific `/agent/{start,astro,deploy,auth,database,storage,errors,allowances}.txt` from the single source
- [ ] 9.3 Rewrite the apex `llms.txt` wayfinder to route by task first, interface second

## 10. Examples + acquisition

- [ ] 10.1 `/examples/` — multi-user Astro app, CMS with ISR, Cloudflare Worker w/ Run402 backend
- [ ] 10.2 Integration + migration guides (for teams adopting Run402)

## 11. Routed feature (not this change)

- [ ] 11.1 `[C]` Server-islands **support** — a separate `@run402/astro` / `astro-ssr-runtime` v1.5 change (handle Astro's server-island endpoint in the SSR catchall; retire `detectServerIslands`). Docs here only state the current (unsupported) truth.
