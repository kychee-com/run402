---
title: Deploy, inspect and verify
description: Local checks, remote plans, activation and application evidence.
---

Operate from the app directory. Use the app-local link or explicit project; a global active project is never enough to choose a deploy target.

```bash
run402 up --check
run402 up --plan --project prj_example
run402 up --project prj_example --verify
run402 up verify --project prj_example
run402 deploy releases active --project prj_example
```

`--check` validates local files/input and reports deferred remote checks. It neither proves the build succeeds nor grants remote policy approval. `--plan` lets you review intended changes; use the documented plan-bound apply workflow when an exact reviewed plan is required.

A release activates after its required stages. Read warnings and error metadata. Approve only the changes you intend; a broad warning bypass is not the default remedy for an unfamiliar warning.

Verification has its own evidence and timing. `propagation_pending`, inconclusive evidence and a failed HTTP expectation are not successful verification. A valid non-coherent report can exit 2. `up verify` reruns checks without redeploying. Match response status/body expectations to the app; an expected authorization denial is not a platform failure.

For recovery, retain operation/release IDs, inspect status and follow the documented resume or promotion path in [the deploy reference](/cli/deploy/). Promotion changes the selected release; it does not undo applied SQL migrations. Manual provision/plan/commit commands are advanced primitives under the shared `up` workflow.

## Promote a prior release

Inspect the candidate release and its compatibility warnings before changing the active pointer:

```bash
run402 deploy releases get rel_previous --project prj_example
run402 deploy promote rel_previous --project prj_example
run402 up verify --project prj_example
```
`rel_previous` is a placeholder for a real release in that project. Promotion does not rewind database migrations or external side effects. A warning requiring confirmation needs the specific reviewed `--allow-warning <code>`; broad warning approval is not a substitute for understanding compatibility.
