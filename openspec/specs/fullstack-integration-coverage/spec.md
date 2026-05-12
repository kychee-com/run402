# fullstack-integration-coverage Specification

## Purpose

Defines the required live integration coverage for Run402 full-stack application platform behavior, including deploy composition, runtime helpers, auth, storage/CDN, email, AI text helpers, secrets, scheduled functions, routes, cleanup, and release observability.

## Requirements

### Requirement: Product-Neutral Full-Stack Integration Suite

Run402 SHALL provide a product-neutral live integration suite that validates full-stack application platform behavior without depending on any downstream application's repository, SDK, CLI, product vocabulary, or UI.

The suite SHALL be runnable through an explicit script such as `npm run test:integration:fullstack`. The suite SHALL document that it uses live Run402 APIs, temporary resources, and configured payment credentials. The existing CLI and MCP lifecycle suites SHALL remain smoke coverage rather than becoming the full-stack fixture suite.

#### Scenario: Suite is product-neutral

- **WHEN** a developer inspects the full-stack integration fixture, test names, and docs
- **THEN** the fixture SHALL use generic Run402 application terminology
- **AND** the fixture SHALL NOT require any downstream application repository, package, SDK, CLI, or product-specific data

#### Scenario: Suite is explicitly live

- **WHEN** a developer runs the full-stack integration script
- **THEN** the command SHALL make clear that it targets live Run402 APIs and temporary live resources
- **AND** it SHALL fail early with actionable prerequisite errors when payment, network, or credential prerequisites are missing

### Requirement: Representative Unified Deploy Coverage

The full-stack integration suite SHALL deploy a representative application release through the unified deploy primitive. The release SHALL include database migrations, seeded data, static site replacement, serverless function replacement, route replacement, subdomain assignment, and at least one secret declaration.

The deploy fixture SHALL be large enough to exercise production-style behavior: multiple static pages and assets, multiple database tables, indexes or triggers where supported, multiple functions, at least one static route alias, and at least one function route.

#### Scenario: Combined deploy succeeds

- **WHEN** the suite applies the fixture release to a temporary project
- **THEN** the deploy SHALL reach a terminal success state
- **AND** the result SHALL include release id, operation id, and public URLs
- **AND** release inventory SHALL show site, database, functions, routes, and subdomain resources from the same release

#### Scenario: Deploy rejects missing required secret before mutation

- **WHEN** the suite plans or applies a fixture release that declares a missing required secret
- **THEN** Run402 SHALL surface a confirmation or validation warning before activation
- **AND** the suite SHALL then set the secret through the supported secret API and prove the deploy succeeds with the requirement satisfied

### Requirement: Database Migration And Seed Coverage

The full-stack integration suite SHALL exercise production-sized database setup. The fixture migration SHALL create multiple related tables, at least one index or trigger-backed behavior where supported, and seed rows used by runtime checks.

The suite SHALL verify idempotent migration behavior by reapplying the same fixture or an equivalent no-op release and confirming that existing data and schema-dependent behavior remain valid.

#### Scenario: Migration creates relational schema

- **WHEN** the fixture deploy completes
- **THEN** live SQL or REST checks SHALL verify that the expected tables and seeded rows exist
- **AND** at least one relational query across seeded tables SHALL return expected data

#### Scenario: Idempotent redeploy preserves behavior

- **WHEN** the suite reapplies the same database migration and seed shape
- **THEN** the redeploy SHALL not fail because objects already exist
- **AND** post-redeploy SQL or REST checks SHALL continue to return the expected seeded data

### Requirement: Hosted Static Site And Route Coverage

The full-stack integration suite SHALL verify hosted static site behavior through headless HTTP checks. It SHALL fetch deployed HTML, CSS or JavaScript assets, runtime config files, and public discovery-style JSON or text files when present in the fixture.

The suite SHALL verify static route aliases, function routes, route method behavior, and deploy route diagnostics or resolve output. Browser execution, visual assertions, and client-side UI interaction SHALL be out of scope for this suite.

#### Scenario: Static pages and assets are reachable

- **WHEN** the fixture release is active
- **THEN** HTTP GET requests to multiple deployed pages and assets SHALL return successful responses with expected content markers
- **AND** runtime configuration bytes needed by a static app SHALL be served from the deployed site

#### Scenario: Static route alias resolves

