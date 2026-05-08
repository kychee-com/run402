## Context

The private gateway now has a deploy-v2 routes runtime behind rollout flags. The public repo already accepts a loose `routes` top-level field, but the type is a placeholder and the release-observability surfaces do not model route inventory or route diffs. Agents therefore cannot safely author manifests, reason about route warnings, or inspect which dynamic paths are live.

The public repo is the canonical package surface for external integrators: SDK types, CLI commands, MCP tools, OpenClaw scripts, and agent-facing docs must move together. The private handoff says the route runtime contract is already concrete: `routes` is absent or `null` to carry forward routes, and `{ replace: RouteSpec[] }` to replace the table. Route targets are function-only in this release, routed browser requests use the `run402.routed_http.v1` envelope, and direct `/functions/v1/:name` remains unchanged.

## Goals / Non-Goals

**Goals:**

- Make the SDK deploy types match the private gateway route contract exactly enough for TypeScript users and agents to author manifests without guessing.
- Normalize route response shapes in plan responses, release inventory, and release diffs without breaking existing site/function/secrets/subdomain consumers.
- Teach CLI, MCP, OpenClaw, and docs to display and explain routes consistently.
- Document the routed HTTP function event/response envelope so users can write browser-facing functions.
- Add tests and sync checks that keep every public interface aligned.

**Non-Goals:**

- Implement the private gateway route matcher, edge routing, or custom-domain worker behavior in this repo.
- Add direct standalone route management commands outside the deploy-v2 release primitive.
- Allow CI deploy manifests to ship routes; CI remains limited to site/functions/database/current-base only.
- Add streaming, WebSocket, SSE, or 101 upgrade support for routed functions.
- Support route target types beyond functions in this release.

## Decisions

1. Model `routes` as `ReleaseRoutesSpec`, not a path-keyed object.

   The current public placeholder is path-keyed and too permissive. The gateway contract uses an ordered replace list so validation can canonicalize patterns, detect duplicates after normalization, and preserve method-aware route metadata. Keeping this exact shape avoids client-side dialect drift. Alternative considered: keep the loose scaffold and document expected keys. Rejected because it would let agents generate manifests that compile locally and fail at the gateway.

2. Keep route support inside deploy-v2 manifests and observability.

   Routes are release resources that activate atomically with functions, site files, migrations, secrets, and subdomains. Public CLI/MCP should therefore teach `run402 deploy apply` / `deploy` rather than a separate route CRUD surface. Alternative considered: add `run402 routes` commands immediately. Rejected because it would imply mutable route state outside release activation semantics.

3. Treat route response data as first-class typed deploy observability.

   `PlanResponse`, `PlanDiffEnvelope`, `ReleaseInventory`, and `ReleaseToReleaseDiff` should include route fields, and MCP human summaries should count routes alongside other resources. The raw JSON block remains the lossless source for agents. Alternative considered: rely only on raw JSON passthrough. Rejected because the SDK type surface and CLI/MCP summaries are part of the agent contract.

4. Export every route type from both SDK entrypoints.

   Route specs appear in public deploy method inputs and route entries appear in public return types. They must be importable from `@run402/sdk` and `@run402/sdk/node`, with public export tests catching omissions. Alternative considered: leave route helper types deep under `sdk/src/namespaces`. Rejected because this repo already has a public-type-export contract for agent SDK consumers.

5. Document route matching, precedence, and routed HTTP as public contracts.

   Gateway semantics remain server-authoritative, but public clients and docs must still teach the behavior agents need for first-try manifests: exact patterns, final `/*` prefix wildcards, trailing-slash equivalence for exact routes, query ignored for matching, exact-over-prefix, longest-prefix wins, method-compatible dynamic routes before static lookup, unsafe method mismatch as 405, and fail-closed dynamic routing. The routed HTTP contract must cover event envelope, response envelope, public ingress semantics, body limits, headers/cookies, CSRF/CORS responsibilities, and cache defaults. Alternative considered: document only the manifest shape and defer matcher behavior to gateway errors. Rejected because agents would commonly generate `/admin/*` while expecting it to match `/admin`.

6. Name the route resource separately from route entries.

   `ReleaseSpec.routes` is `ReleaseRoutesSpec`, while each item in `replace` is `RouteSpec`. This avoids the current placeholder ambiguity where `RouteSpec` refers to the whole top-level route map. If the method alias is exposed publicly, it should be `RouteHttpMethod`; a generic package-root `HttpMethod` is too broad once more HTTP APIs land.

7. Public function authoring types live in `@run402/functions`.

   The SDK remains canonical for external deploy manifests and deploy observability. The routed HTTP request/response envelope is consumed inside deployed functions, so `@run402/functions` should export the handler envelope types and small body-encoding helpers. The SDK should not grow function-runtime helpers. A framework adapter can wait; boring `text`, `json`, `bytes`, and `isRequest` envelope helpers should ship with the contract.

## Risks / Trade-offs

- [Risk] Public docs may advertise routes before the gateway flags are enabled everywhere. -> Mitigation: describe the manifest contract and routed HTTP behavior, while keeping errors gateway-authoritative and documenting that direct function invocation remains unchanged.
- [Risk] Client-side validation could diverge from gateway validation. -> Mitigation: keep SDK validation structural only for required shape and unknown fields; leave semantic route matching and warning decisions to the gateway.
- [Risk] Agents can deploy routes but fail to write valid routed function responses because the envelope uses base64 bodies and duplicate-safe headers. -> Mitigation: export exact routed HTTP function types from `@run402/functions`, include text/json/bytes helpers or copy-pasteable body encoding examples, and compile docs snippets.
- [Risk] CI deploy restrictions become confusing because routes are now a first-class deploy resource. -> Mitigation: update CI restriction docs/tests to continue rejecting `spec.routes` by property presence.
- [Risk] Route warning codes are added faster than public typings. -> Mitigation: keep warning entries code-string based, document known route warning codes, and avoid closed unions for warning codes.
- [Risk] Multiple doc surfaces drift. -> Mitigation: update sync tests to require route mentions across SDK, CLI, MCP, OpenClaw, README, and skill surfaces.

## Migration Plan

1. Add SDK route types and update deploy spec validation, manifest normalization, plan response normalization, release inventory, and release diff types.
2. Update CLI and MCP schemas, help text, and release summary renderers to include route counts and raw JSON.
3. Update docs and skills across README, SDK docs, CLI llms, MCP llms, root SKILL, and OpenClaw SKILL.
4. Add unit/e2e/sync/type-export tests and run focused test suites before publishing.
5. Preserve old callers that omit `routes`; no migration is required for existing manifests. Replace any path-keyed route examples with `{ "replace": [...] }`.

## Open Questions

None. Routed HTTP envelope types and small response helpers ship from `@run402/functions`; CLI, SDK, MCP, and skill docs include a complete route + function manifest plus focused route-matching examples.
