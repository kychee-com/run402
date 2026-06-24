## Why

The `starlight-docs-portal` change shipped a human portal that is **a rendering of the agent reference files** — one short orientation page plus three monolithic references (~2,170 lines CLI, ~2,020 SDK, ~820 MCP). An external documentation review confirmed the core problem and found concrete credibility bugs: dead error-doc links, an Astro README that contradicts itself, retired `getUser()` examples, a title that renders `Run402 Docs | Run402 Docs`, and an atomic-deploy claim stronger than the implementation.

Humans supervising an agent need **guided workflows, mental models, trust boundaries, and verification steps** — not machine contracts. Agents need complete machine contracts. They can share *source* without sharing *presentation*. This change restructures the portal into an **audience-separated documentation product** while keeping the flat `llms-*.txt` files as the machine source of truth, and fixes the P0 credibility bugs.

Three product decisions are settled (from the review discussion):
- **Positioning:** Run402 is a *"full-stack application platform that coding agents can provision, deploy, and operate within a finite spending allowance"* — not "the backend."
- **Error docs consolidate onto `docs.run402.com`** as the canonical home (build the topic pages the envelopes point to; re-point the in-code `docs:` URLs there).
- **Scope:** the full restructure (the review's bucket B).

## What Changes

**Positioning & homepage**
- Rewrite `index.mdx` to the new positioning; title → **Overview** (fixes the `Run402 Docs | Run402 Docs` repetition). Separate three audiences below the hero: developers, coding agents, integrators.

**Information architecture (new sidebar)**
- Replace the 6-item sidebar with: **Start / Concepts / Build / Operate / Reference / Examples** (full tree in `design.md`).

**New concept pages (the human mental models)**
- `/concepts/allowances/` — what an allowance authorizes, prepaid vs on-chain balance, behavior at zero, holds/reservations, replenishment, refunds, revocation, what it does *not* cap. The hard-cap claim stated as an implementation-backed invariant.
- `/concepts/credentials/` — the trust-boundary table (allowance key, operator session, anon_key, service_key, user session, OIDC binding, runtime secrets): held-by / scope / browser-safe / rotation. Key non-expiry ⇒ rotation + compromise-recovery docs are mandatory.
- `/concepts/releases/` — desired state, base, plan/stage/activate, replace vs patch, carry-forward, warnings, conflicts, resume, promotion, why promotion does not undo migrations.
- `/concepts/` overview, projects/orgs/ownership, lifecycle/expiration.

**New guides (Build / Operate)**
- **Prompt-first first-app tutorial** (`/start/first-app/`) — a real prompt, what the agent needs/does/must-not-do, what success looks like, how the human verifies; underlying commands in a collapsed section.
- **Astro SSR section** (`/build/astro/*`) — overview, first app, rendering modes (documenting the **current** server-islands behavior — see below), auth, data access, images, caching/ISR, secrets, deploy/debug, limitations.
- Database & REST, Auth & RLS (three lanes: Astro / hosted-routes / bearer-JWT), Storage, Functions & routes, Email, Domains.
- **Operate:** deploy/inspect/promote, logs & diagnostics, GitHub OIDC, billing & resource limits.

**Reference (keep machine-complete, make human-navigable)**
- Split `cli/reference.md`, `sdk/reference.md`, `mcp/reference.md` into ordered sub-pages **using the existing generator** (the flat files stay byte-complete). Remove the duplicate body-level H1s. Separate **platform-operator** commands from the developer command flow.
- **Render OpenAPI + JSON Schemas** (Scalar/Redoc) at `/reference/http/`; generated ReleaseSpec + exposure-manifest reference pages.
- Tighten the **atomic-deploy** claim with the staged/resumable guarantee table.

**Error documentation (consolidated onto `docs.run402.com`)**
- Build the promised topic pages from a **single error registry**: `astro/errors`, `astro/images`, `functions/errors`, `sdk/errors`, `cache/errors`, `cache/concepts`, `deploy/errors` — with the kebab anchors the envelopes use (`#build-failed`, …).
- One `/errors/` landing distinguishing **two families**: control-plane/CLI codes (`PAYMENT_REQUIRED`, `PROJECT_FROZEN`, …; envelope `status:"error"`, `retryable`, `safe_to_retry`) vs application-runtime `R402_*` codes (envelope `ok:false`, `suggestedFix`, `docs`). Do not imply one universal envelope.
- **Cross-repo (run402-private):** re-point the ~13 in-code `docs:` URLs from `run402.com/errors/#R402_*` to `docs.run402.com/<topic>#<anchor>`, and host the canonical registry where the codes are defined.

**Agent-facing layer**
- Corrected skill metadata (lead with the application platform + allowance, not x402 internals).
- Task-specific machine docs (`/agent/{start,astro,deploy,auth,database,storage,errors,allowances}.txt`) + wayfinder routing by task first, interface second. Canonical comprehensive files retained.

**CI quality gates (build-blocking)** — see the new `docs-quality-gates` capability.

**Server islands (honest handling).** Investigation: they are **deliberately hard-failed** in v1 (`ssr-detectors.ts` throws `R402_ASTRO_SERVER_ISLAND_UNSUPPORTED`; `astro-ssr-runtime` defers full support to v1.5+). The README bug is that it *shows a working example*. This change documents the **current truth** (unsupported, deferred) and fixes the contradiction. **Actually supporting server islands is a separate `@run402/astro`/`astro-ssr-runtime` v1.5 feature, out of scope here** (tracked, not delivered by docs).

## Capabilities

### New Capabilities
- `docs-product-structure`: the audience-separated human documentation product — positioning, the Start/Concepts/Build/Operate/Reference/Examples IA, the concept pages (allowances, credentials, releases), the prompt-first tutorial, the Build/Operate guides, and rendered OpenAPI/schema reference.
- `docs-error-registry`: a single source-of-truth error registry that generates the `docs.run402.com/<topic>#<anchor>` pages, splits the two error families (control-plane vs runtime), and is the canonical target of the in-code `docs:` envelope URLs.
- `docs-quality-gates`: the build-blocking CI checks (link/anchor resolution, runtime `docs` URL resolution, example type-checking against current package exports, retired-export bans, peer-range equality, error-code registry↔source parity, page-size thresholds, automated status reporting).

### Modified Capabilities
- `agent-docs-distribution`: add task-specific machine docs + wayfinder task-routing; correct the skill metadata; (single-sourcing of the split references continues unchanged).

> The presentation changes to the live portal (new sidebar, audience-separated homepage, split reference monoliths, duplicate-H1 removal, platform-operator separation) are captured as ADDED requirements under the new `docs-product-structure` capability rather than as a delta on `docs-portal` — the `starlight-docs-portal` change that introduced `docs-portal` is deployed but **not yet archived**, so there is no archived base to delta against.

## Impact

- **run402-public `docs-site/`:** large authoring effort (~20+ new pages); the flat-doc generator extended for the reference splits + agent task-docs; an error-registry → page generator; OpenAPI/Scalar render integration; new sidebar/config.
- **CI:** the `docs-quality-gates` checks added to `test.yml` / a docs workflow (build-blocking).
- **Cross-repo (run402-private), tracked as external dependencies — NOT delivered here:** re-point the in-code `docs:` URLs to `docs.run402.com`; decide where the canonical error registry lives; the **server-islands v1.5 feature** + the `@run402/astro` README contradictions / retired-`getUser` examples / Astro peer-range fixes (these live in `@run402/astro` + `astro-ssr-runtime`).
- **Coordination:** with `astro-ssr-runtime` (error-URL consolidation + server-islands truth) and whoever is concurrently editing `docs-site/`.
- **Sequencing:** multi-phase (see `tasks.md`, ordered per the review). P0 credibility fixes land first; the structural rebuild follows.
- **No backward-compat constraint** on portal URLs (pre-launch); the flat-file canonical URLs + the discovery digest stay stable.
