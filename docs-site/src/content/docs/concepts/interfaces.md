---
title: API, SDK, CLI and MCP
description: One API foundation, shared typed workflows, and machine-friendly adapters.
---

**Use the CLI by default** for provisioning, deploy, inspection and recovery.

```text
CLI: shell, agent loop, CI       MCP: tool-native hosts
             \                   /
              Typed, opinionated SDK
              composition and shared workflows
                         |
                      HTTP API
```

The HTTP API is the foundation. It defines authorization, resource operations, remote policy, release details and response contracts. Its [reference](/reference/http/) is complete for deliberate integrations.

The SDK adds typed inputs/results/errors and shared workflow behavior: local manifest handling in the Node entry point, bootstrap, deploy orchestration, rehearsal decisions and bounded safe retries. It is useful when a program must compose operations without starting a process for each call. Use the [scripting guide](/sdk/scripting/).

The CLI and MCP are thin adapters over the SDK. They parse inputs and present results for their hosts. CLI JSON, exit codes and streaming modes work well in agent loops and CI. MCP tool schemas work well in tool-native hosts. Shared implementation does not promise every capability exists on every adapter or that every output envelope is identical.

General operating examples use CLI. SDK references contain TypeScript; MCP references contain tool calls; HTTP references contain HTTP. Application examples retain HTML, SQL, Astro and function code because those are the program being deployed.
