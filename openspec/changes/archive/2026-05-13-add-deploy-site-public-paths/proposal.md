## Why

The gateway now accepts `ReleaseSpec.site.public_paths`, but the public SDK, CLI, MCP, OpenClaw, and agent docs still model static hosting as if deployed file paths are always browser-visible URLs. Agents need a typed way to publish clean static URLs such as `/events` while keeping the backing release asset `events.html` private from ordinary static lookup.

## What Changes

- Add `site.public_paths` to the public deploy contract with `mode: "implicit" | "explicit"`.
- In explicit mode, require a complete `public_paths.replace` map keyed by public browser paths, with entries `{ asset, cache_class? }`.
- Preserve sticky explicit-mode semantics: later site patches that omit `site.public_paths` remain explicit and do not expose newly added assets by filename.
- Allow `mode: "implicit"` to intentionally restore filename-derived public reachability, with gateway warnings surfaced unchanged because reachability may widen.
- Extend release inventory and resolve diagnostics types to expose `static_public_paths[]`, `asset_path`, `reachability_authority`, and `direct` when returned by the gateway.
- Keep typed deploy semantics in the SDK. CLI and MCP remain thin wrappers that parse edge input, call SDK manifest normalization / deploy APIs, and render raw SDK/gateway results.
- Preserve CI as a top-level deploy preflight: CI may forward the complete `site` resource to the gateway. The gateway remains authoritative for nested public-path validation and authorization.
- Remove bundle-deploy from scope: the deprecated compatibility path has been removed from current `main`, so only modern `deploy` / `deploy apply` surfaces are updated.

## Capabilities

### New Capabilities

- `deploy-site-public-paths-client-surface`: Client-facing contract for authoring static public paths under `ReleaseSpec.site.public_paths`, normalizing them through SDK-owned deploy machinery, and teaching agents how explicit versus implicit reachability works.

### Modified Capabilities

- `deploy-observability-client-surface`: Extend deploy release inventory and resolve diagnostics types/docs to include materialized static public path entries and reachability authority fields.
- `sdk-public-type-surface`: Export public-path authoring, inventory, and diagnostics types from both SDK entry points and include them in drift guards.
- `ci-oidc-client-surface`: Clarify that SDK CI preflight allows the complete `site` resource and delegates nested public-path authorization to the gateway.
- `deploy-web-routes-client-surface`: Update static route target documentation to distinguish route-only static aliases from direct public static paths and private release asset paths.

## Impact

- SDK deploy types, strict validation, normalization, manifest adapter, scoped type contracts, and public type exports.
- CLI `run402 deploy apply` help/docs and manifest examples; no legacy bundle-deploy compatibility path.
- MCP `deploy` schema and tool descriptions; response rendering remains lossless raw deploy result JSON plus human summary.
- Release inventory, release diff, plan/diff, and resolve diagnostics TypeScript shapes.
- Public README, SDK/CLI/MCP llms docs, root/OpenClaw skills, OpenClaw README, and `documentation.md` update triggers.
- Sync and drift tests that keep SDK, CLI, MCP, OpenClaw, README, skills, and llms docs aligned around `site.public_paths`.
