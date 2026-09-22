---
title: Domains and public URLs
description: Bind a hostname, verify routing and preserve domain ownership.
---

Use the returned deploy URL for the first app. A custom hostname adds DNS, ownership and routing setup; it is not a prerequisite for first deploy.

```bash
run402 domains connect app.example.com --project prj_example --web
run402 domains dns app.example.com --project prj_example
run402 domains check app.example.com --project prj_example
run402 domains status app.example.com --project prj_example
run402 subdomains list --project prj_example
```

Use the [domain command reference](/cli/assets/) for the supported registration, delegation and binding workflow. Inspect every requested DNS/nameserver change and preserve existing mail records. Wait for the authoritative status rather than assuming a successful request means DNS and TLS have converged.

A release can be activated while a host's edge state is still pending. Use [deploy verification](/operate/deploy/) and [URL diagnostics](/operate/diagnostics/); do not infer a missing application file from an unrelated provider or DNS error.

Transferring a project can change host and authority relationships. Review the transfer preview and returned cleanup/rotation guidance before moving ownership.

Replace `app.example.com` with a domain you control. The default connect mode returns DNS records for you to apply; it does not prove DNS or TLS is already active. Follow the returned checks and rerun `domains check` after the records propagate. For a Run402 managed hostname on a live release, use `run402 subdomains claim <name> --project <project_id>` or declare `subdomains.set` in the release.

## Read the result and recover

Connection returns setup instructions; `domains check` and `domains status` establish readiness. A pending verification result means apply or correct the requested records and check again. If the domain is ready but the path is wrong, inspect the release/route rather than recreating the domain. Changing nameservers can affect existing mail and unrelated records; review the requested change against the zone you control.
