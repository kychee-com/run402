## Context

The current live integration coverage is split across a small SIWX test, a broad CLI lifecycle smoke test, and a smaller MCP handler smoke test. Those tests validate important primitives, but most checks use tiny fixtures: one table, one simple static file, one simple function, and shallow release inspection.

Run402 is a full-stack application platform. A realistic production app exercises several platform resources atomically: static site files, clean routes, serverless functions, database migrations, seeds, runtime helper imports, auth, storage/CDN, email, secrets, AI text helpers, scheduled jobs, subdomains, and release observability. The missing coverage is a Run402 platform gap, not a downstream application testing problem.

## Goals / Non-Goals

**Goals:**

- Add a product-neutral live integration suite that proves Run402 can deploy and operate a representative full-stack application.
- Exercise the unified deploy primitive with site replacement, database migrations, function replacement, route replacement, secrets declarations, and subdomain assignment in one release.
- Verify deployed behavior through headless HTTP/API checks, SDK/CLI calls, and function invocations.
- Cover runtime helpers used by deployed functions: `db(req)`, `adminDb()`, `getUser()`, `email`, and `ai`.
- Cover auth, storage/CDN, secrets, email, AI text helpers, scheduled-function metadata, and release observability at production-api depth.
- Ensure tests create and clean up temporary resources deterministically.

**Non-Goals:**

- Do not test any downstream application's SDK or CLI surface.
- Do not include product UI assertions, visual inspection, layout assertions, or browser-driven editing flows.
- Do not require Playwright, Chrome, or the Codex in-app browser for the core suite.
- Do not make normal unit tests depend on live paid resources.

## Decisions

### Decision: Add a product-neutral fixture app

Create a fixture such as `integration-fixtures/fullstack-app/` that belongs to Run402. The fixture should be intentionally boring: generic pages, generic tables, generic functions, generic route names, and generic test data. It should resemble a serious app in platform shape without carrying product branding or app-specific behavior.

Alternative considered: deploy a real downstream app in the Run402 test suite. Rejected because it couples Run402 platform confidence to another repo's product behavior, release cadence, and vocabulary.

### Decision: Keep the suite live but separate

Add a dedicated script such as `npm run test:integration:fullstack`. It should be explicit that it hits live Run402 APIs, may use payment rails, and creates/deletes temporary resources. Existing smoke suites remain useful and should not be collapsed into the new suite.

Alternative considered: fold all coverage into the existing full CLI integration test. Rejected because that test is already a broad command smoke test; turning it into a full platform fixture would make failures harder to diagnose.

### Decision: Use headless HTTP/API verification, not browser automation

The suite should fetch deployed URLs, static assets, route aliases, discovery files, and function routes directly. It may parse HTML for expected boot config and asset references, but it should not execute client-side JavaScript in a browser or assert visual behavior.

Alternative considered: add Playwright or browser automation to the live integration suite. Rejected for this change because browser correctness belongs to product E2E tests; Run402 needs to prove that bytes, routes, headers, auth, and functions are served correctly.

### Decision: Verify resource behavior through public platform boundaries

The suite should test behavior through the same public surfaces users rely on: SDK/CLI where appropriate, public URLs for static/routes, direct function URLs with expected auth, storage/CDN URLs, email APIs, and deploy release reads/diffs. Internal database checks are useful for setup and validation, but they should not replace public-boundary assertions.

Alternative considered: assert only release plan/inventory shape. Rejected because release metadata can be correct while runtime serving, auth, storage, or helper behavior is broken.

### Decision: Split sticky external-resource checks when needed

Custom domains and sender domains may require pre-provisioned DNS or mailbox state. If they cannot be safely exercised with ephemeral resources, add a gated subgroup with explicit environment prerequisites rather than silently omitting them from the coverage map.

Alternative considered: skip sticky resources entirely. Rejected because that hides gaps. A gated test is better than no declared coverage.

## Risks / Trade-offs

- Live tests may spend testnet funds or consume paid test resources -> keep them in an explicit script, document prerequisites, and make cleanup best-effort with finalizers.
- Cleanup can fail after partial setup -> track created resource IDs immediately and make delete steps idempotent.
- External services can be flaky -> use bounded retries only for known eventual-consistency points such as function cold starts, CDN freshness, and route activation.
- The fixture can become a product by accident -> keep names generic, ban downstream product vocabulary in fixture paths/docs, and test platform behavior rather than product workflows.
- The suite can become too slow for every push -> keep smoke tests in normal CI and run full-stack live coverage manually, nightly, or in a gated workflow with credentials.
