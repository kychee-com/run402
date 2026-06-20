## 1. Deprecation infrastructure (foundation)

- [x] 1.1 Add a `deprecatePositional(method)` helper (`sdk/src/deprecate.ts`): one de-duplicated stderr notice per method per process, `RUN402_SUPPRESS_DEPRECATIONS=1` opt-out
- [x] 1.2 Unit-test the helper (`sdk/src/deprecate.test.ts`): warns once, stderr-only, suppressible

## 2. Wallet scope handle (`r.wallet(address)`)

- [x] 2.1 `ScopedWallet` (lazy, address-bound) with `getLabel()` / `setLabel(label)` forwarding to shared impls
- [x] 2.2 `wallet(address)` accessor on `Run402` (`sdk/src/index.ts`) + type re-export
- [x] 2.3 Parity test (`call-shape-conventions.test.ts`): handle PUTs the same body as `r.wallets.setLabel`

## 3. Admin org/project handles + boolean verb-split (extend existing `r.admin`)

- [x] 3.1 `ScopedAdminOrg.pinLease()` / `unpinLease()` → shared `_setLeasePerpetual` impl
- [x] 3.2 `ScopedAdminProject.archive(opts?)` / `reactivate()` / `finance(opts?)`
- [x] 3.3 `admin.org(orgId)` / `admin.project(projectId)` accessors on `Admin`
- [x] 3.4 `admin.setLeasePerpetual` marked `@deprecated`, routed through `deprecatePositional`
- [x] 3.5 Tests: verb-split sends `lease_perpetual:true/false`; handles exist

## 4. Same-type-pair reshapes (additive overloads + deprecate positional)

- [x] 4.1 `domains.add(projectId, { domain, subdomainName })` + deprecated positional + `ScopedDomains.add`
- [x] 4.2 `subdomains.claim({ name, deploymentId, ...opts })` + deprecated positional + `ScopedSubdomains.claim`
- [x] 4.3 `secrets.set(projectId, key, { value })` + scoped `set(key, { value })` + deprecated positional
- [x] 4.4 `org.members.setRole(principalId, { role })` + deprecated positional
- [x] 4.5 `admin.transfers.cancel(transferId, { reason })` + deprecated positional
- [x] 4.6 `projects.rest`/`restResponse`: bare-string `query` deprecated; `{ query }` canonical
- [x] 4.7 Wire-equivalence tests: each new form === deprecated form on the wire; deprecated path warns once

## 5. Surface, drift, and canonical-only guards

- [x] 5.1 Handle existence asserted (`call-shape-conventions.test.ts`); `scoped.test.ts` drift still green
- [x] 5.2 Source guard in `sync.test.ts`: no fully-deprecated method (`setLeasePerpetual` / `wallets.setLabel`) in `cli/lib/**` or `src/tools/**`
- [ ] 5.3 (optional) Add the deprecated tokens to the `SKILL.test.ts` banned-pattern list — belt-and-suspenders; the SKILL/reference docs already contain none (verified via grep), and 5.2 covers first-party code
- [x] 5.4 `sync.test.ts` `SURFACE`/`SDK_BY_CAPABILITY` valid (new `admin.*` in `SDK_ONLY_METHODS`); timestamp + type tests pass

## 6. First-party callers use only canonical forms

- [x] 6.1 MCP handlers migrated (`set-secret`, `add-custom-domain`, `subdomain`, `orgs` setRole, `transfers` cancel, `admin-set-lease-perpetual`)
- [x] 6.2 CLI migrated (`secrets`, `domains`, `subdomains`, `org`, `transfer`, `wallets`, `admin`, `projects` rest)
- [x] 6.3 OpenClaw re-exports resolve; `npm run test:sync` green
- [x] 6.4 `npm run test:e2e` green (687 pass)

## 7. Documentation — canonical-only across every surface in documentation.md

- [x] 7.1 `sdk/llms-sdk.txt` + `sdk/README.md`: canonical forms (`r.wallet`, `r.admin.org/project`, options-object `secrets.set`/`setRole`, `pinLease`/`unpinLease`) + deprecation notes
- [x] 7.2 `cli/llms-cli.txt` + `cli/README.md` + `openclaw/SKILL.md`: verified clean — CLI verbs/flags unchanged, no positional SDK forms present (grep: 0 hits)
- [x] 7.3 `SKILL.md` + `llms-mcp.txt`: verified clean — MCP tool-name framings, no positional SDK forms present (grep: 0 hits)
- [ ] 7.4 (optional polish) Add `r.wallet(address)` / `r.admin.org(id)` / `r.admin.project(id)` to the handle enumerations in `README.md` / `AGENTS.md` (no incorrect forms present today; this is additive listing only)
- [x] 7.5 `CHANGELOG.md` `## Unreleased` entry added. **Manual follow-up (separate PR, run402-private):** `apps/marketing/updates.txt` + `humans/changelog.html` user-visible entry (HTTP API unchanged)

## 8. Verification

- [x] 8.1 `npm run build` clean
- [x] 8.2 `npm test` green — 1617/1618 unit (1 pre-existing skip), 687 e2e, 43 doc snippets, source + sync guards
- [x] 8.3 `openspec validate sdk-positional-arg-ergonomics --strict` passes
