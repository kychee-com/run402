## Context

Private gateway change `run402-stable-asset-identity` adds static asset identity to deploy-v2:

- every static release can materialize a canonical `run402.static_manifest.v1`;
- active release state includes `release_generation`, `static_manifest_sha256`, and metadata counters;
- plan and release diffs include a `static_assets` bucket;
- `GET /deploy/v2/resolve` diagnoses how a stable public URL host, path, and method resolve against current live state.

The private `add-static-route-aliases` change widens web routes so exact static route targets can serve a materialized static file through the route table. Because these changes meet at `RouteTarget`, route docs, release inventory, and route diffs, the public repo should land one downstream client-surface change rather than two partially overlapping ones.

## Goals

- Mirror the private API response shapes and enums closely enough that TypeScript agents do not need deep source paths or loose `Record<string, unknown>` parsing for normal fields.
- Keep the public resolve method read-only and apikey-authenticated, with project ids used only for local key resolution.
- Make URL diagnostics URL-first for agents, while preserving host/path precision for advanced callers.
- Preserve lossless CLI/MCP JSON output for new gateway fields.
- Add deterministic human summaries and recovery hints without requiring agents to parse prose.
- Give static route targets clear local validation and docs so agents do not accidentally author rewrites, redirects, or prefix static routes.
- Update drift guards so future deploy observability changes do not land only in SDK types or only in docs.

## Non-Goals

- No gateway, Worker, database, CAS, or stable-host serving implementation.
- No client-side static resolution, route matching, or static asset diff computation.
- No public exposure of internal CAS object URLs.
- No top-level `run402 resolve` or new SDK namespace; this stays under deploy.
- No broad Web Output manifest or framework adapter surface.
- No support for static route target prefix routes, query-bearing static targets, redirects, rewrites, or directory shorthand.

## Decisions

### D1. Keep SDK `resolve`, make CLI/MCP `diagnose` the agent workflow

Use `r.deploy.resolve(...)` as the canonical SDK primitive and lead SDK docs and examples with a full absolute URL:

```ts
await r.deploy.resolve({
  project: "prj_123",
  url: "https://example.com/assets/app.js",
  method: "GET",
});
```

Keep the lower-level SDK host/path form for precision and testability:

```ts
await r.deploy.resolve({
  project: "prj_123",
  host: "example.com",
  path: "/assets/app.js",
  method: "GET",
});
```

`url` and `host`/`path` are mutually exclusive. URL input must be absolute and should be limited to `http:` and `https:`. The SDK parses `url.hostname` into `host` and `url.pathname` into `path`; query strings and fragments are ignored for gateway resolution because route matching ignores them. CLI and MCP output should preserve ignored query/fragment data in `request.ignored` and emit structured warnings. In lower-level host/path mode, reject `path` values containing `?` or `#`.

For CLI, make `run402 deploy diagnose --project prj_123 https://example.com/events --method GET` the golden command. Keep `run402 deploy resolve --url/--host/--path` as the lower-level parity command that mirrors the SDK and endpoint.

For MCP, use `deploy_diagnose_url` rather than a bare `deploy_resolve` name. In an MCP tool list, "diagnose URL" communicates that the tool explains Run402 routing for a public URL; it is not DNS lookup, HTTP fetch, cache invalidation, or CAS access.

### D2. Use future-safe diagnostic literals

Expose known literals while preserving unknown future gateway values:

```ts
type LiteralUnion<T extends string> = T | (string & {});

type KnownDeployResolveMatch =
  | "host_missing"
  | "manifest_missing"
  | "path_error"
  | "none"
  | "static_exact"
  | "static_index"
  | "spa_fallback"
  | "spa_fallback_missing";

type DeployResolveMatch = LiteralUnion<KnownDeployResolveMatch>;

type KnownStaticCacheClass =
  | "html"
  | "immutable_versioned"
  | "revalidating_asset";

type StaticCacheClass = LiteralUnion<KnownStaticCacheClass>;

type KnownDeployResolveFallbackState =
  | "unavailable"
  | "path_error"
  | "method_not_static"
  | "not_used"
  | "target_missing"
  | "used"
  | "not_configured"
  | "not_eligible";

type DeployResolveFallbackState =
  LiteralUnion<KnownDeployResolveFallbackState>;

type KnownDeployResolveResult = 200 | 400 | 404 | 503;
```

`DeployResolveResponse.result` should be `number`, not a closed numeric union, because the diagnostic result can grow with gateway behavior. `KnownDeployResolveResult` is useful for docs/tests but should not make consumers reject future statuses. If the private gateway contract is extended before public release to emit route-aware diagnostics, then add `"route_static_alias"`, `"route_function"`, `"method_not_allowed"`, and `405` to the known literal/result sets alongside fixtures and docs. Do not publish known route-aware literals merely because the public repo hopes they will exist.

`channel` is currently `"production"`, but should allow future string channel values. `binding_status` comes from custom-domain state for custom domains and `"active" | "missing"` for Run402 subdomains, so it should remain `string | null`. `cache_policy` should be `string | null`; consumers should prefer `cache_class` and tolerate unknown future cache classes.

### D3. Resolve response optionality follows the host-miss body and route-aware gap

`host_missing` returns a 200 HTTP response with only `hostname`, `result`, `match`, `authorized`, and `fallback_state`. The SDK response type should make the richer release/static fields optional or nullable so this body is representable without unsafe casts.

