---
title: Use Run402 with your coding agent
description: Shell access, MCP-only hosts and verified skill installation.
---

A coding agent with shell access should use the CLI. Install the generic `run402` skill through [the installation router](https://run402.com/install.txt) for the runtime actually present. The router preserves a separate managed-Buzz path; do not install both skills speculatively.

```bash
npm install -g run402@latest
run402 --version
```

Then follow [Your first deploy](/start/first-deploy/). The installed skill teaches the same commands as this site. Updating the remote discovery index does not update a local copy: rerun the supported installation flow for that host and read the installed file.

## Hosts without a shell

Use the [MCP installation instructions](/mcp/reference/) and native `up` tool. Confirm which tools the host actually loaded. The local MCP server shares SDK workflows and local profile state with the CLI; the hosted discovery server has a narrower capability set. Do not infer that every CLI mutation has an MCP equivalent.

## Keep identities distinct

Your agent authenticates as its own Run402 principal. A detected client name is metadata, not proof of who authenticated or what they may do. Organization membership, grants and spending policy determine authority. See [projects and ownership](/concepts/projects/).
