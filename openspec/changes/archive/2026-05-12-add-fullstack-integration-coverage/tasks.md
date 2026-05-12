## 1. Fixture And Harness

- [x] 1.1 Create a product-neutral `integration-fixtures/fullstack-app/` fixture directory with static files, function sources, migration SQL, seed SQL, and fixture metadata.
- [x] 1.2 Add a live test harness that creates an isolated config directory, loads the approved buyer allowance, provisions a temporary project, and records every created resource for cleanup.
- [x] 1.3 Add early prerequisite checks for network access, payment credentials, live API base, optional email recipient, optional sticky-resource configuration, and required package builds.
- [x] 1.4 Add `npm run test:integration:fullstack` to run the new live suite explicitly.
- [x] 1.5 Ensure the fixture and test names use generic Run402 terminology and do not depend on any downstream application repository or package.

## 2. Representative Deploy Coverage

- [x] 2.1 Build a unified deploy spec containing database migrations, seeded data, static site replacement, function replacement, route replacement, subdomain assignment, and at least one secret declaration.
- [x] 2.2 Add a missing-required-secret plan/apply check that asserts the warning or validation failure, then sets the secret and successfully deploys.
- [x] 2.3 Deploy multiple static pages, CSS or JavaScript assets, runtime config bytes, and discovery-style JSON or text files.
- [x] 2.4 Deploy multiple functions, including one public routed function, one protected direct function, and one scheduled function.
- [x] 2.5 Deploy static route aliases and method-specific function routes through `routes.replace`.
- [x] 2.6 Assert deploy success returns release id, operation id, and public URLs.

## 3. Database And Hosted HTTP Checks

- [x] 3.1 Verify the fixture migration creates multiple related tables plus at least one index or trigger-backed behavior where supported.
- [x] 3.2 Verify seeded rows with SQL or REST reads after deploy.
- [x] 3.3 Verify at least one relational query across seeded tables returns expected data.
- [x] 3.4 Reapply the unchanged migration/seed shape and assert idempotent behavior.
- [x] 3.5 Fetch multiple deployed HTML pages and assets through public URLs and assert expected markers.
- [x] 3.6 Fetch runtime config and discovery-style files through public URLs and assert expected content.
- [x] 3.7 Verify a clean static route alias serves the intended static target and deploy diagnostics report that it would serve.
- [x] 3.8 Verify method-specific function route behavior does not fall through to unrelated static content for unsupported methods.

## 4. Runtime Helper And Auth Coverage

- [x] 4.1 Invoke a fixture function that uses `adminDb()` and assert deterministic database read/write evidence.
- [x] 4.2 Invoke a fixture function that uses `db(req)` with and without caller authorization and assert the actor distinction.
- [x] 4.3 Create or invite a temporary auth user and obtain a usable bearer token through supported auth APIs.
- [x] 4.4 Invoke a fixture function that uses `getUser(req)` and assert authenticated user identity fields.
- [x] 4.5 Verify direct function endpoint behavior for no key, anon key, service key, and authenticated user token.
- [x] 4.6 Verify public routed function invocation through the deployed route.

## 5. Storage, Email, AI, And Secrets Coverage

- [x] 5.1 Upload a fixture asset through the supported blob or storage API and assert the returned URL or signed access path retrieves the expected bytes.
- [x] 5.2 Run CDN freshness or blob diagnose checks where available for the uploaded asset.
- [x] 5.3 Invoke a deployed fixture function that uploads an asset using project service-key authority and assert the returned object is retrievable.
- [x] 5.4 Delete fixture storage objects and assert cleanup is idempotent.
- [x] 5.5 Invoke a fixture function that observes the configured secret at runtime without printing the secret value.
- [x] 5.6 Invoke a fixture path that sends email to an approved test recipient or configured email test sink and assert the acceptance envelope.
- [x] 5.7 Invoke a fixture function that exercises a text-oriented AI helper such as moderation, translation, or summarization.
- [x] 5.8 Add bounded retry or explicit skip handling for transient external AI/email failures without masking platform errors.

## 6. Release Observability And Redeploy Coverage

- [x] 6.1 Fetch active release inventory and assert site, database, function, route, subdomain, and warning metadata where available.
- [x] 6.2 Fetch the release by id and assert it preserves the same full-stack resource inventory.
- [x] 6.3 Reapply an unchanged fixture release and assert no-op or reuse behavior where Run402 exposes it.
- [x] 6.4 Apply a small changed fixture release and assert release diff reports the changed resource class.
- [x] 6.5 Assert route and static asset details remain present in machine-readable release and diff output.
- [x] 6.6 Verify scheduled function metadata appears in function list or release inventory and survives activation.
- [x] 6.7 Manually invoke the scheduled fixture function and assert deterministic job output without waiting for cron timing.

## 7. Cleanup, Gated Surfaces, And Documentation

- [x] 7.1 Implement best-effort cleanup finalizers for temporary projects, users, subdomains, storage objects, secrets, and any other created live resources.
- [x] 7.2 Ensure cleanup runs after partial setup or test failure and reports cleanup failures without hiding the original failure.
- [x] 7.3 Add a coverage map documenting surfaces covered by the full-stack suite, existing smoke suites, gated suites, or explicit exclusions.
- [x] 7.4 Add gated test hooks or documented prerequisites for sticky resources such as custom domains, sender domains, and mailbox webhooks when they cannot be exercised ephemerally.
- [x] 7.5 Document that downstream application SDK/CLI surfaces and browser/UI behavior are excluded from this Run402 integration coverage.
- [x] 7.6 Document that the core full-stack suite uses headless HTTP/API assertions and does not require Playwright, Chrome, visual assertions, or browser-driven UI flows.

## 8. Verification

- [x] 8.1 Run the new full-stack integration suite against live Run402 APIs and capture pass/fail output.
- [x] 8.2 Run existing `npm run test:integration`, `npm run test:integration:full`, and `npm run test:integration:mcp` to confirm smoke suites still pass.
- [x] 8.3 Run focused unit tests for any new harness helpers, fixture assembly code, and cleanup utilities.
- [x] 8.4 Run `npm run build` and any relevant sync or docs tests if scripts, docs, or public surfaces changed.
