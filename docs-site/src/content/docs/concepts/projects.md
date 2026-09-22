---
title: Projects, organizations and ownership
description: Explicit destinations and attributable human, agent and CI actions.
---

An organization owns projects. People and agents act as distinct principals with attributable actions; membership, roles, grants, grant keys and spending policy determine authority. An agent may own the organization it founded. A person joining as co-owner is an explicit authority change.

```bash
run402 whoami
run402 projects list
run402 projects get prj_example
```

Use returned identifiers rather than guessing ownership from a display name or signing address. A deploy targets an explicit project, app-local link or manifest destination, or approved new-project creation through `--name`. Global active-project state is not enough to select a deploy destination. Conflicting selectors need correction before mutation.

## Lifecycle and transfers

Cloud lifecycle belongs to the owning organization and affects its projects. Inspect current effective status rather than inferring it from an old expiry timestamp. Transfer previews describe resources, billing and authorization changes; read them before accepting a transfer. Follow the [project/transfer reference](/cli/commands/) and rotate inherited application secrets as instructed.

## Cloud and Core

Core supplies the supported self-hosted runtime/data-plane slice. Managed Cloud identity, organizations, billing and bootstrap are separate capabilities. Do not assume a local Core target implements Cloud enrollment or payment workflows. See the [Core reference](/cli/platform/) before changing targets.