`result` is the diagnostic status inside the JSON body, not always the HTTP status. Invalid host input is still a normal HTTP 400 error envelope before a resolve response is produced.

The public docs describe route-table precedence, but the current gateway literal set is mostly host/static/SPAfallback-oriented. This is the main contract gate for public release. Either:

- extend the private gateway/OpenAPI so resolve reports function route matches, static route target matches, and method mismatch; or
- scope public docs so resolve is authoritative for host/static/SPAfallback diagnostics but not complete route introspection.

If the gateway returns route-table diagnostic context, the public type should preserve optional route context:

```ts
interface DeployResolveRouteMatch {
  pattern: string;
  methods: string[] | null;
  target: RouteTarget;
}
```

`DeployResolveResponse` should include `route?: DeployResolveRouteMatch | null` and `route_manifest_sha256?: string | null`. Route-aware known match values such as `"route_static_alias"`, `"route_function"`, and `"method_not_allowed"` should be added only when the gateway actually emits them.

The SDK should export small helper functions for the common safe checks: static-hit and route-hit type guards plus a deterministic summary builder that CLI/MCP can reuse. This gives TypeScript agents a safer path than probing optional fields by hand.

### D4. Static route targets are terminal exact file routes

`StaticRouteTarget` is:

```ts
interface StaticRouteTarget {
  type: "static";
  file: string;
}
```

`file` is a materialized static-site file path, not a public URL, redirect target, rewrite destination, directory shorthand, or query-bearing target. Static route targets require exact route patterns and explicit `["GET"]` or `["GET", "HEAD"]`; the gateway materializes both as effective `GET` plus `HEAD`.

### D5. Static asset observability is a summary bucket, not file inventory

`static_assets` is a diff summary with path counts, byte reuse counters, immutable-cache diagnostics, and CAS authorization failures. Detailed file inventory still lives in `site.paths` and static manifest metadata. CLI and MCP should preserve the entire bucket in JSON and may summarize the counters in human text.

### D6. Docs should explain public URL diagnostics, not serving

The resolve tool helps agents answer "why does this public URL serve or miss?" It should be documented as authenticated diagnostics for project-owned Run402 subdomains and custom domains. It should not be presented as a fetch proxy, cache invalidation command, or a way to access internal CAS URLs.

CLI/MCP output should use a structured envelope:

```json
{
  "status": "ok",
  "would_serve": false,
  "diagnostic_status": 404,
  "match": "host_missing",
  "summary": "GET https://missing.example/ did not resolve because the host is not bound to this account/project context.",
  "request": {
    "project": "prj_123",
    "project_scope": "credential_lookup_only",
    "project_sent_to_gateway": false,
    "original_url": "https://missing.example/?utm=x#hero",
    "host": "missing.example",
    "path": "/",
    "method": "GET",
    "ignored": {
      "query": "?utm=x",
      "fragment": "#hero"
    }
  },
  "warnings": [
    {
      "code": "query_ignored",
      "message": "Query strings do not affect Run402 route resolution."
    },
    {
      "code": "fragment_ignored",
      "message": "URL fragments are never sent to the server and do not affect resolution."
    }
  ],
  "resolution": {
    "hostname": "missing.example",
    "result": 404,
    "match": "host_missing",
    "authorized": false,
    "fallback_state": "not_used"
  },
  "next_steps": [
    {
      "code": "check_domain_binding",
      "message": "Check that the host is configured as a Run402 custom domain or subdomain."
    },
    {
      "code": "check_dns",
      "message": "Check DNS and domain binding status."
    },
    {
      "code": "check_credentials",
      "message": "Check that the selected project credentials can inspect this host."
    }
  ]
}
```

This keeps host misses as successful diagnostic calls while making the diagnosed public URL result unambiguous.

### D7. Docs should lead with the manifest agents should write

The first route/static docs should teach the golden manifest, not backend inventory concepts. Start with a static site plus function plus explicit route table, while saying that normal static files do not need routes. Use narrow methods in examples so agents do not cargo-carry every HTTP method into every function route:

```ts
routes: {
  replace: [
    {
      pattern: "/api/*",
      methods: ["GET", "POST", "OPTIONS"],
      target: { type: "function", name: "api" },
    },
    {
      pattern: "/login",
      methods: ["POST"],
      target: { type: "function", name: "login_submit" },
    },
    {
      pattern: "/events",
      methods: ["GET", "HEAD"],
      target: { type: "static", file: "events.html" },
    },
  ],
}
```

Then teach diagnostics:

```bash
run402 deploy diagnose --project prj_123 https://example.com/events --method GET
```

Only after the golden path should docs explain `static_manifest_sha256`, `static_manifest_metadata`, `static_assets`, `site.paths`, and file-level `content_sha256`, with a clear separation between release identity, diff observability, route behavior, cache class, and URL diagnostics.

### D8. Keep static manifest metadata nullable

`static_manifest_metadata` should remain `StaticManifestMetadata | null` unless the gateway can distinguish all zero-object cases from legacy/missing/unavailable cases. Null means metadata is unavailable; it does not necessarily mean the release has zero static files. The SDK may export `EMPTY_STATIC_MANIFEST_METADATA` and `normalizeStaticManifestMetadata(...)` for consumers that want zero-object ergonomics.
