---
title: "SDK reference"
description: "Native SDK reference — reference."
order: 10
---

> Package: `@run402/sdk` (npm)
> Wayfinder: https://run402.com/llms.txt
> Sibling references: CLI at https://docs.run402.com/llms-cli.txt · MCP at https://docs.run402.com/llms-mcp.txt · HTTP at https://run402.com/llms-full.txt
> Source: docs-site/src/content/docs/sdk/ in https://github.com/kychee-com/run402

The canonical agent-facing reference for the typed TypeScript SDK. Every Run402 capability is a method on a resource namespace; the CLI and MCP server are thin shims over this kernel.

**The attention model, in one sentence:** everything operationally significant is a *fact*; you read facts with a *cursor* (store and echo, never parse — a stale cursor resets, it never errors); you can request *attention* at a declared guarantee (feed-visible → opt-in rules → mandatory page that climbs); and *closure* is visible on the fact itself (acks are first-writer-wins, a replay reports the ORIGINAL, and a timed-out wait RETURNS the unsettled state — silence is an answer to look at, never consent). Learn it once on any surface (rooms, events, escalations) and you have learned them all.


Use CLI by default for operations. The SDK is the recommended surface when you're authoring programmatic TypeScript/JavaScript workflows. Fewer process boundaries than the CLI, typed error envelopes, identical behavior. If you're already in TypeScript, prefer this.

Run402 treats people and agents as first-class principals. An agent uses its own authenticator rather than borrowing a human login; identity records who acted, while organization roles, grants, delegates, freshness, and spend policy determine authority. Founder-agent ownership and human co-ownership are both legitimate states.

## Install

```bash
npm install @run402/sdk
```

Two entry points:

| Import | Use when | Bundles |
|---|---|---|
| `@run402/sdk/node` | Running in Node 22 with local profile state, project-key cache, and allowance | Auto-loads the configured API base, active project state, local project-key cache, and signs x402 payments from the selected allowance or opaque signer. Includes `r.actions.run(...)`, `r.up(...)`, `r.sites.deployDir(dir)`, `fileSetFromDir(dir)`, `loadDeployManifest(path)`, `normalizeDeployManifest(input)`, and `resolveRun402TargetProfile()`. |
| `@run402/sdk/config` | Authoring typed deploy configs that normalize to `ReleaseSpec` | Browser-safe helper descriptors and types: `defineConfig`, `dir`, `file`, `sqlFile`, `nodeFunction`, `Run402ExecutionMode`. No filesystem, env, credential, or network side effects. |
| `@run402/sdk/node/config` | Loading explicit executable deploy configs in Node | Re-exports config helpers plus `loadDeployManifest`, `loadExecutableDeployConfig`, and `normalizeDeployManifest`. |
| `@run402/sdk` | Isomorphic — Node, Deno, Bun, V8 isolates. No filesystem. | Bring your own `CredentialsProvider`. |

Node SDK requests include bounded client metadata through `Run402-Client`, such as `surface="sdk", version="3.7.14", sdk="3.7.14"`. CLI-created SDK instances use `surface="cli"`. The header is semantic version/surface metadata only: no cwd, executable path, package manager, wallet/org/project ids, secrets, or install confidence. The isomorphic entry omits the header by default to avoid browser/CORS surprises; only callers that explicitly pass `clientMetadata` opt in.

## Quick start (Node)

```ts
import { run402 } from "@run402/sdk/node";

const r = run402();
// Prepare run402.json and all referenced files from the first-deploy guide.
const result = await r.up(
  { name: "my-app", manifest: "run402.json" },
  { approval: "yes" },
);
console.log(result); // Inspect deployment and verification evidence separately.
```

The shared workflow resolves credentials and prerequisites, then deploys the manifest. See the [complete first-deploy files](https://docs.run402.com/start/first-deploy/) before running this example. Use the CLI for ordinary operations; use the SDK for typed TypeScript/JavaScript composition.
