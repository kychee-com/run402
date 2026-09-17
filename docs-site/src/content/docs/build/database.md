---
title: Database and REST
description: Ship schema and exposure in a release, then inspect data through the CLI.
---

Put durable schema changes in `database.migrations` and browser access in `database.expose` in your release manifest. Start with the complete [first-deploy example](/start/first-deploy/), then change the policy to match the app's intended readers and writers.

```bash
run402 up --check
run402 up --plan --project prj_example
run402 up --project prj_example
run402 projects sql prj_example "SELECT id, title FROM items LIMIT 10"
```

A migration ID identifies a particular SQL body. Reusing the ID with a different checksum fails; add a new migration. Inspect destructive changes and rehearsal results before applying them to a live database.

Tables are dark until exposed. `TABLE_NOT_EXPOSED` means the exposure declaration needs attention; it does not mean “add an RLS policy” blindly. On an exposed table, native PostgREST permission errors can still occur. `REST_PERMISSION_DENIED` diagnostics do not prove a particular RLS cause.

Browser code uses public project config and the user's session; server code normally uses caller-scoped `db(req)` or `db()` in the supported request context. `adminDb()` bypasses row policies and belongs only in explicitly privileged server operations. Never solve a denied browser request by shipping a service key.

See [REST and frontend examples](/cli/frontend/) and [authentication](/build/auth/) for native application code. CLI is for operating the database; the deployed app still makes runtime data requests.
