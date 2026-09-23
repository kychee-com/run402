---
title: "MCP reference"
description: "Native MCP reference — eight tools and the run snippet form."
order: 10
---

> Package: `run402-mcp` (npm)
> Connect via: Claude Desktop / Cursor / Cline / Claude Code
> Remote (no install, free discovery tools only): streamable-http at https://mcp.run402.com/mcp — `run402_quickstart` · `x402_price_check` · `experiment_scoreboard`. The remote never handles funds; paying and deploying need this local server (it holds YOUR wallet).
> Wayfinder: https://run402.com/llms.txt
> Sibling references: SDK at https://docs.run402.com/llms-sdk.txt · CLI at https://docs.run402.com/llms-cli.txt · HTTP at https://run402.com/llms-full.txt
> Source: docs-site/src/content/docs/mcp/ in https://github.com/kychee-com/run402

This file is the canonical reference for the `run402-mcp` MCP server. If your host already has the run402-mcp tools loaded, this is your reference; if not, install the server first (the Install section below).

Run402 treats you as a first-class participant acting through your own principal and authenticator, not as an invisible process borrowing a human account. Identity records who acted; organization roles, grants, grant keys, freshness, and spend policy determine what you may do.

## Eight tools, and everything else is a snippet

`run402-mcp` registers exactly eight tools:

| Tool | What it does |
|---|---|
| `up` | The first deploy: any missing setup (wallet, tier, project, workspace link), then the deploy. Returns the `run402.up.result` envelope. |
| `deploy` | Applies a ReleaseSpec to a project (`r.project(id).apply`). Returns the `DeployResult`. |
| `status` | `r.status()`: the wallet this server acts as (`local_label`, `server_label`, address), tier and lease, allowance, projects, active project. |
| `whoami` | `r.orgs.whoami()`: the remote principal, its authenticators, org memberships, and sign-in session grade. |
| `doctor` | `r.doctor()`: `{ ok, blocking[], warnings[], checks[] }`. |
| `docs` | The SDK reference and the `run` primer, shipped in this package. |
| `run` | Runs a TypeScript snippet against the SDK in a sandbox. |
| `expand_result` | Pages a stored result (`ref`, `offset`, `limit`). |

There is no tool per operation. Anything the SDK can do is one `run` call: the snippet gets `r`, the Node SDK client (`@run402/sdk/node`), and composes what it needs, so listing, filtering, and joining happen in code instead of across tool calls. `docs` answers "what does `r` offer" from the reference that ships with the SDK the snippet runs against; `docs({ topic: "assets" })` is one namespace, and `docs({ search: "waitForMessages" })` finds a section by content.

```json
{ "code": "const { projects } = await r.projects.list();\nprojects.map((p) => ({ id: p.id, name: p.name, site: p.site_url }))" }
```

A `run` result carries the value, the captured `console` lines, and `calls[]`, the SDK chains the snippet made, with the wallet that signed them. Large values are stored whole by item and their leading whole items arrive in `value_window`; `expand_result` pages the rest by item. The contract, limits, and error codes are in the `run` section below.

## Structured results

Every tool returns two channels. `content` is the text a model reads. `structuredContent` is one JSON object a host reads, and each tool declares its shape as an `outputSchema`. The text block's fenced JSON is that same object, so the two channels never disagree, and a host never has to parse Markdown.

Every structured result has `status: "ok" | "error"`:

| Tool | On `ok` |
|---|---|
| `run` | The run envelope: `value`, or for a large value `value_window` (its leading whole items) with `value_ref`, `shown`, `total`; `logs`, `calls`, `duration_ms`, `wallet` |
| `up`, `status`, `whoami`, `doctor` | `result`: the SDK object the tool returns |
| `deploy` | `result`: the `DeployResult`; `events`: the progress events |
| `expand_result` | `ref`, `kind`, `offset`, `shown`, `total`, `items` |
| `docs` | `kind`, `ref`, `shown`, `total`, `lines` |

