---
title: Choose a coding harness
description: Run402 is driven by a tool-using coding agent with shell access. Here's what a harness needs and which ones work.
---

Run402 is built and operated by a **coding agent** — a tool-using AI with shell
access that reads the wayfinder, runs the CLI, and deploys. You supervise; the
agent executes.

## What a harness needs

- **Shell access** to run `npx run402 …`.
- The ability to **read URLs**, to fetch [run402.com/llms.txt](https://run402.com/llms.txt) and the references.
- Enough autonomy to **iterate**: provision → build → deploy → verify.

## Harnesses that work

- **Claude Code** — terminal-native, with shell and file tools.
- **Cursor / VS Code agents** — editor-integrated, with a shell.
- Any agent runtime with shell access and the ability to fetch a URL.

You don't pre-configure credentials. The agent discovers everything it needs from
the [wayfinder](https://run402.com/llms.txt) and the
[skill](https://docs.run402.com/SKILL.md), and bootstraps a free prototype
allowance on its own.
