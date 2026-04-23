# @run402/sdk

Typed TypeScript client for the [Run402](https://run402.com) API.

This package is the kernel shared by the `run402-mcp` MCP server, the `run402` CLI, and user-deployed run402 functions. It exposes every run402 API operation as a method on a resource namespace (`sdk.projects.provision()`, `sdk.blobs.put()`, `sdk.functions.deploy()`, etc.).

## Install

```bash
npm install @run402/sdk
```

## Quick start (Node)

The `/node` subpath provides zero-config defaults: reads credentials from the existing `~/.config/run402/` keystore and auto-retries x402 payments from your local allowance.

```typescript
import { run402 } from "@run402/sdk/node";

const r = run402();
const project = await r.projects.provision({ tier: "prototype" });
await r.blobs.put(project.id, "hello.txt", "hello world");
```

## Quick start (isomorphic / sandbox)

The root entry is isomorphic — no filesystem access, no Node-only imports. Supply your own `CredentialsProvider`:

```typescript
import { Run402 } from "@run402/sdk";

const r = new Run402({
  apiBase: "https://api.run402.com",
  credentials: {
    async getAuth(path) {
      return { Authorization: `Bearer ${mySessionToken}` };
    },
    async getProject(id) {
      return mySessionProjects[id] ?? null;
    },
  },
});
```

## Stability

This package is `0.x`. Breaking changes may occur between minor versions until `1.0`. Pin an exact version in production dependencies until stabilization.

## Errors

All failures throw subclasses of `Run402Error`:

- `PaymentRequired` — HTTP 402, carries the x402 payment requirements
- `ProjectNotFound` — project ID not in the credential provider
- `Unauthorized` — HTTP 401 / 403
- `ApiError` — other non-2xx responses
- `NetworkError` — fetch rejected with no HTTP response

```typescript
import { PaymentRequired } from "@run402/sdk";

try {
  await r.projects.provision({ tier: "prototype" });
} catch (e) {
  if (e instanceof PaymentRequired) {
    console.log("needs funding:", e.body);
  } else throw e;
}
```
