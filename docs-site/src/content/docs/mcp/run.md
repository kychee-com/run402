---
title: "The run tool"
description: "Native MCP reference — run a TypeScript snippet against the SDK."
order: 15
---

## `run`: a snippet against the SDK

`run` executes a TypeScript (or JavaScript) snippet in a sandbox. The snippet sees one binding, `r`, which is the Node SDK client (`@run402/sdk/node`), plus `console` and the ECMAScript builtins. Anything the SDK can do, a snippet can do, in one call: `docs` is the reference for what `r` offers.

```json
{ "code": "const { projects } = await r.projects.list();\nprojects.filter((p) => !p.site_url).map((p) => ({ id: p.id, name: p.name }))" }
```

The source is the body of an `async` function: top-level `await` works, and the value of an explicit `return`, or else of the last expression statement, is the result. Types are stripped, not compiled, so `enum`, parameter properties, and namespaces are syntax errors. `timeout_seconds` is optional: 60 by default, at most 300.

Await every `r` chain. `r.project("prj_…").functions.list()` is recorded in the sandbox and replayed on the host only when awaited (a chain returned as the last expression is awaited for you). A result that is JSON data comes back as data. A result that is not (a scoped client from `await r.project()`, a deploy operation from `apply.start`) comes back as a handle you keep chaining from inside the same run: `const p = await r.project(); await p.functions.list()`. Read a handle's fields with `await` too.

Arguments to `r` must be data: JSON values, `undefined`, `Date`, `Uint8Array`, `Map`, `Set`, `BigInt`, or a handle. A function, a class instance, or an un-awaited chain is refused before any request (`RUN_ARGUMENT_NOT_CLONEABLE`).

The sandbox is QuickJS compiled to WebAssembly. It has no filesystem, no `process`, no `require` or `import()`, no `fetch`, and no timers; nothing is denied because none of it exists. Its globals are `r`, `console` (captured), the ECMAScript builtins, `URL`, `TextEncoder`, `TextDecoder`, `structuredClone`, and `crypto.randomUUID`. A snippet that waits uses the SDK's own bounded waiters (`r.rooms.waitForMessages`, `r.assets.waitFresh`, the deploy's own polling).

## The result

```json
{
  "status": "ok",
  "value": ["prj_a", "prj_b"],
  "value_ref": "res_…",
  "shown": 2,
  "total": 2,
  "logs": [{ "level": "log", "line": "…" }],
  "logs_ref": "res_…",
  "calls": [{ "path": "projects.list", "duration_ms": 212, "ok": true }],
  "duration_ms": 240,
  "wallet": { "local_label": "default", "address": "0x12ab…cdef" }
}
```

- `value` is the result, inline whole when its pretty-printed JSON fits in 200 lines. It is stored under `value_ref` by item, and `shown` and `total` count items: an array's elements, or for an object the rows of its largest top-level array (a SQL result's `rows`), or an object's entries as `{ key, value }`, or a string's lines. A larger value is left out as `value` and arrives as `value_window`: `{ path, items, rest? }`, the leading whole items that fit the same budget, where they live (`$`, `$.rows`, `$entries`, `$lines`), and for `$.rows` the object's other fields whole. `expand_result` with `value_ref` and `offset: shown` pages the rest by item, never by text line, without running the snippet again.
- `undefined` is reported as `value: null` with `value_kind: "undefined"`, so silence never looks like null data.
- `logs` are the captured `console.log|info|warn|error` lines, 50 inline and the rest under `logs_ref` (500 lines of 2 KB are kept).
- `calls` lists every SDK chain the run replayed: its dotted path, `duration_ms`, and `ok` or the error `code`. It is the audit trail of what the snippet did.
- `wallet` names the wallet that signed: the same one `run402 wallets current` reports for the server's environment (`RUN402_WALLET`, else the nearest `.run402.json` binding from the server's working directory, else the global default). A person's sign-in session or write approval is never used.

## Errors

On failure `status` is `"error"` and `error` is `{ code, message, next_actions }`, with `line` and `column` for a syntax error. An SDK error (a payment required, an authorization denial, a deploy error) arrives with the SDK's own `code`, `message`, and `next_actions`, unchanged, and its call is marked in `calls`. The sandbox's own codes each carry exactly one next action:

| code | when | next action |
|---|---|---|
| `RUN_SYNTAX_ERROR` | the source does not parse, or uses TypeScript that needs compiling | `edit_request` with `line`, `column` |
| `RUN_TIMEOUT` | the deadline passed; `calls` lists what completed, and those side effects happened | `edit_request`: narrow, or raise `timeout_seconds` |
| `RUN_MEMORY_EXCEEDED` | the sandbox reached 64 MB | `edit_request` |
| `RUN_VALUE_NOT_SERIALIZABLE` | the result is not JSON (a handle, a function, a BigInt, a cycle) | `edit_request` |
| `RUN_VALUE_TOO_LARGE` | the result is over 4 MB | `edit_request`: select less in the snippet |
| `RUN_ARGUMENT_NOT_CLONEABLE` | an argument to `r` is not data | `edit_request` |
| `RUN_UNKNOWN_MEMBER` | the snippet reached an `r.` path the SDK does not have | `edit_request` with `path` and `did_you_mean`: the closest public members, or, when the parent has nothing close, where that member does live (`r.project(…).sql` suggests `r.project(…).projects.sql` and `r.projects.sql`) |
| `RUN_EXCEPTION` | the snippet threw | `edit_request` |
| `RUN_BUSY` | four runs are already in flight on this server | `retry` |
| `SECRET_REQUIRES_CLI` | an SDK method refused because it returns or consumes a one-time secret | `run_cli_command` with the exact `command` |

A timeout waits for an SDK call already in flight to settle before it answers, so `calls` is complete.

## One-time secrets stay in the CLI

The snippet's client is built with the `sandbox` surface. Every SDK method whose result carries a one-time secret, or whose input is one (minting or rotating a grant key, a Handoff or Invite Key, a Room Invite Key, provisioning a project or rotating its credentials, minting a project token, creating, importing, or exporting a wallet, the Lightning wallet's pairing, redeeming any of those keys), refuses before any request with `SECRET_REQUIRES_CLI` and one next action naming the command for the same operation:

```json
{ "code": "SECRET_REQUIRES_CLI",
  "next_actions": [{ "type": "run_cli_command",
    "command": "run402 grants create 0x… --capability deploy --key --project prj_…",
    "why": "A grant key's bearer is returned once; the CLI prints it to the person who will hand it on." }] }
```

Hand the command to the person; the CLI prints the secret to them once. `run_cli_command` is the one next-action type the CLI itself never emits. The rule lives in the SDK method, not in this server, so nothing secret can reach a result or `expand_result`.

## Examples

Which projects have no site yet:

```ts
const { projects } = await r.projects.list();
projects.filter((p) => !p.site_url).map((p) => ({ id: p.id, name: p.name }))
```

A project's functions and its active release, in one call:

```ts
const p = r.project("prj_…");
const [fns, release] = await Promise.all([p.functions.list(), p.apply.getActiveRelease()]);
({ functions: fns.functions.map((f) => f.name), release_id: release.release_id })
```

Tell the team room a deploy finished:

```ts
await r.rooms.sendMessage("<org_id>", "<room_key>", { body: "deployed prj_… to production" });
```
