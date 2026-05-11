## 0. Gateway Contract Check

- [x] 0.1 Confirm whether private `GET /deploy/v2/resolve` emits route-aware outcomes for function routes, static route targets, and method mismatch.
- [x] 0.2 If route-aware outcomes are not in the private contract, keep public known match literals to current gateway literals and scope docs so resolve is authoritative for host/static/SPAfallback diagnostics but not complete route introspection.
- [x] 0.3 If route-aware outcomes are in the private contract, add `route_static_alias`, `route_function`, `method_not_allowed`, `405`, route fixtures, and route-aware docs/tests. (N/A: private contract is not route-aware today.)

## 1. SDK Types And Methods

- [x] 1.1 Add public deploy types for `StaticCacheClass`, `KnownStaticCacheClass`, `StaticManifestMetadata`, `StaticAssetsDiff`, `DeployResolveOptions`, `ScopedDeployResolveOptions`, `DeployResolveResponse`, `DeployResolveRouteMatch`, `DeployResolveMethod`, `DeployResolveMatch`, `KnownDeployResolveMatch`, `DeployResolveFallbackState`, `KnownDeployResolveFallbackState`, `KnownDeployResolveResult`, `DeployResolveSummary`, `DeployResolveWarning`, `DeployResolveNextStep`, and `NormalizedDeployResolveRequest`.
- [x] 1.2 Add `StaticRouteTarget` and widen `RouteTarget` to `FunctionRouteTarget | StaticRouteTarget`.
- [x] 1.3 Add `release_generation`, `static_manifest_sha256`, and nullable `static_manifest_metadata` to release inventory types.
- [x] 1.4 Add `static_assets` to `PlanResponse`, `PlanDiffEnvelope`, `DeployDiff`, and `ReleaseToReleaseDiff`.
- [x] 1.5 Add `Deploy.resolve(opts)` that accepts URL-first `{ project, url, method? }` and lower-level `{ project, host, path?, method? }`, sends `GET /deploy/v2/resolve` with apikey auth for `opts.project`, and builds query params with `URLSearchParams`.
- [x] 1.6 Add scoped `p.deploy.resolve(opts)` that accepts URL-first and host/path inputs, binds the scoped project, and preserves explicit project override behavior.
- [x] 1.7 Validate resolve inputs before network calls: URL/host XOR, absolute HTTP(S) URL, no URL credentials, host without scheme/path/query/fragment, path starts with `/`, host/path `path` excludes `?` and `#`, and method normalization/rejection is documented.
- [x] 1.8 Update deploy route validation to accept static targets and reject invalid static route targets before planning where the gateway contract is structural.
- [x] 1.9 Update Node manifest normalization so CLI/MCP JSON manifests preserve `{ type: "static", file }` route targets and reject invalid target fields with actionable errors.
- [x] 1.10 Export deterministic deploy resolve helpers, including static-hit and route-hit type guards plus a summary/warnings/next-step builder shared by CLI/MCP where practical.
- [x] 1.11 Export `EMPTY_STATIC_MANIFEST_METADATA` and `normalizeStaticManifestMetadata(...)` if consumers need zero-object ergonomics for nullable metadata.
- [x] 1.12 Export all new types and helpers from `@run402/sdk` and `@run402/sdk/node`.

## 2. CLI, MCP, And OpenClaw

- [x] 2.1 Add primary `run402 deploy diagnose --project <id> <url> [--method GET]`.
- [x] 2.2 Add lower-level `run402 deploy resolve --project <id> --url <url> [--method GET]` and `--host <host> [--path /x] [--method GET]` for SDK/endpoint parity.
- [x] 2.3 Reject `--url` combined with `--host`/`--path`; disclose query strings/fragments ignored by URL diagnostics in structured `request.ignored` and `warnings`.
- [x] 2.4 Print CLI diagnostic success as a structured JSON envelope with `status`, `would_serve`, `diagnostic_status`, `match`, `summary`, `request`, `warnings`, full `resolution`, and structured `next_steps`.
- [x] 2.5 Add MCP tool `deploy_diagnose_url` with `project_id`, either `url` or `host`/`path`, and optional `method`.
- [x] 2.6 Format MCP resolve output with normalized request, `would_serve`, `diagnostic_status`, `match`, deterministic summary, warnings, structured next steps, structured response when supported, and a fenced JSON fallback preserving the full response.
- [x] 2.7 Register `deploy_diagnose_url` in `src/index.ts` and use shared SDK error mapping.
- [x] 2.8 Widen MCP deploy route schema to accept function and static route targets.
- [x] 2.9 Update OpenClaw command parity and skill text for URL-first `run402 deploy diagnose`, lower-level `run402 deploy resolve`, and static route targets.

