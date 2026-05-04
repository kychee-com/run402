# @run402/sdk

Typed TypeScript client for the [Run402](https://run402.com) API. The kernel shared by `run402-mcp`, the `run402` CLI, and (eventually) user-deployed functions. Every operation is a method on a resource namespace — `r.projects.provision()`, `r.blobs.put()`, `r.deploy.apply()`, `r.functions.deploy()`, …

```bash
npm install @run402/sdk
```

## Two entry points

| Import | Use when |
|---|---|
| `@run402/sdk/node` | Running in Node 22 with the local keystore + allowance. Auto-loads `~/.config/run402/projects.json` and signs x402 payments from `~/.config/run402/allowance.json`. Includes the `r.sites.deployDir(dir)` and `fileSetFromDir(dir)` helpers. |
| `@run402/sdk` | Isomorphic — works in Node, Deno, Bun, V8 isolates. No filesystem access. Bring your own `CredentialsProvider` (a session-token shim, a remote vault, anything that resolves project keys + auth headers). |

## Quick start (Node)

```ts
import { run402 } from "@run402/sdk/node";

const r = run402();
const project = await r.projects.provision({ tier: "prototype" });
await r.blobs.put(project.project_id, "hello.txt", { content: "hi" });
```

That's it — credentials are read, x402 payments are signed, results are typed.

### Project-scoped sub-client

If you're working on a single project for the duration of a script, bind it once and skip the id arg on every call:

```ts
const p = await r.useProject(projectId);                                  // persists active project + returns scoped handle
await p.blobs.put("hello.txt", { content: "hi" });                        // no projectId arg
await p.functions.list();
await p.deploy.apply({ site: { replace: files({ "index.html": "<h1>hi</h1>" }) } });
```

`r.useProject(id)` writes the active project to the keystore (shared with concurrent CLI runs). For transient in-script scoping that does NOT mutate that state, use `r.project(id)` (or `r.project()` with no arg to resolve from whatever the keystore currently considers active).

## Quick start (isomorphic)

```ts
import { Run402 } from "@run402/sdk";

const r = new Run402({
  apiBase: "https://api.run402.com",
  credentials: {
    async getAuth() { return { Authorization: `Bearer ${session.token}` }; },
    async getProject(id) { return session.projects[id] ?? null; },
  },
});
```

The `CredentialsProvider` interface has two required methods (`getAuth`, `getProject`) plus optional ones (`saveProject`, `removeProject`, `setActiveProject`, `readAllowance`, `saveAllowance`, …) for hosts that want full sticky-default behavior.

## Namespaces (20)

| Namespace | Highlights |
|---|---|
| `projects` | `provision`, `delete`, `list`, `sql`, `rest`, `applyExpose`, `getExpose`, `getUsage`, `getSchema`, `info`, `keys`, `use`, `active`, `pin`, `getQuote` |
| `deploy` | **The unified deploy primitive (v1.34+).** `apply` / `start` / `resume` / `status` / `list` / `events` / `getRelease` / `getActiveRelease` / `diff` / `plan` / `upload` / `commit` |
| `ci` | GitHub Actions OIDC federation over `/ci/v1/*`: `createBinding`, `listBindings`, `getBinding`, `revokeBinding`, `exchangeToken`; plus canonical delegation helpers |
| `sites` | `deployDir` — Node entry only (`@run402/sdk/node`); thin wrapper over `r.deploy.apply` |
| `blobs` | `put` (returns `AssetRef` with `cdnUrl` / `sri` / `etag` / `cacheKind` and `scriptTag()`/`linkTag()`/`imgTag()` emitters), `get`, `ls`, `rm`, `sign`, `diagnoseUrl`, `waitFresh` |
| `functions` | `deploy`, `invoke`, `logs`, `update`, `list`, `delete` |
| `secrets` | `set`, `list`, `delete` |
| `subdomains` | `claim`, `list`, `delete` (most agents declare subdomains in `r.deploy.apply({ subdomains: { set: [...] } })` instead) |
| `domains` | `add`, `list`, `status`, `remove` |
| `email` | `createMailbox`, `getMailbox`, `deleteMailbox`, `send`, `list`, `get`, `getRaw`, `webhooks.*` |
| `senderDomain` | `register`, `status`, `remove`, `enableInbound`, `disableInbound` |
| `auth` | `requestMagicLink`, `verifyMagicLink`, `setUserPassword`, `settings`, `providers`, `promote`, `demote` |
| `apps` | `browse`, `getApp`, `fork`, `publish`, `listVersions`, `updateVersion`, `deleteVersion`, `bundleDeploy` (legacy shim → routes through `deploy`) |
| `tier` | `set`, `status` (tier pricing lives on `r.projects.getQuote()`) |
| `billing` | `createEmailAccount`, `linkWallet`, `tierCheckout`, `buyEmailPack`, `setAutoRecharge`, `balance`, `history`, `createCheckout` |
| `contracts` | `provisionWallet`, `getWallet`, `listWallets`, `setRecovery`, `setLowBalanceAlert`, `call`, `read`, `callStatus`, `drain`, `deleteWallet` |
| `ai` | `translate`, `moderate`, `usage`, `generateImage` |
| `allowance` | `status`, `create`, `export`, `faucet` |
| `service` | `status`, `health` (no auth, no setup — works on a fresh install) |
| `admin` | Operator/admin endpoints: messages/contact, per-project finance (`getProjectFinance`) |

CLI-style aliases are available for agent ergonomics: `r.image` aliases `r.ai`,
and common command names such as `r.billing.balance`, `r.auth.magicLink`,
`r.projects.schema`, `r.email.create`, and `r.contracts.setAlert` point at the
canonical camelCase methods.

### Casing in returned shapes

Two casings coexist by design — agents reading the type surface should
classify a field by the SHAPE it belongs to:

- **Raw API result shapes preserve the gateway's snake_case fields.** Examples:
  `ProvisionResult.project_id`, `ProvisionResult.anon_key`,
  `ProvisionResult.service_key`, `ProvisionResult.schema_slot`,
  `ProjectInfo.project_id`, `ProjectSummary.lease_expires_at`,
  `UsageReport.api_calls`, `SchemaReport.schema`. These mirror the HTTP
  response bodies one-to-one.
- **SDK-specific helper shapes use camelCase.** Examples:
  `AssetRef.cdnUrl` / `AssetRef.cacheKind` / `AssetRef.contentSha256`,
  `Run402DeployError.safeToRetry` / `operationId` / `mutationState`,
  every `DeployEvent` variant's discriminator (`type`, plus per-variant
  fields like `releaseId`, `urls`).

