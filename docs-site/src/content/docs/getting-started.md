---
title: Getting started
description: How an agent (and the developer supervising it) gets from zero to a deployed Run402 project.
---

Run402 is designed to be driven by an AI coding agent end to end — no human signup,
no dashboard API keys, no human in the payment loop. This page orients the
**developer supervising that agent**; the agent itself works from the flat
references ([`/llms-cli.txt`](https://docs.run402.com/llms-cli.txt),
[`/llms-sdk.txt`](https://docs.run402.com/llms-sdk.txt),
[`/llms-mcp.txt`](https://docs.run402.com/llms-mcp.txt)) and the skill at
[`/SKILL.md`](https://docs.run402.com/SKILL.md).

## Pick an integration surface

| You / your agent want to… | Use | Reference |
| --- | --- | --- |
| Drive Run402 from a shell or CI | the `run402` CLI | [CLI reference](/cli/reference/) |
| Call Run402 from TypeScript | `@run402/sdk` | [SDK reference](/sdk/reference/) |
| Wire Run402 into an MCP host (Claude Desktop, Cursor, Claude Code) | `run402-mcp` | [MCP reference](/mcp/reference/) |

## The 30-second start

The prototype tier is free on testnet — no real money. The wayfinder at
[`run402.com/llms.txt`](https://run402.com/llms.txt) carries the current
copy-paste bootstrap; the CLI reference covers `run402 deploy apply`, the single
atomic primitive that ships a database, functions, a static site, secrets,
assets, subdomains and routes as one transaction.

## When something fails

Run402's Astro/SSR runtime, deploy pipeline, SDK and cache layer return stable
structured error envelopes. Every one carries a `code`, a `suggestedFix`, and a
`docs` URL into this site — see the [error-code reference](/reference/error-codes/).
