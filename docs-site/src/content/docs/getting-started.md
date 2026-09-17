---
title: Getting started
description: The CLI path from application files to a verified deployment.
---

**Use the CLI by default.** Follow [Your first deploy](/start/first-deploy/) for a complete manifest, HTML page, installation and deployment command. You do not need to choose an interface before starting.

Run commands in the intended app directory. `--name` explicitly requests a new project; an existing project can be selected with `--project`. A globally active project is not deployment intent. `-y` approves required setup for the requested deployment, not unrelated work.

The guide returns a site URL and console URL. Check the actual outcome and application behavior before reporting success. [Deployment guidance](/operate/deploy/) explains local validation, remote planning and verification.

If you are supervising an agent, a useful prompt is: “Build this app with Run402, use the CLI, show me the intended project and required spending, then verify the result and give me the site and console links.” The agent follows the same visible CLI workflow.

## Deliberate alternatives

Use the [SDK scripting guide](/sdk/scripting/) for typed loops, composition and in-process integrations. Shell scripts and CI may continue using CLI. Use [MCP](/mcp/reference/) when your host works through tools, especially without shell access. [HTTP](/reference/http/) remains available for other languages and protocol-level integrations.

Before production, understand [credentials](/concepts/credentials/), [spending](/concepts/allowances/) and [release guarantees](/concepts/releases/). Runtime errors, HTTP errors and CLI errors have different shapes; use the [error guide](/errors/).