This split is intentional and stays through `1.x`. Doc examples in this
README and in `llms-sdk.txt` use the exact field names the types export —
copy them verbatim. CI fails any TypeScript-fenced example that accesses a
field that does not exist on the actual type.

> **Reference tables (in `llms-sdk.txt`) use plain code fences, not `ts`
> fences.** They document the type surface in compact form for visual
> scanning — they are not runnable programs and are exempt from CI
> type-checking. Runnable example snippets still use ```` ```ts ```` and are
> CI-gated against the published types.

## Patterns

### Paste-and-go assets — content-addressed URLs with SRI

`r.blobs.put` returns an `AssetRef`. The `cdnUrl` is content-addressed (`pr-<public_id>.run402.com/_blob/<key>-<8hex>.<ext>`), served through CloudFront, and never needs cache invalidation. The browser refuses execution on byte mismatch via SRI:

```ts
const logo = await r.blobs.put(projectId, "logo.png", { bytes });
//   logo.cdnUrl     → drop into <img src="…">
//   logo.sri        → "sha256-…" for <script integrity="…">
//   logo.etag       → strong "sha256-<hex>"
//   logo.cacheKind  → "immutable" | "mutable" | "private"
```

`immutable: true` is the default since v1.45 — pass `false` only when you specifically want to skip the SHA-256 pass on a very large upload.

### Unified deploy (v1.34+) — `r.deploy.apply`

The canonical primitive for any deploy (database + migrations + manifest + value-free secret declarations + functions + site + subdomain). Three layers:

```ts
// One-shot — most agents use this.
const result = await r.deploy.apply(spec);

// Long-running with progress events. Events are a discriminated union on `type`.
const op = await r.deploy.start(spec);
for await (const ev of op.events()) console.log(ev.type);
const final = await op.result();

