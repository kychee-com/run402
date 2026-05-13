## Context

The private gateway now supports `ReleaseSpec.site.public_paths` on `POST /deploy/v2/plans`. The public repo still exposes only `site.replace` and `site.patch`, so SDK users, CLI manifests, MCP tool calls, and agent docs cannot express the new distinction between release static assets and browser-visible public static paths.

Current public surfaces also still teach static route targets as an alias shape, but the new gateway model makes the underlying vocabulary sharper:

```text
release static asset        public static path
events.html          ---->  /events
private release file        browser-visible URL
```

This change is client-surface work only. The gateway remains authoritative for final materialized-state validation: sticky explicit-mode inheritance, missing asset references, canonical public path validation, widened-reachability warnings, route/static conflicts, and runtime serving semantics.

## Goals / Non-Goals

**Goals:**

- Model `site.public_paths` in the SDK's public `ReleaseSpec` and normalized plan-request types.
- Keep SDK validation strict for object shape and mode/field rules so typos fail before upload or planning.
- Preserve gateway authority for semantic checks that depend on base release state or final materialized assets.
- Extend typed release inventory and resolve diagnostics so clients can inspect `static_public_paths`, `asset_path`, `reachability_authority`, and `direct` when returned.
- Keep CLI and MCP thin: they parse edge input, delegate normalization/deploy behavior to the SDK, and preserve raw result JSON.
- Let CI forward complete `site` specs, including `site.public_paths`, to the gateway under the existing CI deploy flow.
- Update agent docs and drift tests so public path examples do not regress back to file-path-equals-public-URL thinking.

**Non-Goals:**

- No gateway implementation, serving changes, or new HTTP endpoints.
- No `ReleaseSpec.web`, framework output compiler, rewrites, redirects, response header rules, ISR, SSR, or middleware support.
- No new CI wrapper API, public `ci` deploy option, or SDK-side nested authorization model for public paths.
- No bundle-deploy compatibility. The deprecated bundle path has been removed from current `main`.
- No client-side proof that a public path's `asset` exists in the final release; the gateway owns that final-state check.

## Decisions

### Decision: SDK owns the public-path deploy contract

`sdk/src/namespaces/deploy.types.ts` should define the canonical authoring types:

```ts
export interface PublicStaticPathSpec {
  asset: string;
  cache_class?: StaticCacheClass;
}

export type SitePublicPathsSpec =
  | { mode: "implicit"; replace?: never }
  | { mode: "explicit"; replace: Record<string, PublicStaticPathSpec> };

export type SiteSpec =
  | { replace: FileSet; public_paths?: SitePublicPathsSpec }
  | { patch: { put?: FileSet; delete?: string[] }; public_paths?: SitePublicPathsSpec }
  | { public_paths: SitePublicPathsSpec };
```

The normalized wire type should mirror the same shape while replacing file byte sources with `ContentRef`s. `public_paths.replace` entries should remain path/metadata objects; they do not carry bytes and should not enter CAS upload planning.

Alternative considered: let CLI and MCP accept loose `public_paths` objects and pass them through as `unknown`. Rejected because deploy semantics belong in the SDK and public TypeScript users need autocomplete and drift protection.

### Decision: Validate shape locally, leave materialized semantics to the gateway

The SDK should reject unknown `site` fields, unknown `public_paths` fields, invalid `mode`, `mode: "explicit"` without a `replace` object, `mode: "implicit"` with `replace`, malformed public path entry objects, and non-string `asset` fields before hashing or uploading.

The SDK should not try to duplicate gateway canonicalization for public paths. Encoded separators, internal namespaces, duplicate canonical paths, missing asset references, explicit-mode inheritance, and widen-access warnings all depend on gateway canonicalization or final release state. Those should remain canonical gateway errors or warnings.

Alternative considered: copy the private gateway's path canonicalizer into the SDK. Rejected because drift here would be worse than a server-authoritative error, and clients already depend on gateway validation for route pattern normalization and target existence.

### Decision: Public-path-only site specs are meaningful

`site.public_paths` by itself can materially change browser reachability. The SDK and CLI empty-manifest guards should treat these as deployable:

