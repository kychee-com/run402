---
title: Functions and routes
description: Deploy request handlers, inspect runs and keep runtime authority explicit.
---

A Node 22 function exports a default request handler that returns a `Response`. Put its source and config in the release manifest so it activates with the app's routes and database changes. `@run402/functions` provides in-function helpers and editor types; Cloud bundles the platform's installed helper package at deploy.

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

Each tier caps a function's code size: `run402 projects quote` names it as the tier's max function bundle. The cap applies to the uncompressed bytes of the source you deploy, before the platform bundles it with `@run402/functions` and any `--deps`. A function over the cap is refused when the plan is created, with `TIER_LIMIT_EXCEEDED` naming the cap and the size. Bundle and minify large sources yourself before deploying.

The example assumes the function is named `hello` in the manifest. Direct function invocation and a public routed URL are different access paths. Declaring a route does not make every invocation endpoint anonymous. Configure route/function auth intentionally; do not mistake a public reachability warning for an authorization policy.

Schedules and event triggers can create durable function runs. Inspect `fnrun_` and attempt handles, use stable idempotency keys where required, and distinguish queued work from a completed response. The [function command reference](/cli/functions/) covers list, logs, cancel and redrive. The [function-runs example](https://github.com/kychee-com/run402/tree/main/examples/kysigned-function-runs) shows a complete fixture.

## Let a person's assistant use the app

Every app is an MCP server at `https://<host>/_run402/mcp`, so the assistant of someone who uses your app (ChatGPT, Claude, Codex) can act in it as them. Declare what it may call beside the handler that already does the work:

```ts
export const tools = {
  list_events: { method: "GET", path: "/api/events", description: "List upcoming events.",
    input: { type: "object", properties: { limit: { type: "integer" } } } },
  create_event: { description: "Create an event.",
    input: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
};
```

Each entry names a request the function answers, so a call goes through the function's own route, gates, price and logs, and a `GET` is listed read-only. Every value is a literal: `run402 up` reads the export by parsing the source, never by running it, and carries it in the release, which is the only place the platform looks.

```bash
run402 up --plan --project prj_example     # diff.tools lists what would be added, removed or changed
run402 up --project prj_example            # urls.mcp in the result is the URL to give the person
```

The [function command reference](/cli/functions/) has the full rules under "Make a function an MCP tool", and [errors](/errors/) explains each `MCP_TOOL_*` refusal.

## Read the result and recover

Invocation prints the function response; logs are a separate operation. An authorization failure requires correcting the caller or declared gate, not removing authentication. A runtime failure requires the returned request ID and application logs. If deploy fails, inspect its stage before invoking: uploading code alone is not evidence of activation. Use `run402 functions invoke --help` for request-body file options and keep secrets out of arguments.
