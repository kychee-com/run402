## MODIFIED Requirements

### Requirement: Manage members and invites on the scoped instance

`r.org(id).members.{list,add,setRole,revoke}` and `r.org(id).invites.{list,create,revoke}` SHALL operate on the bound org. `members.setRole` SHALL take the principal id as its single leading positional and the role as a named field of a trailing options object (`setRole(principalId, { role })`); the positional `setRole(principalId, role)` form SHALL remain available as a `@deprecated` overload for one major-version window and SHALL behave identically. Mutations are owner-gated server-side; the client SHALL surface the gateway's `LAST_OWNER` error when demoting or revoking the only active owner.

#### Scenario: Add a member by wallet
- **WHEN** an owner calls `r.org(orgId).members.add({ wallet, role })`
- **THEN** the client SHALL POST the member to the bound org and return the mutation result

#### Scenario: Set a member role via options object
- **WHEN** an owner calls `r.org(orgId).members.setRole(principalId, { role: "admin" })`
- **THEN** the client SHALL PATCH the member's role on the bound org and return the mutation result

#### Scenario: Deprecated positional setRole still works
- **WHEN** a caller invokes the deprecated `r.org(orgId).members.setRole(principalId, "admin")`
- **THEN** the client SHALL behave identically to the options-object form and SHALL emit a single stderr deprecation notice for the method in the process

#### Scenario: Last-owner protection is surfaced
- **WHEN** a mutation would remove or demote the org's only active owner
- **THEN** the client SHALL surface the gateway `LAST_OWNER` error unchanged
