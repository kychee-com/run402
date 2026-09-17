---
title: Storage and assets
description: Upload assets, retain their returned identity and control public visibility.
---

Use the CLI to upload and inspect files; use the manifest's asset slice when assets must activate with a release. Start with the [asset command reference](/cli/assets/) for the installed command's supported inputs.

```bash
run402 assets put ./hero.png --project prj_example
```

The result is an AssetRef: retain the full returned reference, including variants and immutable identities, when storing it in application data. Do not reconstruct an immutable or variant URL from a logical key. Public and private visibility are explicit; an immutable object URL is not permission to reveal private content.

For a declared site, `site.public_paths` and route aliases determine reachable filenames. Diagnose a URL against the release and host rather than assuming the backing filename is public. See [deployment diagnostics](/operate/diagnostics/).

Directory sync/prune changes more than an additive upload. Read the plan, scope the prefix and review deletion confirmation. If remote state drifts, obtain a new plan rather than reusing stale confirmation. Runtime file uploads use the native helpers described in the [function reference](/cli/functions/); they are application code, not CLI operating steps.

## Read the result and recover

The CLI prints the wire AssetRef with snake_case fields, such as `immutable_url`, `size_bytes` and `content_type`; SDK camelCase aliases are not additional CLI output fields. Keep that returned object. A missing input file is a local error: fix the path before retrying. For a remote error, inspect `code`, mutation state and next actions before repeating an upload or pruning a prefix. The CLI output-contract fixture covers the successful upload shape without a production write.
