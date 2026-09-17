---
title: Database actor context
description: Stable compatibility destination for released documentation links.
---

<h2 id="authz-version">Authorization context</h2>

Use caller-context `db()` in the runtime; retain the validated actor and authorization context supplied by the platform. Do not manufacture a user header or silently fall back to `adminDb()` after a denial. Keep cached authorization bounded by the owning helper contract. See [database and REST](/build/database/).
