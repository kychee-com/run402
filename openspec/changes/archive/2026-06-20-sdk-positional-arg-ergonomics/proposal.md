## Why

A surface audit found ~50 public SDK methods that take two or more order-significant positional arguments — most of them two same-type strings (`members.setRole(principalId, role)`, `wallets.setLabel(address, label)`, `domains.add(projectId, domain, subdomainName)`, `secrets.set(projectId, key, value)`), plus one boolean trap (`admin.setLeasePerpetual(orgId, perpetual)`). A transposed pair compiles cleanly; at the plain-JS CLI/MCP edge — where there is no TypeScript swap protection — it then fails silently or mutates the wrong resource (`wallets.setLabel` even swallows the error and returns `{ ok: false }`).

The SDK already proves the fix: `r.project(id)`, `r.org(id)`, and the existing `r.admin` namespace (which already nests `r.admin.transfers`) show that binding a recurring id as a **scope handle** removes it as a swappable argument. But the pattern was applied unevenly — never extended to the orphan `wallets` namespace or to the operator-only `admin` org/project actions, and the residual same-type pairs were never moved into options objects. This change codifies one call-shape convention, closes the gaps, and makes the new shapes the **only** ones any first-party caller uses or any doc teaches.

## What Changes

- **New convention (documented + CI-enforced contract):** a public SDK call SHALL NOT take two order-significant positionals of the **same runtime type**, and SHALL NOT take a **boolean** positional. At most one leading id/handle is positional; a second positional is allowed only when it is a different runtime type *and* the operation's primary payload (e.g. `sql(query, params?)`, `assets.put(key, source)`). Everything else — and any same-type second value — is a named field of a trailing options object; a recurring secondary id becomes its own sub-handle.
- **New scope handles:**
  - `r.wallet(address)` → `.getLabel()`, `.setLabel(label)` (the orphan `wallets` namespace gains the `r.project`/`r.org` shape).
  - Extend the existing `r.admin` with `r.admin.org(orgId)` and `r.admin.project(projectId)` (same nesting style as today's `r.admin.transfers`).
- **Kill the boolean trap — BREAKING (deprecation path):** `r.admin.setLeasePerpetual(orgId, perpetual)` → `r.admin.org(orgId).pinLease()` / `.unpinLease()`. The flat `archiveProject` / `reactivateProject` / `getProjectFinance` move to `r.admin.project(projectId).archive(opts?)` / `.reactivate()` / `.finance(opts?)`.
- **Same-type-pair reshapes — BREAKING (deprecation path):**
  - `domains.add(projectId, domain, subdomainName)` → `r.project(id).domains.add({ domain, subdomainName })`
  - `subdomains.claim(name, deploymentId, opts)` → `r.subdomains.claim({ name, deploymentId, ...opts })`
  - `secrets.set(projectId, key, value)` → `r.project(id).secrets.set(key, { value })`
  - `org.members.setRole(principalId, role)` → `setRole(principalId, { role })`
  - `r.admin.transfers.cancel(transferId, reason)` → `cancel(transferId, { reason })`
  - `projects.rest(id, table, query)` string-query form → `r.project(id).rest(table, { query })` (the options overload already exists; the bare-string second positional is deprecated)
- **First-party callers use only the canonical forms — BREAKING for internal call sites only:** every MCP handler (`src/tools/*.ts`) and CLI module (`cli/lib/*.mjs`, the JS edge where the swap risk actually lived) SHALL call the new SDK shapes exclusively; no first-party code path invokes a deprecated positional overload. A CI guard fails the build if one reappears.
- **Docs teach only the canonical forms:** every surface in [documentation.md](documentation.md) (README, both SKILL files, `cli/llms-cli.txt`, `sdk/llms-sdk.txt`, `llms-mcp.txt`, `sdk/README.md`, `cli/README.md`, `llms.txt`, and the private `updates.txt` / `changelog.html`) shows only the new shapes. Deprecated positional forms appear, if at all, only in a single migration note + `CHANGELOG.md`, never in examples — enforced via the `SKILL.test.ts` banned-pattern list and `sync.test.ts` drift guards.
- **Non-breaking for external callers:** every reshaped method ships an additive object/handle overload; the positional form is retained with `@deprecated` (one-time stderr warning) through the next major. This change removes nothing.
- **Explicitly out of scope (named follow-ups):** deeper sub-handles `r.project(id).job(jobId)` / `.asset(key)`; the **frozen** `contracts.signer(signerId)` surface (needs an explicit lift); and the Bucket-A primitives already ergonomic via `r.project(id)`.

## Capabilities

### New Capabilities
- `sdk-call-shape-conventions`: the same-type-pair / no-boolean convention as a public contract; the new `r.wallet(address)` and `r.admin.org(id)` / `r.admin.project(id)` scope handles; the verb-split lease controls; the options-object signatures for `domains.add`, `subdomains.claim`, and `projects.rest`; and the requirement that first-party callers and all documentation use only the canonical forms.

### Modified Capabilities
- `org-management-client-surface`: `r.org(id).members.setRole` moves `role` into an options object (`setRole(principalId, { role })`); positional form deprecated, behavior unchanged.
- `secrets-isolation-client-contract`: canonical SDK shape becomes `r.project(id).secrets.set(key, { value })`; the `r.secrets.set(projectId, key, value)` positional primitive is deprecated but still wired to `POST /projects/v1/admin/{projectId}/secrets` with `{ key, value }`.
- `unified-transfer-client-surface`: `r.admin.transfers.cancel` moves the optional `reason` into an options object (`cancel(transferId, { reason })`); positional `reason` deprecated, route and kind-agnostic behavior unchanged.

## Impact

- **SDK code:** `sdk/src/index.ts` (new `wallet()` accessor), `sdk/src/scoped.ts` (new scoped admin org/project classes + reshaped wrappers), `sdk/src/namespaces/{wallets,admin,domains,subdomains,secrets,org,transfers,projects}.ts` (additive overloads + `@deprecated` shims + a shared `deprecatePositional` helper).
- **First-party callers (canonical-only):** `src/tools/*.ts` (MCP handlers calling reshaped methods — secrets, domains, subdomains, org set-role, transfer cancel), `cli/lib/*.mjs` (CLI), `openclaw/scripts/*.mjs` re-exports. MCP tool *schemas* are already named-object inputs; only handler internals + examples change.
- **Tests / guards:** extend `sdk/src/scoped.test.ts` drift guard for the new handles; add a first-party-source guard (no deprecated positional in `cli/lib` / `src/tools`); extend `SKILL.test.ts` banned-pattern list and `sync.test.ts` doc-drift guards; `SURFACE` / `SDK_BY_CAPABILITY` names stay stable.
- **Docs:** all public surfaces in [documentation.md](documentation.md) updated to canonical-only; `CHANGELOG.md` `## Unreleased` entry; private `apps/marketing/updates.txt` + `humans/changelog.html` user-visible entry (HTTP API / `openapi.json` unchanged — wire format is identical).
- **Compatibility:** additive-first; one deprecation cycle precedes any positional removal (a later change). `wallet-named-identity`'s "no standalone label command" invariant preserved — `r.wallet(address).setLabel` is an SDK reshape, not a new CLI subcommand.
- **Scope guard:** the `contracts` namespace is frozen and untouched.