- **WHEN** the suite requests a clean static route alias such as `/docs`
- **THEN** Run402 SHALL serve the configured static target without requiring the `.html` path
- **AND** route diagnostics SHALL report that the public URL would be served

#### Scenario: Function route method behavior is enforced

- **WHEN** the fixture declares a method-specific function route
- **THEN** supported methods SHALL invoke the function route
- **AND** unsupported methods SHALL return the expected method or route failure behavior instead of falling through to unrelated static content

#### Scenario: Browser automation is not required

- **WHEN** the full-stack integration suite runs in a headless Node environment
- **THEN** it SHALL complete without Playwright, Chrome, the Codex browser, or visual inspection tooling
- **AND** any browser-level product behavior SHALL remain outside this suite's required coverage

### Requirement: Serverless Runtime Helper Coverage

The full-stack integration suite SHALL deploy and invoke functions that exercise the supported in-function helper library. Coverage SHALL include `adminDb()`, `db(req)`, `getUser(req)`, `email`, and `ai` helper paths where the live environment supports them.

The suite SHALL verify both direct protected function invocation and public routed function invocation when routes are present.

#### Scenario: Admin database helper works in a deployed function

- **WHEN** the suite invokes a fixture function that uses `adminDb()`
- **THEN** the function SHALL read or write fixture database rows successfully
- **AND** the response SHALL include deterministic evidence of the database operation

#### Scenario: Caller-context database helper receives auth

- **WHEN** the suite invokes a fixture function with an authenticated user bearer token
- **THEN** the function SHALL use `db(req)` or equivalent caller-context access to observe the caller authorization context
- **AND** unauthenticated invocation SHALL not be treated as the same actor

#### Scenario: User helper returns authenticated identity

- **WHEN** the suite invokes a fixture function with a valid authenticated user token
- **THEN** `getUser(req)` SHALL return user identity fields needed by application code
- **AND** the same function SHALL return an unauthenticated result or error without the token

### Requirement: Auth And Function Access Boundary Coverage

The full-stack integration suite SHALL exercise Run402 project auth enough to prove that deployed application functions can distinguish anonymous, anon-key, service-key, and authenticated user access where those boundaries are supported.

The suite SHALL create or invite a temporary auth user, obtain a usable session token through supported APIs, call an authenticated function, and clean up or isolate the user state.

#### Scenario: Temporary user authenticates

- **WHEN** the suite creates or invites a temporary project user through Run402 auth APIs
- **THEN** it SHALL obtain a bearer token through a supported verification or login flow
- **AND** authenticated project endpoints or functions SHALL recognize that user

#### Scenario: Direct function auth boundaries are enforced

- **WHEN** the suite calls a protected direct function endpoint with no key, anon key, service key, and authenticated user token
- **THEN** each call SHALL produce the expected authorization result for that credential type
- **AND** the test SHALL fail if an unauthenticated caller receives privileged behavior

### Requirement: Storage And CDN Coverage

The full-stack integration suite SHALL cover Run402 storage and CDN behavior for both client-side platform APIs and in-function service-key uploads. Coverage SHALL include content-addressed upload initialization, part upload when applicable, completion, public or signed retrieval, CDN freshness diagnostics where available, and delete behavior.

#### Scenario: Blob upload is fetchable through CDN

- **WHEN** the suite uploads a fixture asset through the supported blob or storage API
- **THEN** the completed response SHALL include a public or signed retrieval URL as appropriate
- **AND** fetching the URL SHALL return the uploaded bytes or expected content hash

#### Scenario: In-function storage upload works

- **WHEN** the suite invokes a deployed fixture function that uploads an asset using the project service key
- **THEN** the function SHALL complete the upload through Run402 storage APIs
- **AND** the returned URL or key SHALL be retrievable through the expected storage or CDN path

#### Scenario: Storage cleanup is idempotent

- **WHEN** the suite deletes fixture storage objects during cleanup
- **THEN** deleting an already-removed object SHALL not make cleanup fail
- **AND** subsequent reads SHALL show the object is unavailable or deleted

### Requirement: Email, AI Text, And Secret Runtime Coverage

The full-stack integration suite SHALL cover platform services commonly used by production application functions: project secrets, email sending, and AI text helpers. Secrets SHALL be set through supported APIs and read only from runtime behavior, not printed in test output.

