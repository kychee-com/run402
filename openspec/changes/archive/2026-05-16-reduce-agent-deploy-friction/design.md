## Context

The issues behind this change came from a real Dream Diary demo build and span the whole agent path: authoring a strict `ReleaseSpec`, setting secrets without leaking values, deploying routes and scheduled functions, parsing deploy output, and using runtime helpers after the app is live.

Current state:

- The SDK already models `FunctionSpec.schedule` at the same level as `runtime`, `source`, `files`, `entrypoint`, and `config`, but the agent-facing docs only sketch `FunctionsSpec` and do not expand the inner shape.
- The deploy manifest adapter rejects unknown fields before planning, which is good for safety but expensive when the schema is not available to editors or agents.
- The auth/expose manifest has a published JSON Schema; the full deploy `ReleaseSpec` does not.
- `@run402/functions` has project-scoped `ai.translate` and `ai.moderate`, while SDK/CLI/MCP image generation is wallet/x402 scoped and therefore unusable from deployed functions without reintroducing manual signing.
- `run402 secrets set --file` uses the shared regular-file validator, so `/dev/stdin` and pipes are rejected.
- `deploy.apply` uses one boolean `allowWarnings`, and CLI/MCP expose that as blanket acknowledgement.
- `run402 deploy apply --quiet` already suppresses the stderr event stream while preserving the final stdout envelope, but the flag name and docs are not obvious for agent/CI result parsing.
- The SDK polls `activation_pending` as a non-terminal operation state, so static function configuration failures can look like long-running deploys until timeout or manual `deploy list` inspection.

## Goals / Non-Goals

**Goals:**

- Give humans and agents an editor-validatable unified deploy manifest shape that matches the SDK/gateway contract.
- Make the common full-stack demo flow possible without post-deploy mutations or local wallet secrets inside functions.
- Keep strict validation, but make its failures faster, clearer, and closer to authoring time.
- Preserve existing successful manifests and broad `allowWarnings` compatibility while adding safer narrow acknowledgements.
- Ensure deploy result parsing can be single-line and final-envelope-only for agent loops.

**Non-Goals:**

- Redesign deploy-v2 resource semantics, CAS upload, operation state machines, or route matching.
- Replace gateway-authoritative semantic validation such as route pattern normalization, active-release target existence, or final tier enforcement.
- Add a general-purpose x402 client to `@run402/functions`.
- Store or expose secret values, hashes, or verification material in deploy manifests or list APIs.
- Build a browser/UI console for these flows.

## Decisions

1. Publish a generated `release-spec.v1.json` schema from a single source of truth.

   The schema should be checked into the public repo and deployed to `https://run402.com/schemas/release-spec.v1.json`. It should be generated from a schema source that is kept aligned with SDK deploy types and the Node manifest adapter, then verified in tests against representative manifests. Hand-written prose remains docs; the schema is the editor/autocomplete contract.

   Alternatives considered: manually writing a schema in docs only, or generating from TypeScript types directly. Docs-only leaves no editor contract. TypeScript-only generation is attractive but brittle around unions such as byte sources, `$schema`, and Node-only `{ path }` file entries. A maintained schema source with tests gives a sharper contract.

2. Treat top-level `$schema` as authoring metadata, not deploy state.

   `loadDeployManifest()` and `normalizeDeployManifest()` should accept `$schema` and strip it before producing `ReleaseSpec`. Raw `r.deploy.apply()` may also tolerate exactly top-level `$schema` to support editor-authored specs passed directly, but no other unknown-field relaxation should be introduced.

   Alternatives considered: keep rejecting `$schema` to preserve strictness, or forward it to the gateway. Rejecting it undermines the schema feature. Forwarding it pollutes the release contract. Stripping only this known metadata field preserves strict validation.

3. Make `FunctionSpec` documentation explicit and truthful.

   Docs and schema must show that `schedule` lives at `functions.replace[name].schedule` or `functions.patch.set[name].schedule`, alongside `runtime`, `source` or `files`, `entrypoint`, and `config`. If deploy-v2 still does not support npm `deps` by implementation time, the schema and docs must explicitly say `deps` is not accepted in unified deploy manifests and point to bundling source yourself or the legacy `functions deploy` surface. If gateway support for deploy-v2 deps lands with this change, `deps?: string[]` should be added at that same `FunctionSpec` level and covered by the schema.

