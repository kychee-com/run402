---
title: "Quick start (isomorphic / sandbox)"
description: "Native SDK reference — environment."
order: 30
---

## Quick start (isomorphic / sandbox)

```ts
import { Run402, type CredentialsProvider } from "@run402/sdk";

const credentials: CredentialsProvider = {
  async getAuth() {
    return { Authorization: `Bearer ${session.token}` };
  },
  async getProject(id) {
    return session.projects[id] ?? null;
  },
};

const r = new Run402({
  apiBase: "https://api.run402.com",
  credentials,
});
```

The `CredentialsProvider` interface has two required methods (`getAuth`, `getProject`) plus optional ones for hosts that want full sticky-default behavior (`saveProject`, `updateProject`, `removeProject`, `setActiveProject`, `getActiveProject`, `getActiveOrg`, `readWallet`, `saveWallet`, `createWallet`, `getWalletPath`). `getActiveOrg` is read only to disambiguate a Lightning `ORGANIZATION_SELECTION_REQUIRED` answer (see `r.ai.generateImage`); the Node provider answers it from the profile's `run402 orgs use` selection.

## Mental model

The SDK is the canonical kernel. A single typed `Run402` class with one namespace per resource group (`r.projects`, `r.assets`, …). The hero apply primitive is `r.project(id).apply(spec)`; there is no public `r.deploy` surface. Every method:
- Takes typed parameters (TS interfaces in `*.types.ts`)
- Returns a typed `Promise<T>`
- Throws a typed subclass of `Run402Error` on failure
- Never calls `process.exit`

The MCP server's tools and the CLI's subcommands are argv-/schema-parsing wrappers around these methods. They share the configured API target, active project state, wallet, and local project-key cache so target selection and credentials carry across surfaces without treating cached keys as project inventory.

### Action runner (`@run402/sdk/node`)

The Node entry owns recursive agent actions. The CLI command `run402 up` is only a flag parser around this surface.

```ts
export const Run402Action = {
  ProjectsProvision: "projects.provision",
  TierSet: "tier.set",
  Up: "up",
} as const;

export type Run402ActionType =
  typeof Run402Action[keyof typeof Run402Action];

type Run402ActionInput =
  | { type: typeof Run402Action.ProjectsProvision; name?: string; tier?: "prototype" | "hobby" | "team"; orgId?: string; idempotencyKey?: string }
  | { type: typeof Run402Action.TierSet; tier: "prototype" | "hobby" | "team"; idempotencyKey?: string }
  | {
      type: typeof Run402Action.Up;
      source?: string;
      dir?: string;
      manifest?: string;
      projectId?: string;
      name?: string;
      tier?: "prototype" | "hobby" | "team";
      orgId?: string;
      idempotencyKey?: string;
      verifyOnly?: boolean;
      propagationBudgetSeconds?: number;
      propagationWait?: boolean;
    };

type Run402ExecutionMode =
  | "apply"
  | "check"
  | "printSpec"
  | "printManifest"
  | "plan"
  | { kind: "applyReviewed"; planId: string; planFingerprint?: string };
```

`r.actions.run(input, opts)` returns `{ action, mode, dry_run, target, steps, result }`. `r.up(input, opts)` is equivalent to `actions.run({ type: Run402Action.Up, ...input }, opts)`.

Local check returns `result.preflight` with nullable target/provenance, `gateway_validated: false`, checks/evidence, summary, warnings and deferred remote work. `mode: "printManifest"` returns `result.manifest`, a reloadable snake_case authoring representation relative to the source directory. `mode: "printSpec"` is advanced SDK-native inspection. The Node helper `serializeDeployManifest(loaded, baseDir, explicitProject?)` rejects unsupported runtime/secret/build constructs with `MANIFEST_EXPORT_UNSUPPORTED`.