```json
{ "site": { "public_paths": { "mode": "implicit" } } }
{ "site": { "public_paths": { "mode": "explicit", "replace": {} } } }
```

The empty explicit map is intentional: it can remove all direct public static URLs while leaving release assets available to route-only static aliases or future compiled resources.

Alternative considered: require `site.replace` or `site.patch` alongside `public_paths`. Rejected because public reachability is its own release resource even when no bytes change.

### Decision: CI forwards complete `site` specs

The CI preflight should remain top-level and allow the complete `site` resource. It should not reject `site.public_paths` or inspect nested public path entries. Gateway planning remains responsible for public-path validation and any CI authorization policy.

Route scopes remain route-table scopes. This change should not reinterpret `route_scopes` as a client-side public-path authorization mechanism. If the gateway later introduces nested public-path CI restrictions, the SDK should preserve the canonical gateway error envelope rather than invent a parallel client policy.

Alternative considered: reject `site.public_paths` in CI until a dedicated `public_path_scopes` model exists. Rejected because the desired product policy is for CI to forward the complete `site` object to the gateway.

### Decision: Observability types expose reachability vocabulary directly

Release inventory should type `static_public_paths?: StaticPublicPathInventoryEntry[]` or the gateway-required equivalent field, with entries containing:

- `public_path`
- `asset_path`
- `reachability_authority`
- `direct`
- `cache_class`
- `content_type`
- optional `route_id`
- optional `methods`

Resolve diagnostics should type optional `asset_path`, `reachability_authority`, and `direct`. Existing raw response passthrough should remain, so older gateways that omit these fields continue to work.

Alternative considered: fold public path data into existing `site.paths`. Rejected because `site.paths` describes release static assets, while `static_public_paths` describes browser reachability.

### Decision: Documentation teaches the new mental model

Docs and skills should lead with the distinction between release asset paths and public browser paths. The canonical example should show `/events` mapping to `events.html` through `site.public_paths`, and explicitly state that in explicit mode `/events.html` is not public unless declared.

Static route target docs should describe route-only static aliases as a different surface: useful for method-aware paths such as static `GET /login` plus function `POST /login`, not the preferred way to author ordinary clean static URLs.

Alternative considered: keep the existing static route target `/events -> events.html` as the primary clean-URL example. Rejected because it continues to teach route-table aliases where the new direct public-path table is a better fit.

## Risks / Trade-offs

- [Risk] Client validation under-validates public path strings compared with gateway rules. -> Mitigation: document gateway authority and preserve canonical error bodies; keep local validation to shape checks that cannot drift.
- [Risk] Agents confuse `asset` with a public URL path. -> Mitigation: docs, type comments, and examples consistently call it a release static asset path and show `/events` separately from `events.html`.
- [Risk] CI behavior looks too permissive because nested public paths are not inspected locally. -> Mitigation: state that CI forwards complete `site` to gateway; gateway authorization and errors are canonical.
- [Risk] Older gateways omit new observability fields. -> Mitigation: make new diagnostic fields optional where the gateway response is sparse and preserve `[key: string]: unknown` passthroughs.
- [Risk] Thin wrappers accidentally reimplement SDK validation in CLI/MCP. -> Mitigation: tasks and tests should assert CLI/MCP call `normalizeDeployManifest` / `deploy.apply` rather than duplicating public-path semantics.

## Migration Plan

1. Add SDK types and local shape validation for `site.public_paths`.
2. Update normalization so file bytes still become CAS refs while `public_paths` is preserved in the normalized spec.
3. Update the Node manifest adapter, MCP deploy schema, and CLI help examples to accept the new SDK-owned shape.
4. Extend typed inventory and resolve diagnostics with static public path fields.
5. Update docs, skills, and sync drift tests.
6. Verify with focused unit/type/sync tests. Runtime behavior rolls out with the already-shipped gateway; rollback is to stop authoring `site.public_paths` while leaving implicit mode unchanged.

## Open Questions

- Should the public SDK type make `static_public_paths` required on `ReleaseInventoryBase` immediately, or optional until all deployed gateway environments return it?
- Should docs describe exact gateway validation codes for malformed public paths if those codes are now stable, or keep guidance generic around `INVALID_SPEC`?
