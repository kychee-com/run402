---
title: Examples and adoption
description: Start from complete fixtures and deploy through the CLI.
---

Use CLI to deploy and operate examples. Keep each example's application code, manifest, dependencies and verification expectations together; do not copy a command without its required files.

| Example | What it demonstrates | Start |
| --- | --- | --- |
| Static app with runtime config | Database-backed page without pasted keys | [Complete fixture](https://github.com/kychee-com/run402/tree/main/examples/static-config-js) |
| Durable function runs | Idempotent work items, schedules, status and recovery | [Function-runs fixture](https://github.com/kychee-com/run402/tree/main/examples/kysigned-function-runs) |
| Paid application endpoint | Runtime payment context and bounded caller intent | [Wallet-stats fixture](https://github.com/kychee-com/run402/tree/main/examples/tenant-x402-wallet-stats) |
| Multi-user Astro app | Hosted auth and caller-context data | [Complete notes/CMS fixture](https://github.com/kychee-com/run402/tree/main/examples/astro-notes-cms) |
| CMS with ISR | Store AssetRefs, render images and invalidate cached content | [Complete notes/CMS fixture](https://github.com/kychee-com/run402/tree/main/examples/astro-notes-cms) |
| External frontend/runtime | Run402 REST/auth as an app backend | [DreamDrop fixture](https://github.com/kychee-com/run402/tree/main/demos/dreamdrop) |

The Astro fixture pins a tested dependency set and includes a manifest, migrations, application files and local tests. Hosted auth/RLS/cache still require the documented live checks. DreamDrop includes a credential-free local demo mode; paid hosted operations have separate requirements. Start with a disposable project, define expected signed-out/signed-in results, and verify before adapting a production app.

## Adopt Run402 in an existing project

Keep the current app's ownership, credentials and production destination explicit. Add a manifest and local app link, check referenced files, inspect the plan and deploy to a separate test project first. Move schema/data deliberately; a deployment manifest is not a database export/import tool.

Use the [SDK scripting guide](/sdk/scripting/) for typed migration orchestration, [CLI deployment guide](/operate/deploy/) for release operations, and the native [HTTP reference](/reference/http/) when integrating another language. Reuse the same conceptual workflow instead of introducing a second provisioning recipe.
