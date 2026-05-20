---
name: publish-astro
description: Publish @run402/astro to npm from this monorepo. Use when the user says /publish-astro or asks to publish the Astro integration package. Covers version bump, tarball smoke test, publish, tag, and post-publish verification.
---

# /publish-astro

This skill wraps the repo's Claude publish-astro command.

When invoked, read `../../commands/publish-astro.md` and follow it exactly. Treat that file as the source of truth for the publish workflow, including its pre-flight checks, version-bump rules, tarball smoke test, publish step, and post-publish verification.

If `../../commands/publish-astro.md` is missing or unreadable, stop and report that the command source is missing.
