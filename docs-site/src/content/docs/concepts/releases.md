---
title: Releases and recovery
description: Desired state, staged activation, explicit warnings and migration effects.
---

A release describes desired application state: database migrations/exposure, functions, static content, routes, assets and required secrets. The SDK prepares content and coordinates planning, staging and activation against the gateway's verdicts.

`replace` and `patch` have different effects. Omitted slices can carry state forward; do not treat omission as deletion. Read the [ReleaseSpec reference](/cli/deploy/) before synchronizing or pruning resources.

```bash
run402 up --check
run402 up --plan --project prj_example
run402 up --project prj_example
run402 deploy release active --project prj_example
```

A local check validates local inputs and reports deferred checks; it is not gateway validation. Planning determines remote policy, changes and warnings. Review any requested approvals. `--allow-warnings` approves broadly; prefer reviewing and allowing individual warning codes when appropriate.

Activation selects the staged release. SQL migration effects are not automatically reversed when you promote an older release. Failed work can be resumable; follow the operation handle and recovery guidance instead of starting a duplicate mutation. Bounded SDK retries apply only to conditions marked safe; a timeout alone is not permission to retry.

Automatic migration rehearsal is governed by the current plan, including skip reasons for a first deploy or unchanged migrations. Verification then checks application responses and serving evidence. An activated release, a pending edge and a verified app are distinct outcomes. See [deploy and verify](/operate/deploy/).
