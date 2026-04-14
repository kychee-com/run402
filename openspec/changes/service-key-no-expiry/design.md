# Design: service-key-no-expiry

## Threat model — what is `exp` protecting against?

The only non-trivial argument for keeping `exp` on `service_key` is blast-radius limiting for a leaked key. Walk through it:

```
  Attacker exfiltrates service_key
            │
            ▼
  Has full admin on the project schema
  (SQL, secrets, functions, mailbox, storage, contracts)
            │
            ▼
  Day 0 .. Day 7 (or 30):   everything open, attacker drains
            │
            ▼
  Day 7+ :                  JWT exp fires, key rejected
```

Two problems with this model:

1. **The 7-day window is far larger than exfiltration windows.** Any attacker who obtained the key has already dumped the schema, exfiltrated secrets, and / or burned through usage counters within minutes. A lazy 7-day timer doesn't limit blast radius in any realistic sense.

2. **The gateway has no concept of per-key revocation.** A honest owner who notices a leak cannot say "invalidate this specific key". The only options today are:
   - Delete the project (loses all data)
   - Fork the project (new schema, same `JWT_SECRET`, old key still valid against new project? no — `project_id` claim doesn't match, so actually yes this works)
   - Wait for the key to expire naturally

   None of these are what a compromised owner wants. A real revocation story would need a `kid` claim + denylist, or per-project key versioning. That's a future change, and is the right answer if we decide key leaks are a threat worth engineering against.

3. **`JWT_SECRET` is shared across all projects.** Rotating `JWT_SECRET` invalidates every service_key for every project on the platform. It's the atomic-bomb of revocation. If per-project revocation matters, `exp` isn't the tool — per-project `kid` is.

So `exp` is not serving the threat it appears to serve. It's mostly serving the asymmetric expectation that "secret tokens expire, public tokens don't" — an intuition inherited from OAuth access tokens, which is wrong for a project-scoped API key whose authority is bounded by server-side state.

## The silent-break bug, visualized

```
  Day 0               Day 30 (lease end)    Day 31 (renewed)
    │                        │                    │
  deploy function       JWT exp hits         owner pays
    │                        │                    │
    ▼                        ▼                    ▼
  Lambda env:           Lambda env:          Lambda env:
  SERVICE_KEY=          SERVICE_KEY=         SERVICE_KEY=
  <JWT exp=D30>         <JWT exp=D30>        <JWT exp=D30>   ← unchanged
                               │                    │
                               ▼                    ▼
                        fn → gateway        fn → gateway
                        Bearer exp'd        Bearer exp'd
                        401 Invalid token   401 Invalid token
                                                    │
                                                    ▼
                                            ❌ silent failure
                                            despite paid renewal
```

The middleware doesn't distinguish "token expired" from "signature bad" in its error message (`"Invalid token"`), which makes this particularly hard to diagnose. Owners file bug reports saying "my functions broke and I paid, what?"

Three possible fixes:

| Option | Description | Cost |
|---|---|---|
| A | Drop `exp` from service_key entirely | 1-line code change + 2 tests + 2 docs lines |
| B | Re-inject `RUN402_SERVICE_KEY` into every Lambda on tier renewal | New cron or hook in `wallet-tiers.ts` → enumerate project Lambdas → `UpdateFunctionConfiguration` each. N projects × M functions AWS API calls per renewal. |
| C | Do both | Redundant — B only matters if A is rejected |

This change picks A. B is more code to maintain for a problem that A makes impossible.

## Backfill: what about JWTs already in circulation?

After this change ships, exp'd keys exist in three distinct populations. Each has a different reach from the gateway, and each has its own resolution path — no new public API required.

```
 Population                                 Resolution path
 ═════════════════════════════════════      ══════════════════════════════════
 (A) Active projects that redeploy at       Normal redeploy activity replaces
     least once per lease window            the env var via deployFunction.
     ├─ run402-hosted Lambdas (kysigned     No action required. Natural drain.
     │  et al. run as run402 functions)
     └─ own-hosted apps calling run402

 (B) "Deploy and forget" projects that      Self-heal in the existing secrets-
     don't redeploy for months              sync path (services/functions.ts
                                            :903-917). Fires on any secret
                                            update, scheduled-fn toggle, etc.

 (C) Third-party stores holding a           Platform-operator one-off: run
     service_key outside any run402         a jwt.sign against JWT_SECRET,
     Lambda env (e.g. foreign AWS SM,       hand the string over out-of-band.
     CI secrets, MCP config caches)         Zero shipped code.
```

### (A) Active redeployers — do nothing

`deployFunction` already mints fresh keys via `deriveProjectKeys` on every deploy (`services/functions.ts:328`). Post-fix, those are no-exp. So any project whose owner redeploys for any reason — publishing a new version, adding a function, changing code, forking — self-heals on that first touch. This covers the large majority of actively-maintained projects.

Worth noting: kysigned-the-app runs as run402 Lambdas (`kysigned-api`, `kysigned-email-webhook`, `kysigned-sweep`). Any kysigned function redeploy refreshes the auto-injected `RUN402_SERVICE_KEY`. If kysigned additionally caches a key under a different name (`KYSIGNED_RUN402_SERVICE_KEY` in the public-repo bridge code), that cache is orthogonal to this change and can be rationalized by kysigned separately.

### (B) Forgotten fleet — opportunistic self-heal

The existing `syncFunctionEnvVars` path at `services/functions.ts:903-917` reads the current `RUN402_SERVICE_KEY` from the Lambda and writes it back unchanged. Tiny modification: decode the read-back value; if it has an `exp` claim, mint a fresh no-exp key and use that instead. Then the existing flow transparently sweeps the backlog on any secrets update, scheduled-function toggle, or incremental deploy.

```ts
// around services/functions.ts:909
let existingServiceKey = fnConfig.Configuration?.Environment?.Variables?.RUN402_SERVICE_KEY || "";
if (existingServiceKey) {
  const decoded = jwt.decode(existingServiceKey) as { exp?: number } | null;
  if (decoded?.exp) {
    const { serviceKey } = deriveProjectKeys(projectId, project.tier);
    existingServiceKey = serviceKey;   // swap legacy key for no-exp one
  }
}
```

Cost: ~5 lines, one added import (`jwt.decode`), no new surface area. Healthy keys pass through unchanged.

### (C) Third-party cached keys — operator mint-and-paste

For the rare case of a service_key stored entirely outside the run402 Lambda fleet (a third-party CI pipeline, a foreign-account AWS Secrets Manager entry, a user's laptop `.env`), the gateway has no way to reach it. Resolution is manual and one-off:

```
# Platform operator, on a host with JWT_SECRET available:
node -e "const jwt=require('jsonwebtoken');
         console.log(jwt.sign(
           {role:'service_role', project_id:'<project_id>', iss:'agentdb'},
           process.env.JWT_SECRET));"
```

Hand the string to the third party out-of-band. No shipped API, no support route. If this request volume grows beyond a handful per year, *then* consider the endpoint — but design it against the actual traffic, not against the migration.

### Why this beats a rotation endpoint

A `GET /projects/v1/:id/keys` (or similar) would:
- ship as a permanent public API for a finite migration problem
- imply a per-key rotation story the platform doesn't actually support (no `kid`, no denylist — rotating `JWT_SECRET` is still the platform-wide revocation hammer)
- need wallet-auth middleware, rate-limiting, audit logging, docs, tests — all to deliver the same outcome as the three mechanisms above for the populations that actually exist.

The shape of a migration fix should match the migration's time horizon. In-process drain (A+B) for the bulk; operator out-of-band (C) for stragglers. No permanent API.

## Why not keep `exp` and just fix the renewal bug?

Because the renewal bug fix (option B above) is strictly more complex than removing `exp`, and it doesn't address the redundancy — `exp` *still* isn't doing work that isn't already done by `projectCache` + `isServingStatus` + `lifecycleGate`. Fixing the symptom without fixing the design smell is the worst of both worlds: more code, same underlying problem, future developer wondering "why does this JWT have `exp` anyway?".

## What we're explicitly not promising

- **Per-key revocation.** If leaks become a concern, that's a separate change with `kid` claims and a denylist.
- **Time-limited keys at all.** If we ever need ephemeral service-role credentials (e.g. for a CI/CD integration that should auto-expire), that's a new role (`ci_role`?) with its own JWT shape. `service_key` is specifically the permanent admin credential for a project, analogous to Supabase's `service_role` JWT.
- **Cross-project denial.** A service_key leaked to attacker Y is only useful against project X — `project_id` claim still binds it. This was always true and doesn't change.