// Resume a previously-started deploy by id.
const resumed = await r.deploy.resume(operationId);
```

- **All bytes ride through CAS.** The plan request body never carries inline bytes — only `ContentRef` objects. When the spec exceeds 5 MB JSON, the SDK uploads the manifest itself as a CAS object (`manifest_ref` escape hatch).
- **Per-resource semantics on the spec.** `site.replace` = "this is the whole site" (files absent are removed). `site.patch.put` / `patch.delete` are surgical updates. `functions.replace` / `functions.patch.set` / `functions.patch.delete` mirror that. Secrets are value-free: set values first with `r.secrets.set(project, key, value)`, then deploy with `secrets.require` and/or `secrets.delete`. `subdomains.set` / `subdomains.add` / `subdomains.remove` use their own shape. Top-level absence = leave untouched.
- **Warnings are structured.** `DeployResult.warnings` contains `WarningEntry[]` (`code`, `severity`, `requires_confirmation`, `message`, optional `affected`/`details`/`confidence`); the type preserves legacy low/medium/high plan warnings and modern deploy-observability info/warn/high warnings. `apply()` emits `plan.warnings` and stops before upload/commit on confirmation-required warnings unless `allowWarnings` is set. For `MISSING_REQUIRED_SECRET`, set the affected keys with `r.secrets.set`, then retry.
- **Planning supports dry-runs.** `r.deploy.plan(spec, { dryRun: true })` calls the server-authoritative dry-run route and returns the normalized v2 plan envelope without uploading bytes or creating plan/operation rows (`plan_id` and `operation_id` are `null`).
- **Release observability is typed.** Use `r.deploy.getRelease({ project, releaseId, siteLimit? })`, `r.deploy.getActiveRelease({ project, siteLimit? })`, and `r.deploy.diff({ project, from, to, limit? })` to inspect release inventory and release-to-release diffs. `diff` returns `ReleaseToReleaseDiff` with `migrations.applied_between_releases`; secret diffs expose keys only.
- **Server-authoritative manifest digest** — no byte-for-byte canonicalize requirement on the client.
- The Node entry adds `fileSetFromDir(path)` for filesystem byte sources:

  ```ts
  import { run402, fileSetFromDir } from "@run402/sdk/node";
  const r = run402();
  await r.deploy.apply({
    project: projectId,
    site: { replace: await fileSetFromDir("./dist") },
    subdomains: { set: ["my-app"] },
  });
  ```

### GitHub Actions OIDC — CI credentials drive deploy

The v1 CI path keeps the deploy primitive simple: link a GitHub repository once, then call the existing `r.deploy.apply` with CI-marked credentials. There is no separate `r.ci.deployApply` method and no public `ci: true` deploy option.

The CLI is the easiest setup path (`run402 ci link github`), but the SDK exposes the building blocks:

```ts
import {
  CI_GITHUB_ACTIONS_PROVIDER,
  V1_CI_ALLOWED_ACTIONS,
  V1_CI_ALLOWED_EVENTS_DEFAULT,
  run402,
  signCiDelegation,
} from "@run402/sdk/node";

const values = {
  project_id: projectId,
  subject_match: "repo:owner/name:ref:refs/heads/main",
  allowed_actions: V1_CI_ALLOWED_ACTIONS,
  allowed_events: V1_CI_ALLOWED_EVENTS_DEFAULT,
  github_repository_id: "123456789",
  expires_at: null,
  nonce: "0123456789abcdef0123456789abcdef",
};

const r = run402({ disablePaidFetch: true });
const signed_delegation = signCiDelegation(values);
await r.ci.createBinding({
  ...values,
  provider: CI_GITHUB_ACTIONS_PROVIDER,
  signed_delegation,
});
```

Inside GitHub Actions, use `githubActionsCredentials`. It reads GitHub's OIDC environment, exchanges the subject token through `r.ci.exchangeToken`, caches the Run402 session until `expires_in - refreshBeforeSeconds`, and marks the credentials so deploy uses CI Bearer auth:

```ts
import { githubActionsCredentials, run402, type ReleaseSpec } from "@run402/sdk/node";

const r = run402({
  credentials: githubActionsCredentials({ projectId }),
  disablePaidFetch: true,
});

const ciSpec: ReleaseSpec = {
  project: projectId,
  base: { release: "current" },
  site: { patch: { put: { "index.html": "<h1>ship</h1>" } } },
};