## 3. Documentation

- [x] 3.1 Update `README.md`, root `SKILL.md`, `llms-mcp.txt`, `cli/llms-cli.txt`, `sdk/README.md`, `sdk/llms-sdk.txt`, `openclaw/SKILL.md`, and `openclaw/README.md` for URL-first public diagnostics.
- [x] 3.2 Document static route targets as exact static file route targets, not rewrites or redirects, and prefer "static route target" language over ambiguous bare "alias" phrasing.
- [x] 3.3 Document static manifest metadata fields and `static_assets` counters in release/plan/diff observability docs.
- [x] 3.4 Document resolve match, route context, fallback, result, cache class, and cache policy meanings, including that `result` is diagnostic body status and host misses can be successful SDK calls.
- [x] 3.5 Update warning guidance for static route target warning codes: `STATIC_ALIAS_SHADOWS_STATIC_PATH`, `STATIC_ALIAS_RELATIVE_ASSET_RISK`, `STATIC_ALIAS_DUPLICATE_CANONICAL_URL`, `STATIC_ALIAS_EXTENSIONLESS_NON_HTML`, and `STATIC_ALIAS_TABLE_NEAR_LIMIT`.
- [x] 3.6 Update `documentation.md` with a checklist row for stable static asset identity and public URL diagnostics.
- [x] 3.7 Lead route docs with golden manifest examples that use narrow route methods, avoid routing ordinary static files, show `/api/*`, POST `/login`, exact static file route `/events`, and `run402 deploy diagnose ...`.
- [x] 3.8 Add anti-pattern guidance for routing every static file, broad method lists by default, wildcard static route targets, leading-slash static files, directory shorthand, one-static-route-target-per-page route-table exhaustion, wildcard function routes shadowing static assets, treating resolve/diagnose as fetch/cache purge, parsing MCP prose, hard-coding cache policy strings, and confusing omitted/null routes with `replace: []`.

## 4. Tests And Drift Guards

- [x] 4.1 Add SDK tests for `deploy.resolve` URL parsing, URL query/fragment ignored metadata, URL credentials rejection, non-HTTP scheme rejection, host/path query params, apikey auth, host/path URL encoding, future-safe unknown literals, sparse host-miss responses, route-aware fields when returned, and scoped binding/override.
- [x] 4.2 Add SDK type-contract tests for new public exports and inventory/diff fields.
- [x] 4.3 Add route validation tests for valid static route targets, invalid static target files, omitted methods, duplicate methods, non-GET methods, prefix patterns, same-pattern mixed-method function/static entries, unknown target fields, and target shorthands.
- [x] 4.4 Add CLI help/e2e tests for URL-first `deploy diagnose`, lower-level `deploy resolve`, JSON envelope shape, `would_serve: false` host misses, active-project defaults, URL conflict handling, stable warning/next-step codes, diagnostic miss exit 0, and bad argument handling.
- [x] 4.5 Add MCP tests for `deploy_diagnose_url` success formatting, URL/host-path input variants, structured output/fenced JSON parity, warnings, structured next steps, and SDK error mapping.
- [x] 4.6 Extend `sync.test.ts` `SURFACE` and `SDK_BY_CAPABILITY` for `deploy_diagnose_url`.
- [x] 4.7 Extend docs drift guards so static route targets, `static_assets`, `deploy_diagnose_url`, `--url`, resolve literals, route warnings, static route target warnings, and new release fields are covered across package-facing docs.
- [x] 4.8 Add docs example compile checks for at least one TypeScript route/resolve snippet from each SDK-facing public docs surface where practical.

## 5. Verification

- [x] 5.1 Run focused SDK deploy tests and type checks.
- [x] 5.2 Run focused CLI deploy tests.
- [x] 5.3 Run focused MCP deploy tool tests.
- [x] 5.4 Run `npm run test:sync`.
- [x] 5.5 Run `npm run test:skill`.
- [x] 5.6 Run `npm run build` or narrower package builds needed by touched files.
