---
title: "Project credentials"
description: "Native SDK reference — credentials."
order: 40
---

## Project credentials

After `r.projects.provision(...)`, the result has `project_id`, `anon_key`, `service_key`, `schema_slot`. The Node entry's credentials provider auto-saves keys to the active profile's local project-key cache (`credentials/project-keys.v1.json`). Legacy `projects.json` files are one-way migration input only.

- `anon_key` — read-only by default; safe in browser HTML. RLS policies apply.
- `service_key` — server-side admin. Never embed in browser code.

Neither key expires. Lease enforcement happens server-side. Server project reads such as `r.projects.list()`, `r.projects.get(id)`, and `r.projects.use(id)` authorize with the current principal and do not require local cache membership.

### Rotatable project credentials — the replacement for the derived pair

The `anon_key`/`service_key` above are DERIVED from the platform signing key: they never expire and cannot be revoked individually. A **project credential** (`r402_…`) is a ROW instead — named, listable, expiring, individually revocable — and several may be live per kind at once, which is exactly how you rotate with no downtime.

`r.credentials` carries both surfaces, and they do not overlap: `r.credentials.<verb>` is the gateway's rows, `r.credentials.projectKeys.<verb>` is the local cache on this machine.

```ts
// Am I still on the retiring key? Only project.read is needed, so an agent can
// check its own posture. retirement.deadline is ALWAYS null on purpose —
// retirement is condition-gated, never a date. Read retirement.gated_on.
const posture = await r.credentials.status(projectId);   // { state: "legacy" | "rotatable", ... }

// Mint one. The secret is returned EXACTLY ONCE; there is no read that
// returns it. Persist it before doing anything else.
const cred = await r.credentials.issue(projectId, { kind: "service", name: "ci-deploy" });
cred.secret;                                              // r402_…  — once, and never again

await r.credentials.list(projectId, { includeRevoked: true });   // metadata only
await r.credentials.rotate(projectId, cred.credential_id);       // replace in one tx; new secret once
await r.credentials.revoke(projectId, cred.credential_id, { reason: "leaked in a log" });
```

Zero-downtime rotation is `issue` a second live credential → deploy it → `revoke` the first. `rotate()` collapses that into one transaction (same name, records `replacement_of`) and is the right call when the old secret is already compromised.

`issue`/`rotate`/`revoke` require owner membership on the project's owning org PLUS a fresh step-up, and a delegate can NEVER satisfy them — a scoped agent credential must not be able to escalate itself into a permanent root.

```ts
// The one exception, and the cold-restart recovery path: an agent that lost
// local state but still holds a delegate mints a SHORT-LIVED token with no
// human present. No step-up, because there is nobody to prompt; it expires,
// so it cannot become a durable root.
const token = await r.credentials.mintToken(projectId);  // { secret, expires_in, … }
```

Never write an `issue` / `rotate` / `mintToken` response to a result cache, tmp file, or expansion handle — they are secret-bearing, like `provision` and project keys.

**Deploys self-recover on a cold machine.** The apikey-gated deploy legs (content upload, operation polling) read the project's anon key from the local credential cache — and when the cache has no entry (the returning-agent case: the wallet survives, the once-issued keys did not), the SDK mints a short-lived ANON token via this same route automatically, uses it as the apikey, and memoizes it in process memory until it expires. Nothing durable is written anywhere; a client that cannot mint (no signer, no authority) falls through to the pre-existing 401, whose envelope names the recovery. So `deploy.apply()` on a fresh machine with a wallet needs zero extra commands. For a durable local re-key, `run402 credentials issue --kind <service|anon> --name <n> --import` writes the minted secret straight into the cache.

```ts
await r.projects.use(projectId);             // make this the active project
const keys = await r.projects.keys(projectId);
const info = await r.projects.info(projectId);
```
