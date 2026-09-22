---
title: "MCP reference"
description: "Native MCP reference — reference."
order: 10
---

> Package: `run402-mcp` (npm)
> Connect via: Claude Desktop / Cursor / Cline / Claude Code
> Remote (no install, free discovery tools only): streamable-http at https://mcp.run402.com/mcp — `run402_quickstart` · `x402_price_check` · `experiment_scoreboard`. The remote never handles funds; every paid tool below requires this local server (it holds YOUR wallet).
> Wayfinder: https://run402.com/llms.txt
> Sibling references: SDK at https://docs.run402.com/llms-sdk.txt · CLI at https://docs.run402.com/llms-cli.txt · HTTP at https://run402.com/llms-full.txt
> Source: docs-site/src/content/docs/mcp/ in https://github.com/kychee-com/run402

This file is canonical reference for the `run402-mcp` MCP server's tool surface. Every action is an MCP tool call — natural-language framings work because the schemas are loaded into your context by the host.

If you're an MCP-host agent that already has the run402-mcp tools available, this is your reference. If you don't have the tools loaded, install the server first (instructions at the bottom).

Run402 treats you as a first-class participant acting through your own principal and authenticator, not as an invisible process borrowing a human account. Identity records who acted; organization roles, grants, grant keys, freshness, and spend policy determine what you may do. Founder-agent ownership is legitimate, while an agent entering somebody else's organization uses bounded authority.

## Mental model

`run402-mcp` is a thin shim over [`@run402/sdk`](https://docs.run402.com/llms-sdk.txt). Each MCP tool is a schema-parsing wrapper around an SDK method. The configured API target, active project state, allowance, and local project-key cache are shared with the CLI; provisioning a project from any surface makes its `anon_key` and `service_key` available to credential-required operations without treating cached keys as project inventory.

Public Buzz/Nostr identity links are deliberately **not** an MCP mutation tool. Agent creation uses the CLI/SDK EOA ceremony; human creation/revocation uses the normal browser/passkey/Buzz flow at <https://console.run402.com/identity-links/connect>. MCP never asks for a raw signed event, Nostr private key, passkey, session credential, or resource id. Existing reads render every returned active/revoked link with its `identity_link_id`, subject, proof protocol, and lifecycle, explicitly as public attribution rather than organization authority. Project/deploy/transfer reads preserve immutable actor provenance. Unknown future principal/authenticator/authority/proof kinds remain data.

Buzz human-adoption offers/attempts, community installation, and agent enrollment are also intentionally not MCP mutation tools. `whoami` renders their independent capability/state, including a current normal HTTPS ownership transfer and exact `run402 buzz adopt offer show …` poll command; project reads identify enrollment provenance. MCP never receives a human sign-in session, passkey step-up, or Buzz signing capability. A durable offer is inert and a click is not completion. Authoritative completed polling distinguishes the terminal consent receipt, public human identity attribution, and ordinary membership; only membership grants org authority, and link/membership revocation are independent.

Tools that require payment (`provision_postgres_project`, `set_tier`, `deploy`, `generate_image`) return 402 payment details as informational text (not an error) — the LLM should reason about cost, guide the user through funding if needed, and retry the same tool call.

After a successful purchase, `generate_image` reports what actually settled —
amount, network and transaction — and, when the settlement network is a testnet,
states plainly that it was **not a real payment** and cannot appear on the wall.
This matters because `init` faucet-funds Base Sepolia: without it an agent can
watch a payment succeed and never learn it moved test money. The testnet verdict
is read from the settlement receipt, not from local wallet config, so an agent
holding mainnet USDC is never told its real payment was fake. `pay_url` reports
the same events for arbitrary sellers.

`pay_url` is the general x402 buyer tool for external HTTP(S) endpoints. Params:
`url`, optional `method`, `body`, `idempotency_key`, `max_usd_micros`
(default `100000`, or $0.10), and `require_receipt`. It grant keys to SDK
`pay.fetch`. `require_receipt: true` requires a verified wallet-rooted offer
before payment and a matching receipt afterward. Structured content is the
complete `x402-commerce-result.v1` envelope; the text view curates amount and
destination, settlement, movement/replay, merchant receipt, signer
relationship, and policy. Portable evidence is preserved, but payment proofs,
cookies, authorization headers, bodies, private keys, and tenant secrets are
never cached. On trusted Run402
`PAYMENT_INTENT_PENDING`, wait for `Retry-After` and call `pay_url` again with
the same payer, identical arguments, and the same `idempotency_key`; never
substitute a new key. Custom/arbitrary hosts remain ambiguous. The live SDK
instance can also re-present its original in-memory proof.

## Quickstart

Use the CLI by default when your host has a shell. This native reference is for MCP hosts. With the local server configured, prepare the complete manifest and referenced app files from [Your first deploy](https://docs.run402.com/start/first-deploy/), then call `up` with `name: "my-app"`, the manifest path, and explicit approval for the required setup. The tool calls the shared SDK `up` action. Its schema is authoritative for input names. Inspect deploy status and verification evidence before reporting success.

`deploy`, `provision_postgres_project`, `run_sql`, `apply_expose` and `deploy_site_dir` are advanced primitives, not a second cold-start recipe. Some CLI mutations deliberately have no MCP tool.

Call `up` with these schema-checked arguments after preparing the files:

<!-- example: mcp-up -->
```json
{ "name": "my-app", "manifest": "run402.json", "yes": true }
```

`yes` approves the required setup for this requested deploy; it is not permission to broaden project scope. For an existing destination, pass `project_id` instead of requesting creation with `name`.
