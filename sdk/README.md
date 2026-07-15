# @run402/sdk

Typed TypeScript client for the [Run402](https://run402.com) API. The kernel shared by `run402-mcp`, the `run402` CLI, and (eventually) user-deployed functions. Most operations are project-scoped — bind once with `r.project(id)` and call `.apply()` for atomic mixed writes, `.assets.put()` for blob uploads, `.functions.deploy()`, etc.

```bash
npm install @run402/sdk
```

## Two entry points

| Import | Use when |
|---|---|
| `@run402/sdk/node` | Running in Node 22 with the local profile state, project-key credential cache, and allowance. Auto-loads the configured API base, profile `credentials/project-keys.v1.json`, and signs x402 payments from `~/.config/run402/allowance.json`. Includes `r.actions.run(...)`, `r.up(...)`, `r.sites.deployDir(dir)`, `fileSetFromDir(dir)`, `loadDeployManifest(path)`, `normalizeDeployManifest(input)`, and `resolveRun402TargetProfile()`. |
| `@run402/sdk` | Isomorphic — works in Node, Deno, Bun, V8 isolates. No filesystem access. Bring your own `CredentialsProvider` (a session-token shim, a remote vault, anything that resolves project keys + auth headers). |

The Node entry sends bounded client-version metadata on gateway requests using the unprefixed `Run402-Client` header, for example `surface="sdk", version="3.7.14", sdk="3.7.14"`. The CLI passes `surface: "cli"`, so gateway compatibility hints can distinguish CLI-created SDK traffic from direct SDK callers. Metadata never includes local paths, package manager details, wallet/org/project ids, secrets, or install confidence. The isomorphic entry does not send this header by default; pass `clientMetadata` explicitly only in runtimes where custom headers are expected.

## Quick start (Node)

```ts
import { run402 } from "@run402/sdk/node";

const r = run402();
const project = await r.projects.provision({ tier: "prototype" });
await (await r.project(project.project_id)).assets.put("hello.txt", { content: "hi" });
```

That's it — credentials are read, x402 payments are signed, results are typed.

Before creating an x402 payment payload, the Node entry confirms USDC with
bounded retry/backoff and independent RPC failover on Base and Base Sepolia.
RPC exhaustion is never treated as a zero balance. Branch on the exported
`X402BalanceError.code`: `X402_RPC_TIMEOUT`, `X402_RPC_RATE_LIMITED`, and
`X402_RPC_UNAVAILABLE` are pre-payment failures with `safeToRetry === true`
and `mutationState === "not_started"`; `X402_INSUFFICIENT_FUNDS` means the
relevant balance reads succeeded and the confirmed funds do not cover any
accepted requirement. A retryable preflight failure is not cached, so the next
request checks provider health again. Error details contain provider indexes
and failure classes, never RPC credentials, wallet keys, or signed proofs.

For repo-level app deploys, the Node entry also exposes the action runner used by `run402 up`:

```ts
import { Run402Action, run402 } from "@run402/sdk/node";

const r = run402();

await r.up({ name: "my-app" }, { approval: "yes" });
await r.up({ verifyOnly: true, propagationWait: false });

await r.actions.run({
  type: Run402Action.ProjectsProvision,
  name: "my-app",
});
```

Action identifiers are exported constants plus a string-literal union, so inputs narrow by `type`. `up` validates `run402.deploy.json` / `app.json` before any mutation, resolves the project as explicit `projectId` → `.run402/project.json` → manifest `project_id` → approved creation from `name` → approved active-project fallback, then delegates to `r.project(id).apply(...)`. `name` is only project creation/link metadata; it is not a manifest field and never renames an existing project. If allowance/tier/project/link are already configured, `r.up()` can run the requested deploy with the default approval policy; pass `{ approval: "yes" }` only when you want recursive prerequisites/local writes to proceed unattended.

App manifests can define `verify.http[]`. `r.up()` verifies those URLs after deploy, treats fresh Run402 edge sentinel misses as `propagation_pending` instead of permanent failures while the host binding converges, and returns `app_result.verify` plus per-check diagnostics. Use `propagationBudgetSeconds` to tune the default 120 second wait, `propagationWait: false` to return the pending state immediately, and `verifyOnly: true` to rerun verification without upload, deploy, project creation, or resource mutation.

Typed-config workflows use one execution-mode union:

```ts
await r.up({ manifest: "run402.deploy.ts" }, { mode: "check" });
await r.up({ manifest: "run402.deploy.ts" }, { mode: "printSpec" });
await r.up({ manifest: "run402.deploy.ts" }, { mode: "plan" });
await r.up(
  { manifest: "run402.deploy.ts" },
  { mode: { kind: "applyReviewed", planId: "plan_...", planFingerprint: "pfp_..." } },
);
```

`check` and `printSpec` are local-only. `plan` calls the gateway in reviewed-plan mode and returns `plan_id` / `plan_fingerprint`; `applyReviewed` verifies before upload and again at commit.

For a self-hosted Run402 Core Gateway, run `run402 init --api-base=http://my-core:4020` once. The Node SDK then targets that API base by default; explicit `run402({ apiBase })` still wins.

App build scripts should use the same target/profile store instead of parsing `target.json` or project-key cache files:

```ts
import { resolveRun402TargetProfile } from "@run402/sdk/node";

const target = resolveRun402TargetProfile({
  requiredTarget: "core",
  requireProject: true,
  requireAnonKey: true,
});

console.log(target.apiBase, target.projectId, target.anonKey);
```

For app-specific legacy env names, pass aliases:

```ts
import { resolveRun402TargetProfile } from "@run402/sdk/node";

resolveRun402TargetProfile({
  envAliases: {
    projectId: ["MY_APP_PROJECT_ID"],
    anonKey: ["MY_APP_ANON_KEY"],
  },
});
```

### Project-scoped sub-client

Most operations are project-scoped. Bind once and skip the id arg on every call:

`r.projects.list()` and `r.projects.get(id)` are server-authoritative project reads. `r.projects.use(id)` validates the project with the current principal and stores only an active project id in profile state; it does not require local project-key cache membership. `r.project(id)` binds the id without local lookup. Each namespace then follows its declared auth mode: control-plane operations such as custom domains default to principal/delegate auth with explicit `project_id`, while true data-plane/key operations use local project credentials and fail with `PROJECT_CREDENTIAL_NOT_FOUND` when the selected profile lacks cached keys.

```ts
const p = await r.useProject(projectId);                                  // persists active project + returns scoped handle
await p.assets.put("hello.txt", { content: "hi" });                       // no projectId arg
await p.functions.list();
await p.apply({ site: { replace: files({ "index.html": "<h1>hi</h1>" }) } });
```

`r.useProject(id)` writes the active project to the keystore (shared with concurrent CLI runs). For transient in-script scoping that does NOT mutate that state, use `r.project(id)` (or `r.project()` with no arg to resolve from whatever the keystore currently considers active).

Local project keys live behind an explicit credential-cache namespace. These helpers are local/offline and are not authoritative project reads:

```ts
const status = await r.credentials.projectKeys.status(projectId); // redacted
const serviceKey = process.env.RUN402_SERVICE_KEY!;
await r.credentials.projectKeys.import(projectId, { serviceKey });
const keys = await r.credentials.projectKeys.export(projectId, { reveal: true });
await r.credentials.projectKeys.remove(projectId);
```

`status`/`list` report `source: "local_cache"`, profile/cache-path provenance, key presence, prefixes, and fingerprints without full secrets. `export(..., { reveal: true })` is the only SDK helper that emits cached secret key material.

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

## Namespaces

| Namespace | Highlights |
|---|---|
| `actions` | Node entry only (`@run402/sdk/node`). Generic recursive action runner: `actions.run({ type: Run402Action.Up | ProjectsProvision | TierSet, ... })`; `r.up(input, opts)` is the convenience for repo-level manifest deploys. Recursive mutations are approval-gated; `mode: "check" | "printSpec" | "plan" | { kind: "applyReviewed" }` distinguishes local validation, gateway review, and exact reviewed apply. Child gateway mutations derive idempotency keys from the root action. |
| `projects` | `provision`, `delete`, `list`, `get`, `use`, `active`, `sql`, `rest`, `validateExpose`, `applyExpose`, `getExpose`, `getUsage`, `getSchema`, `info`, `keys`, `pin`, `getQuote`. `list`/`get`/`use` are server-authoritative; local key reads are moving to `credentials.projectKeys`. |
| `snapshots` | Internal project restore points: `create`, `list`, `get`, `restorePlan`, `restore`, `delete`. Restore is a two-step plan/confirm handshake. |
| `branches` | Contained project data branches: `create`, `list`, `renew`, `delete`. Branches default to expiring, noindex, sandboxed-email copies. |
| `credentials` | `projectKeys.list`, `projectKeys.status`, `projectKeys.import`, `projectKeys.export`, `projectKeys.remove` for explicit local project-key cache management. |
| `r.project(id).apply` | **The unified apply primitive.** Callable hero — `r.project(id).apply(spec)` for atomic mixed writes (release slices + assets slice). Sub-methods: `.plan`, `.start`, `.resume`, `.upload`, `.commit`, `.rehearse`, `.status`, `.list`, `.events`, `.resolve`, `.getRelease`, `.getActiveRelease`, `.diff`. Underlying engine routes to `/apply/v1/*`. |
| `ci` | GitHub Actions OIDC federation over `/ci/v1/*`: `createBinding`, `listBindings`, `getBinding`, `revokeBinding`, `exchangeToken`; plus canonical delegation helpers. `createBinding` accepts `asset_key_scopes` for per-key CI write authorization. |
| `r.project(id).sites` | `deployDir` — Node entry only (`@run402/sdk/node`); thin wrapper over `r.project(id).apply({ site: dir(...) })` |
| `r.project(id).assets` | `put` (single asset), `putMany`, `uploadDir` (Node, additive), `syncDir` (Node, destructive only with `prune: true` + confirm token), `prepareDir` (returns `{ manifest, applySlice }` for pre-commit URL injection), `get`, `ls`, `rm`, `sign`, `diagnoseUrl`, `waitFresh`, `diff`. Returns `AssetRef` (single) or `AssetManifest` (batch). |
| `cache` (v1.52+) | SSR origin ISR cache: `invalidate(url)`, `invalidatePrefix({ host, prefix })`, `invalidateAll({ host })`, `invalidateMany(urls)`, `inspect(url)`. Project-scoped (host ownership validated server-side; cross-project hosts throw `R402_CACHE_INVALIDATION_HOST_FORBIDDEN`). Generation-guarded — in-flight MISS renders started before an invalidate cannot overwrite the freshly-cleared state. |
| `functions` | `deploy`, `invoke`, `logs`, `update`, `list`, `delete`, `rebuild`, `rebuildAll`, `runs.*` durable function requests |
| `jobs` | `submit`, `get`, `logs`, `cancel`, `purge` for platform-managed jobs |
| `secrets` | `set`, `list`, `delete` |
| `subdomains` | `claim`, `list`, `delete` (most agents declare subdomains in `r.project(id).apply({ subdomains: { set: [...] } })` instead) |
| `domains` | `add`, `list`, `status`, `remove` |
| `email` | `createMailbox`, `listMailboxes`, `setMailboxDefaults`, `updateMailbox`, `getMailbox`, `deleteMailbox`, `send`, `list`, `get`, `getRaw`, `webhooks.*` |
| `senderDomain` | `register`, `status`, `remove`, `enableInbound`, `disableInbound` |
| `auth` | `requestMagicLink`, `verifyMagicLink`, `createUser`, `inviteUser`, `setUserPassword`, `settings`, passkey registration/login/list/delete helpers, `providers`, `promote`, `demote` |
| `apps` | `browse`, `getApp`, `fork`, `publish`, `listVersions`, `updateVersion`, `deleteVersion` |
| `tier` | `set`, `status` (tier pricing lives on `r.projects.getQuote()`) |
| `billing` | `createEmailOrganization`, `linkWallet`, `createCheckout`, `setAutoRecharge`, `checkBalance`, `getOrganization`, `lookupOrganization`, `getHistory`, `balance`, `history` |
| `contracts` | `provisionSigner`, `getSigner`, `listSigners`, `setRecovery`, `setLowBalanceAlert`, `call`, `read`, `callStatus`, `drain`, `deleteSigner` |
| `ai` | `translate`, `moderate`, `usage`, `generateImage` |
| `allowance` | `status`, `create`, `export`, `faucet` |
| `service` | `status`, `health` (no auth, no setup — works on a fresh install) |
| `admin` | Operator/admin endpoints: messages/contact, per-project finance (`getProjectFinance`) |
| `operator` | **The human / email principal** — distinct from the agent's per-wallet SIWX identity (and from platform-`admin`). Read session: `deviceStart`, `devicePoll`, `overview({ token })`, `revoke({ token })` — browser-delegated device-authorization (RFC 8628, the `aws sso login` model); `overview` returns the email-union across every wallet that verified the email. Write session (v1.78): `buildCliAuthorizeUrl`/`exchangeCliToken` (loopback-PKCE CLI login) + the hosted `operator.session.*` surface (email magic-link / passkey / OAuth login, `whoami`/`refresh`/`revoke`, step-up, authenticators, recovery) — carry a minted session SDK-wide with `controlPlaneSessionCredentials({ token })`. Drives `run402 operator login[/--loopback]/overview/whoami/logout`. No MCP tool by design — MCP authenticates as the agent, not the human. |
| `wallet(address)` | `getLabel()`, `setLabel(label)` — the signed server-side wallet label (gateway `/wallets/v1/:address/label`) surfaced in the operator console; pushed on `wallets use` unless `RUN402_WALLET_LABEL_SYNC=0`. Use the `r.wallet(address)` handle (the two-string `r.wallets.setLabel(address, label)` is deprecated) |
| `orgs` | **Org-owned control plane** (v1.77+; first-class orgs v1.82). `create`, `list`, `whoami` (the gateway-resolved control-plane identity) on the collection; the scoped `r.org(id)` sub-client (org analog of `r.project(id)`) adds `get`, `rename`, `setPayoutWallet`, `members.*` (`list`/`add`/`setRole`/`revoke`), `invites.*` (`list`/`create`/`revoke`), `audit`. Org create/read/rename summaries include `tier`, `lease_started_at`, and `lease_expires_at`. |
| `grants` | `create`, `revoke` — per-project capability grants (e.g. `"deploy"`, `"functions:write"`) for agent/CI principals; owner-gated, also reachable project-scoped as `r.project(id).grants` |
| `events` | `list`, `listForOrg` — the cursored project events feed ("what happened since I last looked"): deploy activations, suspensions, transfers, lifecycle cliffs, each with platform-suggested `next_actions`, plus app-emitted business facts (`source: "app"`) alongside the platform's own (`source: "platform"`) — filter with `{ source?, eventType? }`. Opaque store-and-echo cursor; `reset: true` + `earliest_cursor` instead of errors on expiry. Also reachable project-scoped as `r.project(id).events` |
| `errors` | `list`, `get`, `watch` — the release-error-rollup query surface. **Verdict-first**: each page leads with a gateway-computed promote-vs-revert verdict (`new_fingerprints` / `recurring_fingerprints` / `invocations_in_window`, baselined against the previous ACTIVE release), then grouped, deploy-stable error fingerprints with `fetch_logs` drill-downs. `watch({ newIn })` is the promote-gate poll loop — run it right after apply/promote; `clean === (verdict.new_fingerprints === 0)`, the gateway's count (no client-side identity math). Opaque keyset cursor. Also reachable project-scoped as `r.project(id).errors` |

CLI-style aliases are available for agent ergonomics: `r.image` aliases `r.ai`,
and common command names such as `r.billing.balance`, `r.auth.magicLink`,
`r.projects.schema`, `r.email.create`, and `r.contracts.setAlert` point at the
canonical camelCase methods.

Durable function requests live under `r.functions.runs` and the scoped project handle. They require an idempotency key and support immediate, delayed, or absolute-time execution, retry policy, logs, cancellation, redrive, and polling:

```ts
const p = await r.project(projectId);
const run = await p.functions.runs.create("worker", {
  eventType: "reminder.send",
  payload: { message_id: "msg_123" },
  idempotencyKey: r.idempotency.fromParts("reminder", "msg_123"),
  delay: "10m",
  retry: r.functions.retry.standard({ maxAttempts: 3 }),
});
await p.functions.runs.wait(run.run_id);
```

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

This split is intentional and stable across the `3.x` line. Doc examples in this
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

`(await r.project(id)).assets.put` returns an `AssetRef`. The `cdnUrl` is content-addressed (`pr-<public_id>.run402.com/_blob/<key>-<8hex>.<ext>`), served through CloudFront, and never needs cache invalidation. The browser refuses execution on byte mismatch via SRI:

```ts
const logo = await (await r.project(projectId)).assets.put("logo.png", { bytes });
//   logo.cdnUrl     → drop into <img src="…">
//   logo.sri        → "sha256-…" for <script integrity="…">
//   logo.etag       → strong "sha256-<hex>"
//   logo.cacheKind  → "immutable" | "mutable" | "private"
```

`immutable: true` is the default since v1.45. The SDK always computes and sends the object SHA-256; pass `false` only when you specifically need mutable URL/cache semantics.

### Image variants (v1.49)

Image uploads (jpeg/png/webp/heic/heif) trigger automatic generation of three WebP variants — `thumb` 320w, `medium` 800w, `large` 1920w — plus dimensions, a blurhash placeholder, and (for HEIC/HEIF sources) a JPEG display variant. Everything ships on the returned `AssetRef`:

```ts
const p = await r.project(projectId);
const ref = await p.assets.put("hero.jpg", bytes, { contentType: "image/jpeg" });

// Image-conditional fields, undefined on non-image AssetRefs:
ref.width_px;                       // 4032 — display-oriented (post-EXIF rotate)
ref.height_px;                      // 3024
ref.blurhash;                       // "LEHV6nWB2yk8pyo0adR*.7kCMdnj" — decode client-side for LQIP
ref.variants?.thumb?.cdn_url;       // 320w WebP — for grid thumbnails
ref.variants?.medium?.cdn_url;      // 800w WebP — for cards
ref.variants?.large?.cdn_url;       // 1920w WebP — for heroes

// SDK convenience fields, also undefined on non-images:
ref.thumbUrl;                       // = variants.thumb.cdn_url ?? displayUrl (single-field thumbnail)
ref.displayUrl;                     // = display_url ?? cdn_url (browser-renderable for any image)

// Render with responsive srcset (sizes is required):
const html = ref.imgTagWithSrcSet({
  alt: "Hero",
  sizes: "(max-width: 800px) 100vw, 1920px",
});
// → <picture>
//     <source type="image/webp" srcset="<thumb> 320w, <medium> 800w, <large> 1920w" sizes="…">
//     <img src="<display_url>" alt="Hero" width="4032" height="3024" loading="lazy" decoding="async">
//   </picture>

// Quick thumbnail (TypeScript narrows thumbUrl on non-images):
// <img src={ref.thumbUrl} alt={ref.key} loading="lazy" />
```

HEIC/HEIF uploads (from iPhones) preserve the source bytes verbatim — `cdn_url` serves the original HEIC, and a JPEG display variant is generated automatically and surfaced at `display_url`. The `imgTag` / `imgTagWithSrcSet` helpers default the `<img src>` to `displayUrl` so apps render correctly without HEIC-specific code.

Foolproof guards keep non-images from rendering broken layouts:

- `thumbUrl` and `displayUrl` are `undefined` (not a fallback to `cdn_url`) on non-image AssetRefs — TypeScript narrows them, so a `<img src={pdfRef.thumbUrl}>` is a compile error rather than a broken thumbnail at runtime.
- `imgTagWithSrcSet` throws at call time when `opts.sizes` is missing or empty (browsers over-fetch the largest candidate without it), AND when the AssetRef has no `variants` (use `imgTag()` instead — see the error message). No silent fallback.
- `imgTag` opportunistically emits `width`/`height` attributes when present (eliminates CLS) and silently omits them on non-image refs.

Variants apply to BOTH write paths — single-shot `r.assets.put(...)` AND the unified apply hero `r.project(id).apply({ assets: { put: [...] } })` return the same `AssetRef` shape with variants populated.

AVIF was deferred from v1 — `<picture>` browsers select sources by `type` precedence, not best size, so a single 1920w AVIF would be picked for thumbnails by AVIF-capable browsers. AVIF, if it returns, will land at all three sizes simultaneously or via a separate `imgTagHero()` helper.

### Mixed apply — site + assets in one atomic activation

Drop a per-key asset put into the same release as your site files. Both promote inside the same activation transaction that flips `live_release_id`, so the asset URLs are live the moment the new release is. Source shorthand: bare strings, `Uint8Array`, or any other `ContentSource` (Blob, FsFileSource from `fileSetFromDir`, `{ data, contentType? }` wrapper). The SDK normalizer hashes once and dedups across slices — same SHA in `site` and `assets` uploads as a single byte stream.

```ts
import { run402, fileSetFromDir } from "@run402/sdk/node";
const r = run402();
const p = await r.project(projectId);

const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const siteFiles = await fileSetFromDir("./dist");
const result = await p.apply({
  site: { replace: siteFiles },
  assets: {
    put: [
      { key: "static/logo.png", source: imageBytes, content_type: "image/png" },
      { key: "static/styles.css", source: "/* inline css */" },
    ],
  },
});
const logo = result.assets?.byKey["static/logo.png"];
console.log(logo?.cdn_url);   // hot the moment the release activates
```

For bulk asset uploads, use the Node-only helpers `uploadDir` (additive), `syncDir` (destructive with explicit `prune: true` + confirmation token), and `prepareDir` (returns `{ manifest, applySlice }` so the agent can render HTML against resolved URLs before committing in one apply transaction):

```ts
import { run402, type AssetManifest, type FileSet } from "@run402/sdk/node";
const r = run402();
const p = await r.project(projectId);
const renderHtml = (_m: AssetManifest) => "<h1>hi</h1>";
const siteFiles: FileSet = {};

const { manifest, applySlice } = await r.assets.prepareDir("./assets", { project: projectId, prefix: "static/" });
const html = renderHtml(manifest);                          // urls already populated
await p.apply({
  site: { replace: { ...siteFiles, "index.html": html } },  // atomic with assets
  assets: applySlice,
});
```

### Expose manifest validation

Validate the auth/expose manifest used by `manifest.json`, `database.expose`, and `apply_expose` before mutating a project:

```ts
const manifest = { version: "1" as const, tables: [] };
const result = await r.projects.validateExpose(manifest, {
  project: projectId,                  // optional live-schema context
  migrationSql: "create table items (id bigint primary key);",
});

if (result.hasErrors) console.log(result.errors);
```

`migrationSql` is reference context only; it is not executed as a PostgreSQL dry run. This method validates authorization manifests, not deploy manifests.

### Unified apply — `r.project(spec.project).apply`

The canonical primitive for any deploy (database + migrations + manifest + value-free secret declarations + functions + site + subdomain). Three layers:

```ts
import { run402, summarizeDeployResult, type ReleaseSpec } from "@run402/sdk/node";

const r = run402();
const spec: ReleaseSpec = {
  project: "prj_...",
  site: {
    patch: {
      put: {
        "index.html": "<h1>Hello</h1>",
        "events.html": "<h1>Events</h1>",
      },
    },
    public_paths: {
      mode: "explicit",
      replace: { "/events": { asset: "events.html", cache_class: "html" } },
    },
  },
};

// One-shot — most agents use this.
const result = await (await r.project(spec.project)).apply(spec);
const summary = summarizeDeployResult(result);
console.log(summary.headline);

// Long-running with progress events. Events are a discriminated union on `type`.
const op = await (await r.project(spec.project)).apply.start(spec);
for await (const ev of op.events()) console.log(ev.type);
const final = await op.result();

// Resume a previously-started deploy by id.
const resumed = await (await r.project(projectId)).apply.resume("op_...");
```

- **All bytes ride through CAS.** The plan request body never carries inline bytes — only `ContentRef` objects. When the spec exceeds 5 MB JSON, the SDK uploads the manifest itself as a CAS object (`manifest_ref` escape hatch).
- **Per-resource semantics on the spec.** `site.replace` = "this is the whole site" (files absent are removed). `site.patch.put` / `patch.delete` are surgical updates. `site.public_paths` controls browser-visible static paths separately from backing release asset paths: explicit mode uses a complete map such as `{ "/events": { asset: "events.html", cache_class: "html" } }`, so `/events` serves `events.html` while `/events.html` is not public unless separately declared. Implicit mode restores filename-derived reachability and can widen access. A public-path-only site spec is deployable. `functions.replace` / `functions.patch.set` / `functions.patch.delete` mirror that. Secrets are value-free: set values first with `r.secrets.set(project, key, { value })`, then deploy with `secrets.require` and/or `secrets.delete`. `subdomains.set` / `subdomains.add` / `subdomains.remove` use their own shape. Top-level absence = leave untouched.
- **Same-origin web routes.** `routes` is `undefined | null | { replace: RouteSpec[] }`. Omit it or pass `null` to carry forward base routes, pass `{ replace: [] }` to clear routes, or pass route entries to replace the table. Function targets use `{ type: "function", name }`; exact static route targets use `{ type: "static", file }` with methods `["GET"]` or `["GET","HEAD"]`, no wildcard pattern, and a relative deployed asset path with no leading slash. `file` is not a public path, URL, CAS hash, rewrite, or redirect. Prefer `site.public_paths` for ordinary clean static URLs like `/events -> events.html`; use static route targets for method-aware aliases such as static `GET /login` plus function `POST /login`. Function routes may add fixed tenant x402 pricing: `pricing: { mode: "always", amount_usd_micros: 250000, pay_to: "org_default_payout" }`; omitted `networks` means production mainnet only, and `"testnet"` must be opted in explicitly. Static aliases cannot be priced. Set the org payout wallet with `r.org(orgId).setPayoutWallet({ walletAddress })`; audit payments with `r.projects.listTenantPayments(projectId)` or scoped `r.project(id).projects.listTenantPayments()`. Routed browser ingress invokes Node 22 Fetch Request -> Response handlers; `req.url` is the full public URL on managed subdomains, deployment hosts, and verified custom domains. On priced routes, handlers should import `getRoutedPaymentContext` from `@run402/functions` and use `payment.paymentId` for idempotency. Direct `/functions/v1/:name` invocation remains API-key protected. Runtime route failure codes include `ROUTE_MANIFEST_LOAD_FAILED`, `ROUTED_INVOKE_WORKER_SECRET_MISSING`, `ROUTED_INVOKE_AUTH_FAILED`, `ROUTED_ROUTE_STALE`, `ROUTE_METHOD_NOT_ALLOWED`, `PAYOUT_WALLET_REQUIRED`, `PAYOUT_WALLET_AMBIGUOUS`, `PAYOUT_WALLET_UNRESOLVED`, `PAYMENT_PROOF_MISMATCH`, and `ROUTED_RESPONSE_TOO_LARGE`.
- **Strict spec validation happens before network calls.** Raw `ReleaseSpec` objects reject unknown fields (for example `project_id` or `subdomain`) instead of silently dropping them during normalization, and project/base-only or empty nested specs fail with `Run402DeployError.code === "MANIFEST_EMPTY"`. Use the Node manifest helpers when starting from CLI/MCP-style JSON.
- **Tier preflight happens before apply side effects.** After normalization and before manifest CAS upload or `/apply/v1/plans`, apply checks literal function timeout, memory, schedule-trigger cron minimum interval, and scheduled-trigger count when known. Violations throw `Run402DeployError.code === "BAD_FIELD"` with `details.field`, `details.value`, `details.tier`, the relevant cap, and `details.limit_source`; gateway validation remains authoritative.
- **Warnings are structured.** `DeployResult.warnings` contains `WarningEntry[]` (`code`, `severity`, `requires_confirmation`, `message`, optional `affected`/`details`/`confidence`); the type preserves legacy low/medium/high plan warnings and modern deploy-observability info/warn/high warnings. `apply()` emits `plan.warnings` and stops before upload/commit on confirmation-required warnings unless broad `allowWarnings` is set or every blocking code is listed in `allowWarningCodes`. For `MISSING_REQUIRED_SECRET`, set the affected keys with `r.secrets.set`, then retry.
- **Deploy summaries are SDK-owned convenience.** `summarizeDeployResult(result)` returns `DeploySummary` (`schema_version: "deploy-summary.v1"`) with a headline plus reliable current buckets for site path counts, CAS new/reused bytes, functions, migrations, routes, secrets, subdomains, and warning counts. It is derived from `DeployResult.diff` / `DeployResult.warnings`; it makes no extra gateway calls, omits sections the gateway did not return, and intentionally excludes timings, client-side duration estimates, and function old/new code hashes.
- **Safe release-race retries are SDK-owned.** `apply()` automatically re-plans and retries omitted/current-base specs when the gateway returns `BASE_RELEASE_CONFLICT` with `safe_to_retry: true`. Static activation/config failures reported from `activation_pending` throw immediately with gateway metadata preserved. The default retry budget is two retries after the initial attempt; pass `{ maxRetries: 0 }` to opt out.
- **Planning has two explicit non-deploying modes.** `(await r.project(spec.project)).apply.plan(spec, { mode: "reviewedPlan" })` calls the gateway reviewed-plan route and returns `plan_id`, `plan_fingerprint`, `plan_expires_at`, diff, warnings, and `next_actions[]` without uploading bytes or committing. Exact apply passes `{ requiredPlan: { planId, planFingerprint? } }` to `apply()` / `start()` / `commit()`; the SDK verifies before upload and commit. Legacy `{ dryRun: true }` still calls the no-row debug route and returns `plan_id: null`, but it is not require-able.
- **Rehearsals run candidate plans on contained branches.** Use the lower-level sequence when you want an explicit gate before commit:

  ```ts
  const p = await r.project(spec.project);
  const { plan, byteReaders } = await p.apply.plan(spec);
  await p.apply.upload(plan, { byteReaders });
  if (!plan.plan_id) throw new Error("Preview plans cannot be rehearsed");
  const rehearsal = await p.apply.rehearse(plan.plan_id, { teardown: "on_pass" });
  if (rehearsal.report.status !== "passed") throw new Error("Rehearsal failed");
  const committed = await p.apply.commit(plan.plan_id);
  ```

  Plan responses may advertise `rehearsal: { available, rehearse_url }`; commit results may carry `restore_point` or `snapshot_skipped_reason`.
- **Release observability is typed.** Use `r.project(id).apply.getRelease(releaseId, { siteLimit? })`, `r.project(id).apply.getActiveRelease({ siteLimit? })`, and `r.project(id).apply.diff({ from, to, limit? })` to inspect release inventory and release-to-release diffs (there is no bare `r.deploy` surface). Inventories include `release_generation`, `static_manifest_sha256`, nullable `static_manifest_metadata` (`file_count`, `total_bytes`, `cache_classes`, `cache_class_sources`, `spa_fallback`), and `static_public_paths[]` when returned. `site.paths` lists release static assets; `static_public_paths[]` lists browser reachability with `public_path`, `asset_path`, `reachability_authority`, `direct`, cache class, and content type. `diff` returns `ReleaseToReleaseDiff` with `migrations.applied_between_releases`; secret diffs expose keys only; `static_assets` exposes unchanged/changed/added/removed files, CAS byte reuse, eliminated deployment-copy bytes, and immutable/CAS warning counts.
- **Server-authoritative manifest digest** — no byte-for-byte canonicalize requirement on the client.
- The Node entry adds `fileSetFromDir(path)` for filesystem byte sources:

  ```ts
  import { run402, fileSetFromDir } from "@run402/sdk/node";
  const r = run402();
  const p = await r.project(projectId);
  await p.apply({
    site: { replace: await fileSetFromDir("./dist") },
    subdomains: { set: ["my-app"] },
  });
  ```

  `fileSetFromDir` skips `.git/`, `node_modules/`, `.DS_Store`, dotenv/npmrc files, and private-key-like filenames by default; pass `{ includeSensitive: true }` only when those files are intentional deploy artifacts.

- Route manifests are ordinary deploy specs:

  ```ts
  import { run402, type RouteSpec, type ReleaseSpec } from "@run402/sdk/node";

  const r = run402();
  const orgId = "43530623-da33-4905-b476-a78592d284ba";
  await r.org(orgId).setPayoutWallet({ walletAddress: "0xabc0000000000000000000000000000000000001" });
  const routes: RouteSpec[] = [
    { pattern: "/api/*", methods: ["GET", "POST", "OPTIONS"], target: { type: "function", name: "api" } },
    { pattern: "/api/credits", methods: ["POST"], target: { type: "function", name: "credits" }, pricing: { mode: "always", amount_usd_micros: 250000, pay_to: "org_default_payout" } },
    { pattern: "/admin", target: { type: "function", name: "admin" } },
    { pattern: "/admin/*", target: { type: "function", name: "admin" } },
    { pattern: "/login", methods: ["POST"], target: { type: "function", name: "auth" } },
  ];
  const spec: ReleaseSpec = {
    project: projectId,
    functions: {
      replace: {
        api: { source: "export default async function handler(req) { const url = new URL(req.url); return Response.json({ ok: true, path: url.pathname }); }" },
        credits: { source: "import { getRoutedPaymentContext } from '@run402/functions'; export default async function handler(req) { const payment = getRoutedPaymentContext(req); if (!payment) return new Response('payment missing', { status: 500 }); return Response.json({ ok: true, payment_id: payment.paymentId, amount_usd_micros: payment.amountUsdMicros }); }" },
        admin: { source: "export default async () => new Response('admin')" },
        auth: { source: "export default async () => new Response('login')" },
      },
    },
    site: { replace: {
      "index.html": "<!doctype html><main id='app'></main>",
      "events.html": "<!doctype html><h1>Events</h1>",
    }, public_paths: { mode: "explicit", replace: { "/events": { asset: "events.html", cache_class: "html" } } } },
    routes: { replace: routes },
  };

  await (await r.project(spec.project)).apply(spec);
  ```

  Matching is exact or final `/*` prefix only. `/admin/*` does not match `/admin`; deploy both `/admin` and `/admin/*` when the section root is dynamic. Release static asset paths and public browser paths are distinct. In the example, `events.html` is a release asset and `/events` is the public static URL declared by `site.public_paths`; `/events.html` is not public in explicit mode unless separately declared. A route-only static alias looks like `{ pattern: "/events", methods: ["GET", "HEAD"], target: { type: "static", file: "events.html" } }`; prefer `site.public_paths` for ordinary clean URLs and reserve static route targets for exact method-aware route-table behavior. Avoid routing every static file, wildcard static targets, leading-slash files, directory shorthand, broad method lists by default, and one-static-route-target-per-page route-table exhaustion. Query strings are ignored for matching and preserved in the handler's full public `req.url`. Exact beats prefix, longest prefix wins, and method-compatible dynamic routes beat static files. A method-specific `POST /login` route lets static `GET /login` serve HTML. Unsafe method mismatch returns `405`; matched dynamic route failures do not fall back to static assets.

  Routed functions use Node 22 Fetch Request -> Response. `req.url` is the full public URL on managed subdomains, deployment hosts, and verified custom domains. The raw `run402.routed_http.v1` envelope is internal; direct `/functions/v1/:name` remains API-key protected.

  Recipe — static home page + SPA shell: a root alias `{ pattern: "/", target: { type: "static", file: "home.html" } }` (with `home.html` shipped at the site root) serves real static bytes at `GET /` (`route_static_alias`) while unmatched app routes such as `/dashboard` keep the `index.html` shell (`spa_fallback`) — route matching runs before all static resolution, including the implicit `/` -> `index.html` root mapping, and SPA-fallback derivation is independent of the route table. Expect non-blocking `STATIC_ALIAS_SHADOWS_STATIC_PATH` (warn) and `STATIC_ALIAS_DUPLICATE_CANONICAL_URL` (info) plan lints; omitted `routes` carries the alias forward, and `routes.replace` is total, so include the alias every time your pipeline sends it.

- URL-first public diagnostics:

  ```ts
  import {
    buildDeployResolveSummary,
    normalizeDeployResolveRequest,
    run402,
    type DeployResolveAuthorizationResult,
    type DeployResolveCasObject,
    type DeployResolveResponse,
    type DeployResolveResponseVariant,
  } from "@run402/sdk/node";

  const r = run402();
  const request = normalizeDeployResolveRequest({
    project: projectId,
    url: "https://example.com/events?utm=x#hero",
    method: "GET",
  });
  const p = await r.project(projectId);
  const resolution: DeployResolveResponse = await p.apply.resolve(request);
  const summary = buildDeployResolveSummary(resolution, request);
  const auth: DeployResolveAuthorizationResult | undefined = resolution.authorization_result ?? undefined;
  const cas: DeployResolveCasObject | undefined = resolution.cas_object ?? undefined;
  const variant: DeployResolveResponseVariant | undefined = resolution.response_variant ?? undefined;
  void auth; void cas; void variant;
  console.log(summary.would_serve, summary.match, request.ignored);
  ```

  `r.project(id).apply.resolve({ url, method })` also accepts lower-level `{ host, path?, method? }`. URL query strings/fragments are ignored for lookup and surfaced in `request.ignored`. When returned, `asset_path`, `reachability_authority`, and `direct` explain which release asset backs the public URL and whether reachability came from implicit file-path mode, explicit `site.public_paths`, or a route-only static alias. Stable-host diagnostics may also include `authorization_result`, `cas_object` (`sha256`, `exists`, `expected_size`, `actual_size`), hostname-specific `response_variant`, route/static fields such as `allow`, `route_pattern`, `target_type`, `target_name`, and `target_file`, plus `edge_propagation` (`settled`, `propagating`, or `sync_pending`). Current known `match` literals are `host_missing`, `manifest_missing`, `active_release_missing`, `unsupported_manifest_version`, `path_error`, `none`, `static_exact`, `static_index`, `spa_fallback`, `spa_fallback_missing`, `route_function`, `route_static_alias`, and `route_method_miss`; preserve unknown future strings. Known `authorization_result` values include `authorized`, `not_public`, `not_applicable`, `manifest_missing`, `target_missing`, `active_release_missing`, `unsupported_manifest_version`, `path_error`, `missing_cas_object`, `unfinalized_or_deleting_cas_object`, `size_mismatch`, and `unauthorized_cas_object`. Known `fallback_state` values include `active_release_missing`, `unsupported_manifest_version`, and `negative_cache_hit`; preserve unknown future strings. `result` is diagnostic body status, not SDK HTTP transport status, so host misses can be successful calls with `would_serve: false`. Do not use resolve as a fetch, cache purge, or cache-policy oracle; branch on structured fields such as `cache_class`, `allow`, `cas_object`, and `edge_propagation`, and preserve unknown cache classes.

  Route warning recovery:

  | Code | Why it matters | Recovery |
  |------|----------------|----------|
  | `PUBLIC_ROUTED_FUNCTION` | Function becomes public same-origin browser ingress. | Review app auth, CSRF, CORS/`OPTIONS`, and cookies; direct `/functions/v1/:name` remains API-key protected. Prefer `allowWarningCodes` after review; broad `allowWarnings` only after every warning was reviewed. |
  | `ROUTE_TARGET_CARRIED_FORWARD` | Carried-forward route still targets a base-release function. | Inspect active routes and deploy `routes.replace` if the target should change. |
  | `ROUTE_SHADOWS_STATIC_PATH` / `WILDCARD_ROUTE_SHADOWS_STATIC_PATHS` | Dynamic route shadows direct public static content. | Inspect warning details, active routes, `static_public_paths`, and resolve diagnostics; confirm only when intentional. |
  | `METHOD_SPECIFIC_ROUTE_ALLOWS_GET_STATIC_FALLBACK` | Unmatched methods can serve static content. | Confirm fallback is intended or add method coverage. |
  | `WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS` | Wildcard function route only allows `GET`/`HEAD`. | Add mutation methods such as `POST`, omit methods for an API prefix, or set `acknowledge_readonly: true` on an intentionally read-only GET/HEAD final-wildcard function route. |
  | `ROUTE_TABLE_NEAR_LIMIT` | Route table is near a limit. | Consolidate or remove routes. |
  | `ROUTES_NOT_ENABLED` | Routes are disabled for the project/environment. | Deploy without `routes` or request enablement; direct function invoke is not a browser-route substitute. |
  | `STATIC_ALIAS_SHADOWS_STATIC_PATH` / `STATIC_ALIAS_RELATIVE_ASSET_RISK` | Route-only static alias conflicts with a direct public static path or has relative-asset risk. | Inspect active routes, `static_public_paths`, and the backing `asset_path`; prefer `site.public_paths` for ordinary clean URLs and confirm only when intentional. |
  | `STATIC_ALIAS_DUPLICATE_CANONICAL_URL` / `STATIC_ALIAS_EXTENSIONLESS_NON_HTML` | Route-only static alias may duplicate another direct public path or expose extensionless non-HTML. | Use one canonical public path per page and reserve exact static route targets for method-aware aliases. |
  | `STATIC_ALIAS_TABLE_NEAR_LIMIT` | Static route targets are near route-table limits. | Avoid one-static-route-target-per-page tables; consolidate. |

- The Node entry also has the typed manifest adapter shared by CLI/MCP:

  ```ts
  import { loadDeployManifest, run402 } from "@run402/sdk/node";

  const r = run402();
  const { spec, idempotencyKey } = await loadDeployManifest("./run402.deploy.json");
  await (await r.project(spec.project)).apply(spec, { idempotencyKey });
  ```

  `loadDeployManifest(path)` parses JSON relative to the manifest file, maps
  agent-friendly `project_id` into `ReleaseSpec.project`, decodes base64 file
  entries, turns `{ path }` entries into lazy `FsFileSource` values, and reads
  migration `sql_path` / `sql_file`. It also loads explicit executable
  `.ts/.mts/.cts/.js/.mjs/.cjs` configs and rejects executable auto-discovery
  with `EXECUTABLE_CONFIG_REQUIRES_EXPLICIT_MANIFEST`. It rejects unknown
  manifest fields before they can become partial deploys. Use
  `normalizeDeployManifest(input)` when the manifest object is already in memory.

  Minimal `run402.deploy.ts`:

  ```ts
  import { defineConfig, dir, nodeFunction, sqlFile } from "@run402/sdk/config";

  export default defineConfig(({ env }) => ({
    project: env.required("RUN402_PROJECT_ID"),
    database: { migrations: [sqlFile("db/001_init.sql")] },
    site: { replace: dir("dist"), public_paths: { mode: "implicit" } },
    functions: { replace: { api: nodeFunction("dist/functions/api.js") } },
    secrets: { require: ["OPENAI_API_KEY"] },
  }));
  ```

  Helper semantics are explicit: `dir()` walks deterministically, normalizes
  path separators, skips sensitive defaults unless `includeSensitive` is set,
  and rejects symlinks; `file()` resolves relative paths from the manifest
  directory; `sqlFile()` derives `id` from the filename unless supplied and
  preserves optional checksum/transaction metadata; `nodeFunction()` stages
  built JavaScript for Node 22. TypeScript function source paths are rejected
  with `TYPESCRIPT_FUNCTION_REQUIRES_BUNDLE` until the SDK owns a deterministic
  bundling path. Typed configs may declare `secrets.require[]` / `delete[]`,
  but never embed secret values. Config functions receive
  `{ manifestPath, rootDir, env }`; reading through `env.get()`,
	  `env.required()`, or `env.RUN402_*` records `config.env_accessed` metadata
	  on executable manifest loads so agents can explain spec drift.

### Snapshots and branches

Project snapshots are internal restore points. They are separate from portable archives and are never downloadable:

```ts
const snapshot = await r.snapshots.create(projectId);
const page = await r.snapshots.list(projectId, { limit: 20 });
const plan = await r.snapshots.restorePlan(projectId, snapshot.snapshot_id);
await r.snapshots.restore(projectId, snapshot.snapshot_id, plan.restore_plan.confirm.token, {
  includeAuth: true,
});
await r.snapshots.delete(projectId, snapshot.snapshot_id);
```

Branches are contained project copies for inspecting migrations and sharing temporary data state:

```ts
const branch = await r.branches.create(projectId, {
  ttlDays: 7,
  emailMode: "sandbox",
});
await r.branches.renew(projectId, branch.branch_project_id, { ttlDays: 7 });
await r.branches.delete(projectId, branch.branch_project_id);
```

Scoped handles expose the same surface as `p.snapshots.*` and `p.branches.*`.

### GitHub Actions OIDC — CI credentials drive deploy

The v1 CI path keeps the deploy primitive simple: link a GitHub repository once, then call the existing `r.project(spec.project).apply` with CI-marked credentials. There is no separate `r.ci.deployApply` method and no public `ci: true` deploy option.

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
  // Optional: omit or [] for no CI route authority.
  // Use exact paths and/or final wildcard prefixes for route declarations.
  route_scopes: ["/admin", "/api/*"],
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

await (await r.project(ciSpec.project)).apply(ciSpec);
```

CI deploys intentionally allow only `project`, `database`, `functions`, `site`, absent/current `base`, and `routes` authorized by the binding's `route_scopes`. Omitted or empty `route_scopes` preserves the original no-routes CI posture. The SDK normalizes scopes, sends `route_scopes` only when non-empty, and still rejects `secrets`, `subdomains`, `checks`, unknown future top-level fields, non-current `base`, and specs large enough to require `manifest_ref` before upload/plan. Gateway planning enforces route diffs and can return `CI_ROUTE_SCOPE_DENIED`; re-link with covering exact scopes like `/admin` or final-wildcard scopes like `/api/*`, or deploy locally. Use the canonical builders (`buildCiDelegationStatement`, `buildCiDelegationResourceUri`) instead of hand-rolling SIWX text; gateway tests pin those strings as golden vectors.

### Timestamp Convention

Public API and SDK response timestamps are ISO-8601 strings, not `Date` objects
or numeric epochs: `created_at`, `updated_at`, `expires_at`,
`lease_expires_at`, `timestamp`, and similar absolute instants all stay JSON
native. Numeric time values are only for relative durations or elapsed/local
measurements, and their names carry units such as `expires_in`, `duration_ms`,
`elapsedMs`, or `ttl_seconds`.

### Errors

All failures throw subclasses of `Run402Error`. Every subclass carries a stable
`kind` discriminator string and an `isRun402Error` brand:

| Class | `kind` | When | Notable fields |
|---|---|---|---|
| `PaymentRequired` | `"payment_required"` | HTTP 402 | x402 payment requirements in `body` |
| `ProjectNotFound` | `"project_not_found"` | Server-authoritative project lookup/authorization reports not found or hidden | `projectId` |
| `ProjectCredentialNotFound` | `"local_error"` | A local project-key cache entry is required but missing for the selected profile | `projectId`, `details.source="local_cache"`, `nextActions` |
| `Unauthorized` | `"unauthorized"` | HTTP 401 / 403 | — |
| `ApiError` | `"api_error"` | Other non-2xx responses | `status`, `body` |
| `NetworkError` | `"network_error"` | Fetch rejected with no HTTP response | `cause` |
| `LocalError` | `"local_error"` | Local-host issues (filesystem, signing) | `cause` |
| `X402BalanceError` (Node entry) | `"local_error"` | x402 USDC balance preflight could not be confirmed, or confirmed funds are insufficient | `code`, `safeToRetry`, `mutationState="not_started"`, `details`, `nextActions` |
| `Run402DeployError` | `"deploy_error"` | Structured envelope from the deploy state machine (v1.34+) | `code`, `phase`, `operationId`, `safeToRetry`, `mutationState`, `nextActions` |

Project credential codes are deliberately distinct from project existence/authz. Branch on `isProjectCredentialNotFound`, `isProjectCredentialInvalid`, `isProjectCredentialExpired`, `isProjectCredentialProjectMismatch`, or the broad `isProjectCredentialError`. Gateway-returned `PROJECT_CREDENTIAL_INVALID`, `PROJECT_CREDENTIAL_EXPIRED`, and `PROJECT_CREDENTIAL_PROJECT_MISMATCH` pass through unchanged; the SDK does not rewrite them to `PROJECT_CREDENTIAL_NOT_FOUND`.

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
  await (await r.project(spec.project)).apply(spec);
} catch (e) {
  if (isPaymentRequired(e)) {
    // e is narrowed to PaymentRequired
    // present payment requirements to the user — read e.body, e.context, etc.
  } else if (isDeployError(e)) {
    // e is narrowed to Run402DeployError.
    // apply auto-retries safe BASE_RELEASE_CONFLICT races for current-base specs.
    // Log the structured envelope for policy errors, exhausted retries, or caller-owned recovery.
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
425 / 429 / 5xx / `NetworkError` / gateway-flagged `retryable`) by default.
`safeToRetry` by itself is not a retry signal; it means the repeated mutation
should not duplicate or corrupt state, not that lifecycle/payment/auth gates
will become allowed without an action. Pair retries with the SDK method's own
`idempotencyKey` so retried mutations dedup server-side:

For `r.project(spec.project).apply()`, safe `BASE_RELEASE_CONFLICT` release races are already
handled by the apply hero with a fresh plan and visible `deploy.retry`
events. Use `withRetry` for caller-owned retry policies around other operations,
or pass `maxRetries: 0` to `apply` when you want to handle deploy races
yourself.

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
    async () => (await r.project(spec.project)).apply(spec, { idempotencyKey: "deploy-2026-05-01" }),
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

This package is on the `3.x` line. The in-repo packages (`@run402/sdk`, `run402`, and `run402-mcp`) release in lockstep at the same version. Pin an exact version in production dependencies. `@run402/functions` and `@run402/astro` have independent release cadences.

## Other interfaces

`@run402/sdk` is the kernel that powers the CLI/MCP/OpenClaw edges and is used by adjacent integrations:

- [`run402`](https://www.npmjs.com/package/run402) — CLI (terminal / scripts / CI)
- [`run402-mcp`](https://www.npmjs.com/package/run402-mcp) — MCP server (Claude Desktop / Cursor / Cline / Claude Code)
- [`@run402/functions`](https://www.npmjs.com/package/@run402/functions) — in-function helper imported _inside_ deployed functions
- [`@run402/astro`](https://www.npmjs.com/package/@run402/astro) — Astro SSR, ISR cache, hosted auth, and image integration
- OpenClaw skill — script-based skill for OpenClaw agents

## Links

- HTTP API reference: <https://run402.com/llms.txt>
- CLI reference: <https://docs.run402.com/llms-cli.txt>
- Run402: <https://run402.com>

## License

MIT