await r.deploy.apply(ciSpec);
```

CI deploys intentionally allow only `project`, `database`, `functions`, `site`, and absent/current `base`. They reject `secrets`, `subdomains`, `routes`, `checks`, unknown future top-level fields, and specs large enough to require `manifest_ref`. Use the canonical builders (`buildCiDelegationStatement`, `buildCiDelegationResourceUri`) instead of hand-rolling SIWX text; gateway tests pin those strings as golden vectors.

### Errors

All failures throw subclasses of `Run402Error`. Every subclass carries a stable
`kind` discriminator string and an `isRun402Error` brand:

| Class | `kind` | When | Notable fields |
|---|---|---|---|
| `PaymentRequired` | `"payment_required"` | HTTP 402 | x402 payment requirements in `body` |
| `ProjectNotFound` | `"project_not_found"` | Project ID not in the credential provider | `projectId` |
| `Unauthorized` | `"unauthorized"` | HTTP 401 / 403 | — |
| `ApiError` | `"api_error"` | Other non-2xx responses | `status`, `body` |
| `NetworkError` | `"network_error"` | Fetch rejected with no HTTP response | `cause` |
| `LocalError` | `"local_error"` | Local-host issues (filesystem, signing) | `cause` |
| `Run402DeployError` | `"deploy_error"` | Structured envelope from the deploy state machine (v1.34+) | `code`, `phase`, `operationId`, `safeToRetry`, `mutationState`, `nextActions` |

**Branch with type guards, not `instanceof`.** `instanceof X` is an identity
check on the class object — it fails silently when the consumer's runtime
holds a different copy of the SDK (duplicate npm installs, bundler chunk
splits, ESM/CJS interop, V8-isolate realms). The exported guards
(`isPaymentRequired`, `isDeployError`, …) check `isRun402Error` + `kind`,
which is identity-free and survives all of those scenarios. `instanceof`
continues to work for back-compat in the simple single-copy case.

```ts
import {
  run402,
  isPaymentRequired,
  isDeployError,
  type ReleaseSpec,
} from "@run402/sdk/node";

declare const spec: ReleaseSpec;
const r = run402();

try {
  await r.deploy.apply(spec);
} catch (e) {
  if (isPaymentRequired(e)) {
    // e is narrowed to PaymentRequired
    // present payment requirements to the user — read e.body, e.context, etc.
  } else if (isDeployError(e) && e.safeToRetry) {
    // e is narrowed to Run402DeployError; it's safe to retry with the same idempotency key
  } else throw e;
}
```

`Run402Error.toJSON()` returns a canonical envelope, so `JSON.stringify(e)`
produces a populated structured object instead of the empty `"{}"` plain
`Error` produces. Use this for telemetry, MCP tool results, CLI JSON output,
and any inter-process boundary where the error needs to survive serialization.

#### Retry idempotent operations with `withRetry`

`withRetry(fn, opts?)` wraps any async call with exponential backoff. It uses
`isRetryableRun402Error` (the canonical "should I retry this?" policy: 408 /
425 / 429 / 5xx / `NetworkError` / gateway-flagged `retryable` or
`safeToRetry`) by default. Pair it with the SDK method's own
`idempotencyKey` so retried mutations dedup server-side:

```ts
import {
  run402,
  withRetry,
  isPaymentRequired,
  isDeployError,
  type ReleaseSpec,
} from "@run402/sdk/node";

declare const spec: ReleaseSpec;
const r = run402();

try {
  const release = await withRetry(
    () => r.deploy.apply(spec, { idempotencyKey: "deploy-2026-05-01" }),
    {
      attempts: 3,
      onRetry: (e, attempt, delayMs) =>
        process.stderr.write(`retry ${attempt} in ${delayMs}ms\n`),
    },
  );
  console.log(release.urls);
} catch (e) {
  if (isPaymentRequired(e)) {
    // ... present payment
  } else if (isDeployError(e)) {
    // log structured envelope for triage
    process.stderr.write(JSON.stringify(e) + "\n");
  } else throw e;
}
```

Defaults: 3 attempts (1 initial + 2 retries), 250 ms base delay, 5 s cap. Pass
a custom `retryIf` to override the default policy (e.g., retry on
`PaymentRequired` if your sandbox auto-funds). After exhausting attempts
`withRetry` throws the LAST error — your catch handler sees the original
structured envelope, not a wrapper.

The SDK never calls `process.exit`. Each interface (MCP tools, CLI, your code) wraps with its own error behavior.

## Stability

This package is `0.x` while the API surface stabilizes for `1.0`. Breaking changes may occur between minor versions. Pin an exact version in production dependencies.

## Other interfaces

`@run402/sdk` is the kernel that powers four sibling packages:

- [`run402`](https://www.npmjs.com/package/run402) — CLI (terminal / scripts / CI)
- [`run402-mcp`](https://www.npmjs.com/package/run402-mcp) — MCP server (Claude Desktop / Cursor / Cline / Claude Code)
- [`@run402/functions`](https://www.npmjs.com/package/@run402/functions) — in-function helper imported _inside_ deployed functions
- OpenClaw skill — script-based skill for OpenClaw agents

All five release in lockstep.

## Links

- HTTP API reference: <https://run402.com/llms.txt>
- CLI reference: <https://run402.com/llms-cli.txt>
- Run402: <https://run402.com>

## License

MIT
