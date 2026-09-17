---
title: Script with the SDK
description: Compose typed Run402 workflows without shelling out for each operation.
order: 0
---

Use CLI by default for operations. Use the typed, opinionated SDK when writing programmatic TypeScript/JavaScript workflows: batch processing, integrations, loops and in-process error handling. Shell scripts and CI can continue using CLI.

```bash
npm install @run402/sdk@4.87.0
```

This example is checked against SDK 4.87.0 with Node 22 or later.

For Node, import `@run402/sdk/node`. It uses the local profile and configured target with the SDK's credential/payment providers. The isomorphic root entry point requires the appropriate provider/fetch setup for its environment; it does not silently acquire Node filesystem behavior.

## Bootstrap and deploy

Prepare the same complete manifest and referenced files as [Your first deploy](/start/first-deploy/). This native SDK example explicitly approves prerequisites for a requested new deployment:

```ts
import { run402 } from "@run402/sdk/node";

const r = run402();
const outcome = await r.up(
  { name: "my-app", manifest: "run402.json" },
  { approval: "yes" },
);
console.log(outcome);
```

Inspect the returned action status, deployment and verification evidence before reporting success. The SDK owns the shared workflow; it is more than a typed HTTP wrapper.

## Bind scope inside a script

```ts
import { run402 } from "@run402/sdk/node";

const r = run402();
const project = await r.project("prj_example");
const functions = await project.functions.list();
console.log(functions);
```

An explicit scope does not change the persisted active project used by other processes. Avoid `useProject` as a per-iteration mechanism when multiple scripts share profile state. For an already provisioned project's release, use scoped `apply` and the manifest/file helpers in the [SDK reference](/sdk/reference/).

## Errors and retries

Handle the exported typed errors and preserve their code, details, retry safety and operation identity. An unsafe or ambiguous mutation outcome requires inspection or resume, not an unbounded catch-and-retry loop. Payment attempts must keep the same intent/idempotency key when the contract requires it. See [SDK error types](/sdk/reference/) and the [error guide](/errors/).

```ts
import { run402, isDeployError, isRun402Error } from "@run402/sdk/node";
const r = run402();
try {
  console.log(await r.up({ manifest: "run402.json", projectId: "prj_example" }, { approval: "yes" }));
} catch (error) {
  if (isDeployError(error)) {
    console.error(error.code, error.operationId, error.safeToRetry, error.nextActions);
  } else if (isRun402Error(error)) {
    console.error(error.kind, error.message);
  }
  throw error; // Let the caller decide recovery; do not automatically repeat a mutation.
}
```
