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

## Namespaces (19)

| Namespace | Highlights |
|---|---|
| `projects` | `provision`, `delete`, `list`, `getUsage`, `getSchema`, `info`, `keys`, `use`, `pin` |
| `deploy` | **The unified deploy primitive (v1.34+).** `apply` / `start` / `resume` / `status` / `getRelease` / `diff` / `plan` / `upload` / `commit` |
| `sites` | `deploy` (inline files), `getDeployment`, plus `deployDir` on the Node entry |
| `blobs` | `put` (returns `AssetRef` with `cdn_url`/`sri`/`etag`), `get`, `ls`, `rm`, `sign`, `diagnoseUrl`, `waitFresh` |
| `functions` | `deploy`, `invoke`, `getLogs`, `update`, `list`, `delete` |
| `secrets` | `set`, `list`, `delete` |
| `subdomains` | `claim`, `list`, `delete` |
| `domains` | `add`, `list`, `status`, `remove` |
| `email` | `createMailbox`, `sendEmail`, `listEmails`, `getEmail`, `getEmailRaw`, `webhooks.*` |
| `senderDomain` | `register`, `status`, `remove`, `enableInbound`, `disableInbound` |
| `auth` | `magicLink`, `verifyMagicLink`, `setUserPassword`, `settings`, `providers` |
| `apps` | `browse`, `get`, `fork`, `publish`, `versions.*`, `bundleDeploy` (legacy shim → routes through `deploy`) |
| `tier` | `set`, `status`, `quote` |
| `billing` | `createEmailAccount`, `linkWallet`, `tierCheckout`, `buyEmailPack`, `setAutoRecharge`, `balance`, `history`, `createCheckout` |
| `contracts` | `provisionWallet`, `getWallet`, `listWallets`, `setRecoveryAddress`, `setLowBalanceAlert`, `call`, `read`, `getCallStatus`, `drainWallet`, `deleteWallet` |
| `ai` | `translate`, `moderate`, `usage` |
| `allowance` | `status`, `create`, `export`, `requestFaucet`, `checkBalance` |
| `service` | `status`, `health` (no auth, no setup — works on a fresh install) |
| `admin` | Admin-only endpoints (pinning, lifecycle reactivation, dispute resolution) |

## Patterns

### Paste-and-go assets — content-addressed URLs with SRI

`r.blobs.put` returns an `AssetRef`. The `cdn_url` is content-addressed (`pr-<public_id>.run402.com/_blob/<key>-<8hex>.<ext>`), served through CloudFront, and never needs cache invalidation. The browser refuses execution on byte mismatch via SRI:

```ts
const logo = await r.blobs.put(projectId, "logo.png", { bytes });
//   logo.cdn_url   → drop into <img src="…">
//   logo.sri       → "sha256-…" for <script integrity="…">
//   logo.etag      → strong "sha256-<hex>"
//   logo.cache_kind → "immutable" | "mutable" | "private"
```

`immutable: true` is the default since v1.45 — pass `false` only when you specifically want to skip the SHA-256 pass on a very large upload.

### Unified deploy (v1.34+) — `r.deploy.apply`

The canonical primitive for any deploy (database + migrations + manifest + secrets + functions + site + subdomain). Three layers:

```ts
// One-shot — most agents use this.
const result = await r.deploy.apply(spec);

// Long-running with progress events.
const op = await r.deploy.start(spec);
for await (const e of op.events()) console.log(e.phase);
const final = await op.result();

// Resume a previously-started deploy by id.
const resumed = await r.deploy.resume(operationId);
```

- **All bytes ride through CAS.** The plan request body never carries inline bytes — only `ContentRef` objects. When the spec exceeds 5 MB JSON, the SDK uploads the manifest itself as a CAS object (`manifest_ref` escape hatch).
- **Replace vs patch semantics per resource.** `site.replace` = "this is the whole site" (files absent are removed); `site.patch.put` / `patch.delete` = surgical updates. Same shape for `functions`, `secrets`, `subdomains`. Top-level absence = leave untouched.
- **Server-authoritative manifest digest** — no byte-for-byte canonicalize requirement on the client.
- The Node entry adds `fileSetFromDir(path)` for filesystem byte sources:

  ```ts
  import { run402, fileSetFromDir } from "@run402/sdk/node";
  const r = run402();
  await r.deploy.apply({
    project_id,
    site: { replace: { files: await fileSetFromDir("./dist") } },
    subdomains: { replace: [{ name: "my-app" }] },
  });
  ```

### Errors

All failures throw subclasses of `Run402Error`:

| Class | When | Notable fields |
|---|---|---|
| `PaymentRequired` | HTTP 402 | x402 payment requirements |
| `ProjectNotFound` | Project ID not in the credential provider | — |
| `Unauthorized` | HTTP 401 / 403 | — |
| `ApiError` | Other non-2xx responses | `status`, `body` |
| `NetworkError` | Fetch rejected with no HTTP response | — |
| `LocalError` | Local-host issues (filesystem, signing) | — |
| `Run402DeployError` | Structured envelope from the deploy state machine (v1.34+) | `code`, `phase`, `operation_id`, `safe_to_retry`, `mutation_state`, `next_actions` |

Branch on the structured fields, not English `message` text:

```ts
import { PaymentRequired, Run402DeployError } from "@run402/sdk";

try {
  await r.deploy.apply(spec);
} catch (e) {
  if (e instanceof PaymentRequired) {
    // present payment requirements to the user
  } else if (e instanceof Run402DeployError && e.safe_to_retry) {
    // safe to retry — same idempotency key
  } else throw e;
}
```

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
