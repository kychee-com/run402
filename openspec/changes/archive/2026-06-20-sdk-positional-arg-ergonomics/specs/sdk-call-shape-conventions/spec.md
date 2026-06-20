## ADDED Requirements

### Requirement: Public methods avoid same-type positional pairs and boolean positionals

A public SDK method SHALL NOT take two order-significant positional arguments of the same runtime type, and SHALL NOT take a boolean positional. At most one leading id or handle SHALL be positional. A second positional is permitted only when it is a different runtime type than the first AND is the operation's primary payload (for example `sql(query, params?)` — string plus array — or `assets.put(key, source)` — string plus content source). Every other input, and any same-type second value, SHALL be a named field of a single trailing options object. A secondary id that recurs across a namespace SHALL be exposed as its own scope handle rather than as a positional.

#### Scenario: Same-type second value is named
- **WHEN** a new or reshaped method needs a second value of the same runtime type as the leading id/handle
- **THEN** that value SHALL be a named field of a trailing options object, not a second positional

#### Scenario: Different-type primary payload may stay positional
- **WHEN** a method takes a leading id/handle plus a single primary payload of a different runtime type (e.g. `sql(query, params?)`, `assets.put(key, source)`)
- **THEN** the payload MAY remain positional and the method is compliant

#### Scenario: Booleans are never bare positionals
- **WHEN** a method toggles behavior with a boolean
- **THEN** the surface SHALL expose intent-named verbs or a named options field, and SHALL NOT accept a bare boolean positional

### Requirement: Wallet server-label is reached through a wallet scope handle

`r.wallet(address)` SHALL return a lazy wallet-scoped sub-client that binds the address and exposes `getLabel()` and `setLabel(label)`, so neither method takes the address as a swappable positional. The handle SHALL be constructed without key or network access (auth/errors surface from the first real call) and SHALL preserve the existing best-effort semantics of the underlying label methods. The handle SHALL be an SDK reshape only and SHALL NOT introduce a standalone CLI label command, preserving the `wallet-named-identity` invariant.

#### Scenario: Set a label through the handle
- **WHEN** a caller invokes `r.wallet(address).setLabel("kychon")`
- **THEN** the client SHALL issue the same authenticated `PUT /wallets/v1/:address/label` as `r.wallets.setLabel(address, "kychon")` and return the same result

#### Scenario: Read a label through the handle
- **WHEN** a caller invokes `r.wallet(address).getLabel()`
- **THEN** the client SHALL return the server-side label for that address, or null, identical to `r.wallets.getLabel(address)`

### Requirement: Operator org and project actions are reached through admin scope handles

The existing `r.admin` namespace SHALL be extended with `r.admin.org(orgId)` and `r.admin.project(projectId)` lazy sub-clients (the same nesting style as `r.admin.transfers`), kept distinct from the member-facing `r.org(id)` because the auth principal differs (platform-operator vs org-owner). `r.admin.org(orgId)` SHALL expose `pinLease()` and `unpinLease()` in place of the boolean `admin.setLeasePerpetual(orgId, perpetual)`. `r.admin.project(projectId)` SHALL expose `archive(opts?)`, `reactivate()`, and `finance(opts?)` in place of the flat `admin.archiveProject` / `reactivateProject` / `getProjectFinance`. All SHALL carry platform-admin (`X-Admin-Mode`) auth and SHALL surface operator-only errors unchanged at call time.

#### Scenario: Pin a lease through the admin org handle
- **WHEN** an operator calls `r.admin.org(orgId).pinLease()`
- **THEN** the client SHALL set the org `lease_perpetual` flag true via the operator route, equivalent to the deprecated `admin.setLeasePerpetual(orgId, true)`

#### Scenario: Unpin a lease through the admin org handle
- **WHEN** an operator calls `r.admin.org(orgId).unpinLease()`
- **THEN** the client SHALL clear the org `lease_perpetual` flag, equivalent to `admin.setLeasePerpetual(orgId, false)`

#### Scenario: Non-operator principal is rejected at call time
- **WHEN** a non-operator principal constructs an `r.admin.*` handle and then calls a method
- **THEN** construction SHALL succeed and the method call SHALL surface the gateway operator-auth error unchanged

### Requirement: Same-type secondary arguments use options objects

Public methods whose arguments would otherwise be a same-type positional pair SHALL accept the secondary value(s) as named fields of an options object. The canonical forms SHALL be `r.project(id).domains.add({ domain, subdomainName })`, `r.subdomains.claim({ name, deploymentId, ...opts })`, and `r.project(id).rest(table, { query })` (the bare-string query as a second positional is deprecated; the options overload already exists).

#### Scenario: Add a custom domain by options object
- **WHEN** a caller invokes `r.project(id).domains.add({ domain, subdomainName })`
- **THEN** the client SHALL register the custom domain with the same request body as the positional `domains.add(projectId, domain, subdomainName)`

#### Scenario: Claim a subdomain by options object
- **WHEN** a caller invokes `r.subdomains.claim({ name, deploymentId })`
- **THEN** the client SHALL claim the subdomain with the same request body as `subdomains.claim(name, deploymentId)`

#### Scenario: REST query is passed as a named field
- **WHEN** a caller invokes `r.project(id).rest(table, { query })`
- **THEN** the client SHALL issue the same PostgREST request as the deprecated string-query form `rest(table, query)`

### Requirement: First-party callers and documentation use only canonical forms

The deprecated positional overloads SHALL exist only for external back-compatibility. First-party code SHALL NOT invoke any deprecated positional overload: no deprecated positional call signature SHALL appear in `cli/lib/**` or `src/tools/**`. Every documentation surface listed in `documentation.md` SHALL teach only the canonical forms; a deprecated positional form MAY appear only in a single migration note plus `CHANGELOG.md`, and SHALL NOT appear in any example. These constraints SHALL be CI-guarded.

#### Scenario: No first-party caller uses a deprecated positional
- **WHEN** the source guard scans `cli/lib/**` and `src/tools/**`
- **THEN** it SHALL find no deprecated positional call signature for a reshaped method, and SHALL fail the build if one is present

#### Scenario: Skill and reference docs teach only canonical forms
- **WHEN** the `SKILL.test.ts` banned-pattern check and `sync.test.ts` doc-drift guards run over the skill and reference docs
- **THEN** they SHALL find only canonical-form examples and SHALL fail if a deprecated positional form is taught

### Requirement: Reshaped methods deprecate positional forms additively

Every reshaped method SHALL retain its positional overload, marked `@deprecated` in its TypeScript types, for one major-version deprecation window. Calling a deprecated positional form SHALL behave identically to the new form and SHALL emit at most one de-duplicated deprecation notice per method per process, written to stderr only and suppressible via environment variable. This change SHALL NOT remove any public method.

#### Scenario: Deprecated positional form still works
- **WHEN** a caller uses a deprecated positional form such as `r.wallets.setLabel(address, label)`
- **THEN** the call SHALL still succeed and SHALL emit at most one stderr deprecation notice for that method in the process

#### Scenario: Deprecation output never corrupts stdout
- **WHEN** a deprecation notice is emitted in a context whose stdout carries JSON for an agent or the CLI
- **THEN** the notice SHALL be written to stderr only, leaving stdout uncorrupted