`Run402Action.Up` behavior:
- Discover `run402.deploy.json`, then `app.json` under `dir` / cwd; explicit `manifest` wins.
- Validate the deploy manifest and referenced local files before wallet, tier, project, link, upload, or deploy mutations.
- Resolve project as explicit `projectId`, then `.run402/project.json`, then manifest `project_id`, then approved project creation from `name`; global active state never selects a deploy target.
- For app manifests with `verify.http[]`, fetch verification URLs after apply and write per-check details to `result.app_result.verification.http[]`. Fresh edge sentinel misses (`x-run402-edge` or JSON codes such as `SUBDOMAIN_NOT_CONFIGURED`) and non-settled deploy-resolve diagnostics become `propagation_pending` instead of permanent failures while the binding is fresh.
- Set `propagationBudgetSeconds` to control the wait for edge convergence (default 120). Set `propagationWait: false` to return `status: "propagation_pending"` immediately with `verify.status`, `propagation_wait_ms`, warnings, `next_action`, and diagnostic `edge_propagation` / `resolve` payloads.
- Set `verifyOnly: true` to rerun app HTTP verification without upload, deploy, resource mutation, or project creation. This is the SDK equivalent of `run402 up verify`. Its action envelope reports `mode: "verify"`, `read_only: true`, and `dry_run: false`: real HTTP probes run, but no release is applied. Each executed HTTP check includes `observed_release` with nullable `release_id` and `generation`, response `url`, `observed_at`, `source: "response_headers"`, and `unavailable_reason`. These are observations from that response, not proof that all routes agree or that a release stayed unchanged throughout the run. Missing or malformed headers remain unknown and do not fail an otherwise successful HTTP check.
- `name` is only project creation/link metadata. It is not a manifest field and never renames an existing project.
- Write `.run402/project.json` atomically when `up` needs to remember an explicit/created project. Schema: `{ schema_version: "run402.workspace-project.v1", project_id, name?, target?, created_at, updated_at? }`.
- On Run402 Cloud, recursively ensure the local wallet and tier (default bootstrap tier `prototype`) only when missing; existing active tiers are not downgraded or renewed just because `up` ran.
- On Run402 Core, skip Cloud wallet/tier prerequisites and fail closed if no Core project is selected.
- Grant key the final deploy to `r.project(id).apply(spec, opts)`.

Action options:
- `mode: "check"` validates local manifest/config and file references only. No gateway calls, uploads, prerequisite mutations, or local writes.
- `mode: "printSpec"` returns the normalized `ReleaseSpec` in `result.spec`; CLI prints only that JSON.
- `mode: "plan"` creates a gateway-reviewed non-deploying plan. It returns `result.plan.plan_id`, `plan_fingerprint`, `plan_expires_at`, warnings, diff, and same-surface `next_actions[]`.
- `mode: { kind: "applyReviewed", planId, planFingerprint? }` applies only when the reviewed plan still matches. The SDK verifies before upload and commit.
- `approval: "never" | "yes" | { mode: "interactive"; approve(request) }` gates recursive prerequisites and local link writes. SDK default is `"never"`; CLI maps `-y/--yes` to `"yes"` and TTY prompts to interactive approval. If wallet/tier/project/link are already configured, `r.up()` can run the requested deploy without approval.
- `autoPrerequisites` defaults to `true` for `up` and `false` for direct actions.
- `idempotencyKey` supplies a root key; recursive gateway mutations derive child keys from it.

Legacy `dryRun: true` remains an action-graph compatibility mode.
For typed deploy config, use `mode: "check"` for local validation and `mode: "plan"` for gateway review.

### Typed deploy config (`@run402/sdk/config`)

Typed configs compile to the same SDK-native `ReleaseSpec` as JSON manifests. Raw `ReleaseSpec` slices remain valid for fields without helpers.

```ts
import { defineConfig, dir, file, nodeFunction, sqlFile } from "@run402/sdk/config";

export default defineConfig(({ env }) => ({
  project_id: env.required("RUN402_PROJECT_ID"),
  database: { migrations: [sqlFile("db/001_init.sql")] },
  site: {
    replace: dir("dist"),
    public_paths: { mode: "implicit" },
  },
  functions: {
    replace: {
      api: nodeFunction("dist/functions/api.js", {
        deps: ["zod@^3"],
        requireAuth: true,
      }),
    },
  },
  assets: {
    put: [{ key: "logo.svg", source: file("assets/logo.svg", { contentType: "image/svg+xml" }) }],
  },
  secrets: { require: ["OPENAI_API_KEY"] },
}));
```