On failure, `isError` is true and `error` holds `code`, `message`, and `next_actions`, plus `category`, `retryable`, `safe_to_retry`, `http_status`, `mutation_state`, `trace_id`, and `details` when the error supplies them. A `deploy` error adds `phase`, `resource`, `operation_id`, `plan_id`, `fix`, and up to 50 `logs` lines, with `events` and `warnings` beside `error`. An SDK or gateway error keeps its own code. A local failure gets one of these codes: `PROJECT_NOT_FOUND`, `PROJECT_CREDENTIAL_NOT_FOUND`, `WALLET_NOT_FOUND`, `NETWORK_ERROR`, `RESULT_REF_NOT_FOUND`, `DOCS_TOPIC_NOT_FOUND`, or `INTERNAL_ERROR`.

The schemas are open: they name the fields a host branches on, and any other field passes through. Branch on `status` and `error.code`; follow `error.next_actions`.

## One-time secrets stay in the CLI

Operations that return or consume a one-time secret (minting or rotating a grant key, a Handoff or Invite Key, a Room Invite Key, provisioning a project or rotating its credentials, minting a project token, creating, importing, or exporting a wallet, the Lightning wallet's pairing, redeeming any of those keys, a person's sign-in session) refuse inside `run` with `SECRET_REQUIRES_CLI`. The refusal happens in the SDK method before any request and carries one next action, `{ "type": "run_cli_command", "command": "run402 …" }`, the exact command for the same operation. Hand that command to the person; the CLI prints the secret to them once. Nothing secret reaches a result or `expand_result`. `up` still provisions a project for a first deploy: it saves the keys to the local key cache and never prints them.

## Authority

This server authenticates as the active wallet, resolved as the CLI resolves it with no flag: `RUN402_WALLET`, else the nearest `.run402.json` binding from the server's working directory, else the global default (`run402 wallets use`), else `default`. `status` and every `run` result name it. A person's cached sign-in session or write approval is never used: MCP authenticates as the agent. Snippet requests carry client metadata surface `sandbox`; the fixed tools carry `mcp`.

Public Buzz/Nostr identity links, Buzz human-adoption offers, community installation, and agent enrollment sign through Buzz's own boundary: the SDK reads them from `run`, and the signing steps are CLI commands (`run402 identity link`, `run402 buzz adopt offer`). `whoami` renders their state; a durable offer is inert and a click is not completion.

## Paying

Paid calls (a tier, image generation, an x402 URL through `r.pay.fetch`) pay automatically from the wallet: x402 (USDC on Base), MPP on Tempo, or MPP on Bitcoin Lightning. A 402 the wallet cannot cover comes back as the SDK's `PaymentRequired` error with its `next_actions`, from `run` and `deploy` alike (an error result with `error.code` set); reason about the cost, guide the person through funding, and run the same call again.

`r.pay.fetch(url, init?, { maxUsdMicros, idempotencyKey, requireReceipt })` is the general x402 buyer for external HTTP(S) endpoints (`maxUsdMicros` defaults to `100000`, $0.10). `requireReceipt: true` requires a verified wallet-rooted offer before payment and a matching receipt afterward. The result is the complete `x402-commerce-result.v1` envelope; settlement names the network it was read from, so a testnet payment is reported as test money, never as a real payment. On trusted Run402 `PAYMENT_INTENT_PENDING`, wait for `Retry-After` and call again with the same payer, identical arguments, and the same idempotency key.

## Quickstart

Use the CLI by default when your host has a shell. This native reference is for MCP hosts. With the local server configured, prepare the complete manifest and referenced app files from [Your first deploy](https://docs.run402.com/start/first-deploy/), then call `up` with `name: "my-app"`, the manifest path, and explicit approval for the required setup. The tool calls the shared SDK `up` action. Its schema is authoritative for input names. Inspect deploy status and verification evidence before reporting success.

`deploy` is the advanced primitive for a spec you built yourself, not a second cold-start recipe.

Call `up` with these schema-checked arguments after preparing the files:

<!-- example: mcp-up -->
```json
{ "name": "my-app", "manifest": "run402.json", "yes": true }
```

`yes` approves the required setup for this requested deploy; it is not permission to broaden project scope. For an existing destination, pass `project_id` instead of requesting creation with `name`.
