## Why

After an agent forks a marketplace app, there's no standard way to set up the first human user. The agent has the `service_key` and can do anything via API, but it has to know the app's internal schema to create an admin user, seed demo data, or configure initial settings. Every marketplace app with roles will need this same bootstrap step, and every agent will have to reverse-engineer the app's data model to do it. A convention-based bootstrap function eliminates this — the agent passes variables, the app handles setup, the human gets a ready-to-use app.

## What Changes

- The `POST /fork/v1` and `POST /deploy/v1` endpoints accept an optional `bootstrap` object containing arbitrary key-value variables
- After the fork/deploy completes, if the bundle includes a function named `bootstrap`, the platform invokes it automatically with the provided variables
- The `bootstrap` function's return value is included in the fork/deploy response as `bootstrap_result`
- Published bundles can declare expected bootstrap variables in `run402.yaml` (names, types, descriptions, required/optional) for agent discoverability
- The `GET /v1/apps/:versionId` endpoint includes `bootstrap_variables` in the app metadata so agents know what to pass

## Capabilities

### New Capabilities
- `bootstrap-function`: Convention-based post-fork/deploy function that the platform auto-invokes with caller-provided variables. Covers the API contract (request/response shape), invocation semantics (timing, auth context, error handling), variable declaration in `run402.yaml`, and discoverability via app metadata.

### Modified Capabilities

(none)

## Impact

- **`packages/gateway/src/routes/publish.ts`**: Accept `bootstrap` field in fork request body, invoke bootstrap function after fork completes, include result in response
- **`packages/gateway/src/routes/bundle.ts`**: Accept `bootstrap` field in deploy request body, same invocation pattern
- **`packages/gateway/src/services/functions.ts`**: Add internal helper to invoke a project's function by name (reuse existing `invokeFunction` logic)
- **`packages/gateway/src/services/publish.ts`** (or equivalent): Pass bootstrap variables through the fork pipeline
- **`docs/marketplace-spec.md`**: Document `bootstrap` convention
- **`docs/functions_spec.md`**: Document bootstrap function convention
- **`site/llms.txt`**: Update fork/deploy docs with bootstrap field
- **`GET /v1/apps/:versionId`**: Include `bootstrap_variables` from published manifest
