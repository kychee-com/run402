---
title: Authentication and row security
description: Separate application users, project exposure and infrastructure authority.
---

An app's users are tenant actors. An agent deploying it is a control-plane principal. Keep their sessions and permissions separate. Exposure determines whether a table is reachable; RLS determines which rows an actor can access.

For Astro, use the hosted auth components and `auth.*` helpers from the [Astro guide](/build/astro/). For non-Astro applications, use the documented hosted routes/session flow or bearer-token flow in the [frontend reference](/cli/frontend/). Match the chosen lane's cookie, CSRF, freshness and redirect behavior; do not mix credential shapes.

Ship the schema and exposure policy in the manifest, then deploy explicitly:

```bash
run402 up --check
run402 up --project prj_example
run402 doctor --dir .
```

Verify signed-out and signed-in reads/writes separately, using the expected HTTP status for each. A UI visibility gate is not server authorization. Privileged writes need server-side role/membership checks; session freshness is a separate requirement for sensitive operations.

Inside functions, use the current `auth.user`, `auth.requireUser`, `auth.requireRole`, `auth.requireMembership` and `auth.requireFresh` exports. Use the documented `auth` namespace; do not invent `auth.getUser` or `auth.protect`. Legacy top-level `getUser(req)` remains a separate compatibility API. Read the [function helper reference](/cli/functions/) before composing a runtime example.
