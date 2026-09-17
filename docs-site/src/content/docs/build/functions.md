---
title: Functions and routes
description: Deploy request handlers, inspect runs and keep runtime authority explicit.
---

A Node 22 function exports a default request handler that returns a `Response`. Put its source and config in the release manifest so it activates with the app's routes and database changes. `@run402/functions` provides in-function helpers and editor types; Cloud bundles the platform's installed helper package at deployment.

```ts
export default async function handler(req: Request): Promise<Response> {
  return Response.json({ message: "hello", method: req.method });
}
```

After adding the function to your manifest:

```bash
run402 up --check
run402 up --project prj_example
run402 functions invoke hello --project prj_example --method GET
run402 functions logs hello --project prj_example
```

The example assumes the function is named `hello` in the manifest. Direct function invocation and a public routed URL are different access paths. Declaring a route does not make every invocation endpoint anonymous. Configure route/function auth intentionally; do not mistake a public reachability warning for an authorization policy.

Schedules and event triggers can create durable function runs. Inspect `fnrun_` and attempt handles, use stable idempotency keys where required, and distinguish queued work from a completed response. The [function command reference](/cli/functions/) covers list, logs, cancel and redrive. The [function-runs example](https://github.com/kychee-com/run402/tree/main/examples/kysigned-function-runs) shows a complete fixture.
