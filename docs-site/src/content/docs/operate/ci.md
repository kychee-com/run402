---
title: GitHub Actions deployments
description: Bind one workflow to a project using short-lived OIDC credentials.
---

Use the CLI to create the binding and workflow for an existing intended project:

```bash
run402 ci link github --project prj_example --repo owner/repository --branch main
run402 ci list --project prj_example
```

Inspect the generated workflow before committing it. The binding constrains repository/ref and allowed deployment authority; route declarations need their own allowed scope. Avoid broadening scopes merely to make a failed job pass.

The workflow exchanges GitHub OIDC with `id-token: write`; it does not require copying a local allowance file or service key into GitHub secrets. Keep destination selectors consistent. The [CI reference](/cli/commands/) describes environment bindings, expiry and revocation.

Run the application's build and relevant checks before deployment. Preserve deployment/verification output as sanitized evidence; do not report a successful build as a deployed app. CLI remains suitable for CI even though the SDK is available for richer programmatic composition.