4. Add project-billed runtime image generation through the functions runtime surface.

   `@run402/functions` should expose `ai.generateImage({ prompt, aspect? })`, using `RUN402_PROJECT_ID` and `RUN402_SERVICE_KEY` just like existing runtime helpers. The function runtime should call a service-key-protected project endpoint, not the allowance/x402 `/generate-image/v1` endpoint. The gateway owns spend caps, rate limits, abuse controls, and billing against the project/tier account.

   Alternatives considered: teaching functions to hold allowance wallets, or asking users to pre-generate images at deploy time. Wallet secrets in functions break the platform abstraction and create dangerous key handling. Pre-generation removes the live per-user app flow.

5. Add pipe-safe secret input without weakening value isolation.

   `run402 secrets set` should accept `--stdin`, and `--file -` may be accepted as a POSIX alias. `/dev/stdin` should bypass the regular-file check and stream/read fd 0. Inline positional values remain supported for compatibility but docs should steer agents toward `--stdin` and `--file`.

6. Widen warning acknowledgement from boolean to targeted policy.

   Keep `allowWarnings: true`, CLI `--allow-warnings`, and MCP `allow_warnings: true` for compatibility, but add `allowWarningCodes` in the SDK, repeatable CLI `--allow-warning <code>`, and MCP `allow_warning_codes`. Blocking warnings may proceed only when every blocking warning is either covered by the broad boolean or by an allowed code. For read-only wildcard route warnings, add durable manifest acknowledgement on route entries, such as `acknowledge_readonly: true`, valid only for function wildcard routes whose methods are GET/HEAD-compatible.

   Alternatives considered: only adding CLI `--allow-warning`. That helps manual deploys but does not travel with CI manifests, so the route-specific acknowledgement is still needed.

7. Make final-only deploy output an explicit alias for quiet mode.

   Add `--final-only` to `run402 deploy apply`; it suppresses event streaming and preserves the final stdout JSON envelope. Keep `--quiet` as an alias and document both as equivalent. This avoids changing stdout/stderr contracts while making the intended agent use case discoverable.

8. Preflight tier caps before deploy side effects.

   After manifest normalization and before hashing/upload/planning/committing, CLI/SDK deploy apply should validate literal function config against tier limits: `timeoutSeconds`, `memoryMb`, cron minimum interval, and scheduled-function count where it can be computed from the manifest or a read-only active-release inventory. Tier limits should come from a gateway-owned tier status/quote shape, with a static fallback only if the gateway contract is temporarily behind. Failures use structured local errors with `code: "BAD_FIELD"` and details including `field`, `value`, `tier`, and `tier_max` or related limit values.

9. Do not poll forever on known static activation failures.

   The gateway should mark static spec/config activation failures as non-recoverable or otherwise distinguish them from transient activation backlog. The SDK should treat `activation_pending` snapshots with known terminal error metadata as failed immediately, preserving the operation id and gateway error. Client-side tier preflight should prevent the common timeout/memory case, but the poller still needs the terminal classifier for server-discovered static violations.

## Risks / Trade-offs

- Schema drift between SDK types, manifest adapter, gateway, and hosted schema -> Add schema fixture tests, doc sync checks, and a release task that publishes the schema with the same versioned docs deploy.
- `$schema` tolerance could become a loophole for unknown metadata -> Allow only top-level `$schema`; continue rejecting every other unknown field.
- Project-billed image generation can be abused from public routes -> Enforce project-level rate limits/spend caps at the gateway and document that app auth is still the function author's responsibility.
- Tier preflight may use stale local knowledge -> Prefer a read-only tier limits endpoint; preserve gateway validation as the final authority.
- Targeted warning codes can still acknowledge multiple warnings with the same code -> Route-level manifest acknowledgement covers the known read-only wildcard case; docs should recommend code-level flags only after inspecting all affected entries.
- `--final-only` duplicates `--quiet` -> Treat it as a discoverable alias, not a separate output mode, and test that both produce identical stdout/stderr behavior.
