---
title: Credentials and trust boundaries
description: Who holds each credential, what it authorizes and how it changes.
---

Control-plane principals are people, agents or CI participants operating infrastructure. Tenant actors are users of your app. An app login does not grant deployment authority.

| Credential | Holder and scope | Browser-safe? | Lifetime and recovery |
| --- | --- | --- | --- |
| Local allowance/wallet signing material | Agent or operator profile; signs permitted control-plane/payment requests | No | Protect profile files; inspect effective authority and payer before using a different profile |
| Human control-plane session | Human operator; membership and action policy still apply | Only in its intended login flow | Expires; sensitive operations may require same-client step-up |
| Named project credential | A project client; limited to its declared kind/scope | Only an explicitly public anon credential | Expiring and individually revocable; secret returned once |
| Legacy anon key | Public application identification; RLS still decides access | Yes | Legacy non-expiring token; migrate/rotate with the supported credential workflow |
| Legacy service key | Trusted project backend; privileged data access | No | Legacy key; keep out of HTML and logs, inspect migration status |
| Tenant user session | App user; row policies and app permissions | Through the intended app auth flow | Session expiry/revocation; never use as control-plane authority |
| GitHub OIDC binding | CI workflow restricted to a project and allowed operations | No | Short-lived exchanged credential; revoke the binding to remove access |
| Runtime secret | Deployed server function | No | Write-only configuration; rotate at its provider and update the deployment |

Inspect metadata without printing secrets:

```bash
run402 credentials list --project prj_example
run402 credentials project-keys status --project prj_example
```

Issuing, rotating and revoking durable project credentials require the documented owner and freshness policy. Delegates cannot turn their bounded authority into permanent credentials. Rotation and revocation are different operations: a second issued credential permits an overlap migration, while immediate revocation ends the old credential's access. See the [credential command reference](/cli/commands/).

A local cache entry is not server inventory, and an empty cache does not prove a project is absent. Load public browser config from `/_run402/config.js`; never place service keys, signing material or runtime secrets in a client bundle.
