---
title: Logs and diagnostics
description: Start with a scoped check or an actual request ID.
---

```bash
run402 doctor --dir .
run402 logs --request-id req_example --project prj_example
run402 functions logs hello --project prj_example
```

Replace example identifiers with actual returned IDs. Doctor reports `ok`, `blocking`, `warnings` and `checks`; `ok` means no blocking findings in the performed scope. A skipped or deferred check is not a pass. Scope a monorepo check to the intended app so unrelated files do not become false blockers.

Request-ID lookup can fan out across functions. App logs are the normal view; use the documented origin filters when platform output is needed. Do not paste secrets from logs into public issues.

For a wrong or stale URL, use `run402 deploy diagnose --help` and `run402 deploy resolve --help`, then the exact host/path and project. Inspect the active release, route match, public-path authorization and edge evidence. A hidden backing filename can be correct when an alias is the public path.

See the [ops reference](/cli/ops/) and [error guide](/errors/). A current incident correlation is useful context, not proof that your app is blameless.