AI image generation MAY remain covered by existing MCP smoke tests, but the full-stack suite SHALL cover at least one text-oriented AI path such as moderation, translation, summarization, or equivalent platform helper.

#### Scenario: Runtime secret is available to function code

- **WHEN** the suite sets a test secret and deploys or invokes a function requiring it
- **THEN** the function SHALL observe that the secret exists without revealing the secret value in logs or assertions
- **AND** deleting the secret during cleanup SHALL remove the dependency for future tests

#### Scenario: Email helper accepts a test send

- **WHEN** the suite invokes a fixture function or public API path that sends email to an approved test recipient
- **THEN** Run402 SHALL accept the email request
- **AND** the test SHALL assert the acceptance envelope rather than requiring mailbox delivery polling unless a delivery fixture is configured

#### Scenario: AI text helper returns usable output

- **WHEN** the suite invokes a fixture function that calls a Run402 AI text helper
- **THEN** the helper SHALL return a successful moderation, translation, or text result envelope
- **AND** the function SHALL handle transient upstream failures with bounded retry or a clearly reported skipped state

### Requirement: Scheduled Function And Job Metadata Coverage

The full-stack integration suite SHALL deploy at least one function with schedule metadata and verify that Run402 records the schedule in function or release inventory. The suite SHALL manually invoke the scheduled function path to verify runtime behavior without waiting for wall-clock cron execution.

#### Scenario: Scheduled function metadata is visible

- **WHEN** the fixture deploy includes a scheduled function
- **THEN** function list or release inventory SHALL show the configured schedule
- **AND** the schedule SHALL survive release activation

#### Scenario: Scheduled job can be invoked manually

- **WHEN** the suite manually invokes the scheduled fixture function
- **THEN** the function SHALL perform its deterministic database or service action
- **AND** the response SHALL identify the job result without depending on real cron timing

### Requirement: Release Observability And Redeploy Coverage

The full-stack integration suite SHALL verify release observability beyond active-release existence. Coverage SHALL include active release inventory, release get, release diff, no-op redeploy behavior, changed asset or function diff behavior, and route diff visibility.

#### Scenario: Active release inventory contains full-stack resources

- **WHEN** the fixture release is active
- **THEN** `getActiveRelease` or the corresponding CLI command SHALL return site, database, function, route, subdomain, and warning metadata where available
- **AND** the suite SHALL assert full JSON fields rather than parsing only human text

#### Scenario: No-op redeploy is observable

- **WHEN** the suite reapplies the unchanged fixture release
- **THEN** the resulting release or plan behavior SHALL indicate no-op or reuse where Run402 exposes it
- **AND** static asset reuse or unchanged counters SHALL be asserted when available

#### Scenario: Changed release diff is observable

- **WHEN** the suite applies a small fixture change such as one static asset, one function body, or one route
- **THEN** release diff SHALL report the changed resource class
- **AND** route and static asset details SHALL remain present in machine-readable output

### Requirement: Cleanup And Coverage Accounting

The full-stack integration suite SHALL track every live resource it creates and SHALL attempt cleanup even after partial failure. The suite SHALL maintain an explicit coverage map for Run402 surfaces exercised by the full-stack suite, smoke suites, or separately gated live suites.

Any public platform surface excluded from the full-stack suite SHALL be listed with a reason and an owner for follow-up. Downstream SDK/CLI testing and browser/UI behavior SHALL be the only standing exclusions for this change.

#### Scenario: Cleanup runs after partial failure

- **WHEN** a test fails after creating one or more live resources
- **THEN** the suite SHALL still attempt to delete temporary projects, users, subdomains, storage objects, secrets, and other created resources
- **AND** cleanup failures SHALL be reported without hiding the original failure

#### Scenario: Coverage map exposes remaining gaps

- **WHEN** a developer reviews the full-stack integration coverage map
- **THEN** each major Run402 application platform surface SHALL be marked as covered, covered by another live suite, gated, or explicitly excluded
- **AND** only downstream application SDK/CLI surfaces and browser/UI behavior SHALL be allowed as permanent exclusions under this change

#### Scenario: Sticky resource coverage is gated instead of silent

- **WHEN** custom domain, sender-domain, mailbox, or other sticky external-resource coverage cannot use ephemeral resources safely
- **THEN** the suite SHALL provide a gated test path with documented prerequisites or mark the surface as a temporary gap
- **AND** the gap SHALL not be described as covered by unrelated smoke tests
