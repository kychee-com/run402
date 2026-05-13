## 1. SDK Deploy Contract

- [x] 1.1 Add static public path authoring, inventory, and diagnostic types in `sdk/src/namespaces/deploy.types.ts`.
- [x] 1.2 Export the new public path types from both `@run402/sdk` and `@run402/sdk/node`.
- [x] 1.3 Update `SiteSpec` and normalized deploy spec types so `site.public_paths` works with `replace`, with `patch`, or as the only site field.
- [x] 1.4 Update SDK deploy validation to reject malformed `site.public_paths` shapes and unknown fields before hashing, upload planning, or deploy planning.
- [x] 1.5 Update SDK no-op validation so a public-path-only site spec is treated as deployable content.
- [x] 1.6 Update SDK deploy normalization so `site.public_paths` passes through unchanged while site file bytes still normalize to `ContentRef`s.
- [x] 1.7 Add SDK tests for explicit mode, implicit mode, public-path-only deploys, malformed public path shapes, normalization output, and public type exports.

## 2. Node Manifest Adapter

- [x] 2.1 Update `loadDeployManifest()` and `normalizeDeployManifest()` to accept and preserve `site.public_paths`.
- [x] 2.2 Keep manifest adapter strictness aligned with SDK validation for unsupported public path modes, invalid replace maps, malformed entries, and unknown fields.
- [x] 2.3 Add Node manifest adapter tests for explicit public paths, implicit public paths, public-path-only manifests, and malformed declarations.

## 3. CLI and MCP Wrappers

- [x] 3.1 Update `run402 deploy apply` manifest, spec, and stdin paths to continue delegating public path normalization and validation to the SDK adapter.
- [x] 3.2 Update CLI help and examples only at the edge, without duplicating public path canonicalization or asset-existence rules.
- [x] 3.3 Update the MCP `deploy` tool schema to accept `site.public_paths` and delegate final behavior to `getSdk().deploy.apply(...)`.
- [x] 3.4 Add CLI and MCP tests proving public path manifests reach the SDK-owned deploy path and malformed public path declarations surface SDK errors.

## 4. Observability

- [x] 4.1 Type release inventory `static_public_paths` entries with `public_path`, `asset_path`, `reachability_authority`, `direct`, `cache_class`, `content_type`, and optional route metadata.
- [x] 4.2 Type resolve diagnostics with optional `asset_path`, `reachability_authority`, and `direct` fields while preserving sparse older responses.
- [x] 4.3 Verify CLI and MCP release/resolve JSON output preserves `static_public_paths`, `asset_path`, `reachability_authority`, and `direct` without collapsing asset paths into public paths.
- [x] 4.4 Add observability tests for SDK typing and wrapper JSON preservation.

## 5. CI Deploy Behavior

- [x] 5.1 Update SDK CI deploy preflight to allow complete `site` resources, including `site.replace`, `site.patch`, and `site.public_paths`.
- [x] 5.2 Keep existing SDK CI preflight rejection for forbidden top-level resources, non-current `base`, and non-null `manifest_ref`.
- [x] 5.3 Add CI deploy tests showing public paths are forwarded to gateway planning and gateway public path errors are preserved.

## 6. Documentation and Drift Guards

- [x] 6.1 Scan `documentation.md` and update every public doc surface affected by the deploy site public path contract.
- [x] 6.2 Update SDK, CLI, MCP, README, root skill, OpenClaw skill, and OpenClaw README docs to distinguish release static asset paths from public browser paths.
- [x] 6.3 Add examples showing `events.html` as a release asset served at `/events` through `site.public_paths`.
- [x] 6.4 Document that explicit mode hides `/events.html` unless separately declared, and that `mode: "implicit"` restores filename-derived reachability and can widen access.
- [x] 6.5 Update static route documentation so ordinary clean static URLs prefer `site.public_paths`, while route static aliases remain for method-aware route-table behavior.
- [x] 6.6 Update sync and skill drift guards so missing `site.public_paths`, `static_public_paths`, or `reachability_authority` docs fail clearly.

## 7. Verification

- [x] 7.1 Run focused SDK, Node manifest adapter, CLI, MCP, CI, and observability unit tests touched by this change.
- [x] 7.2 Run `npm run test:sync` and `npm run test:skill`.
- [x] 7.3 Run `npm run build`.
- [x] 7.4 Run `npm test` when the focused test set is green or document any skipped long-running checks.