Helper semantics:
- `defineConfig(config)` preserves type inference. The export may be an object or `(context) => object`; context has `manifestPath`, `rootDir`, and `env`. Use `env.get("NAME")`, `env.required("NAME")`, or `env.RUN402_*` property reads; executable manifest loads report `config.env_accessed` metadata for those reads.
- `dir(path, { prefix?, ignore?, includeSensitive? })` resolves from the config directory, walks deterministically by normalized `/` path, skips sensitive defaults unless opted in, rejects symlinks, infers content type, and produces local directory descriptors consumed by the Node normalizer.
- `file(path, { contentType? })` produces a local file source (a JS option, camelCase; on the WIRE and in JSON manifests the field is `content_type`); the Node normalizer reads bytes later and keeps secrets out of config examples.
- `sqlFile(path, { id?, name?, checksum?, transaction? })` derives `id` from the filename when omitted and keeps checksum/transaction metadata stable. Pass `{ name: "seed" }` for generated/idempotent SQL; the SDK compiles `<name>_<sha256(sql)[0:16]>` from the post-build SQL bytes, changed content applies once under a new id, and unchanged re-deploys noop. SQL declared with `name` MUST be idempotent because it re-runs whenever content changes against a database where prior versions may already exist.
- `nodeFunction(path, opts)` creates a Node 22 `FunctionSpec` from built JavaScript. TypeScript function sources (`.ts`, `.tsx`, `.mts`, `.cts`) currently fail locally with `TYPESCRIPT_FUNCTION_REQUIRES_BUNDLE`; build them first and point at `.js`.

Executable trust policy:
- `loadDeployManifest("run402.deploy.ts")` can load `.ts/.mts/.cts/.js/.mjs/.cjs` configs only when the path is explicit.
- Auto-discovery for `up` checks only data manifests: `run402.deploy.json`, then `app.json`.
- If a repo only contains `run402.deploy.ts`, `up` fails with `EXECUTABLE_CONFIG_REQUIRES_EXPLICIT_MANIFEST` and a next action to rerun with `--manifest run402.deploy.ts --check`.
- `--check` / `mode: "check"` and `--print-spec` / `mode: "printSpec"` are local-only; use `--plan` / `mode: "plan"` for gateway policy, quota, cost, secret existence, missing-content, and base-release details.

The runner never executes arbitrary gateway-authored `next_actions[].command`; it uses its own fixed action graph (`wallets`, `tier`, `projects.provision`, workspace link, deploy).

### Casing in returned shapes

Two casings coexist by design — classify a field by the shape it belongs to:

- Raw API result shapes preserve the gateway's snake_case fields. Examples:
  `ProvisionResult.project_id`, `ProvisionResult.anon_key`,
  `ProvisionResult.service_key`, `ProvisionResult.schema_slot`,
  `ProjectInfo.project_id`, `ProjectSummary.lease_expires_at`,
  `UsageReport.api_calls`, `SchemaReport.schema`. These mirror the HTTP
  response bodies one-to-one.
- SDK-specific helper shapes use camelCase. Examples:
  `AssetRef.cdnUrl` / `AssetRef.cacheKind` / `AssetRef.contentSha256`,
  `Run402DeployError.safeToRetry` / `operationId` / `mutationState`,
  every `DeployEvent` variant's discriminator (`type`, plus per-variant
  fields like `releaseId`, `urls`).

The split is stable across the `3.x` line. CI fails any TypeScript-fenced example that
accesses a field that does not exist on the actual type. Reference tables
below use plain code fences (no `ts`) — they document the type surface for
visual scanning, are not runnable, and are exempt from type-checking.

### Timestamp Convention

Public API and SDK response timestamps are ISO-8601 strings, never JavaScript
`Date` objects or numeric epochs. Absolute instants use fields such as
`created_at`, `updated_at`, `expires_at`, `lease_expires_at`, `timestamp`, and
`ingestion_time`; nullable means the gateway state is genuinely absent. Numeric
time values are reserved for relative durations or local measurements and carry
units in the name (`expires_in`, `duration_ms`, `elapsedMs`, `ttl_seconds`).
