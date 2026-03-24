### Requirement: Admin can delete any project
The `DELETE /projects/v1/:id` endpoint SHALL accept admin auth and bypass the service_key ownership check.

#### Scenario: Admin deletes a project they don't own
- **WHEN** an admin sends `DELETE /projects/v1/prj_123` with admin credentials (not the project's service_key)
- **THEN** the endpoint SHALL archive the project (cascade delete all resources) and return `{ "status": "archived", "project_id": "prj_123" }`

#### Scenario: Owner still deletes their own project
- **WHEN** a project owner sends `DELETE /projects/v1/prj_123` with the project's service_key
- **THEN** the endpoint SHALL work as before (no behavior change for existing users)

### Requirement: Admin can delete any subdomain
The `DELETE /subdomains/v1/:name` endpoint SHALL accept admin auth and bypass the project ownership check.

#### Scenario: Admin releases an orphaned subdomain
- **WHEN** an admin sends `DELETE /subdomains/v1/skmeld` with admin credentials
- **THEN** the endpoint SHALL delete the subdomain record and return `{ "status": "deleted", "name": "skmeld" }`

#### Scenario: Owner deletes their own subdomain
- **WHEN** a project owner sends `DELETE /subdomains/v1/myapp` with their project's service_key
- **THEN** the endpoint SHALL work as before (ownership check still applies for non-admin)

### Requirement: List projects with identity-scoped results
The `GET /projects/v1` endpoint SHALL return projects scoped to the caller's identity.

#### Scenario: Admin lists all projects
- **WHEN** an admin sends `GET /projects/v1` with admin credentials
- **THEN** the endpoint SHALL return all projects (active and archived) with pagination

#### Scenario: Wallet user lists their own projects
- **WHEN** a wallet user sends `GET /projects/v1` with SIWx auth (non-admin wallet)
- **THEN** the endpoint SHALL return only projects owned by that wallet address

#### Scenario: Unauthenticated request
- **WHEN** a request to `GET /projects/v1` has no valid auth
- **THEN** the endpoint SHALL return 401

#### Scenario: Pagination
- **WHEN** a request includes `?limit=20&after=prj_123`
- **THEN** the response SHALL return at most 20 projects created after the cursor, with `has_more` and `next_cursor` fields

### Requirement: List subdomains with identity-scoped results
The `GET /subdomains/v1` endpoint SHALL return subdomains scoped to the caller's identity.

#### Scenario: Admin lists all subdomains
- **WHEN** an admin sends `GET /subdomains/v1` with admin credentials
- **THEN** the endpoint SHALL return all subdomains with their project_id, deployment_id, and URLs

#### Scenario: Wallet user lists their own subdomains
- **WHEN** a wallet user sends `GET /subdomains/v1` with SIWx auth (non-admin wallet)
- **THEN** the endpoint SHALL return only subdomains belonging to projects owned by that wallet

#### Scenario: Unauthenticated request
- **WHEN** a request to `GET /subdomains/v1` has no valid auth
- **THEN** the endpoint SHALL return 401

### Requirement: List functions with identity-scoped results
The `GET /functions/v1` endpoint SHALL return functions scoped to the caller's identity.

#### Scenario: Admin lists all functions
- **WHEN** an admin sends `GET /functions/v1` with admin credentials
- **THEN** the endpoint SHALL return all deployed functions across all projects

#### Scenario: Wallet user lists their own functions
- **WHEN** a wallet user sends `GET /functions/v1` with SIWx auth (non-admin wallet)
- **THEN** the endpoint SHALL return only functions belonging to projects owned by that wallet

### Requirement: Admin GUI pages for projects and subdomains
The admin dashboard SHALL include pages for browsing projects and subdomains with action buttons.

#### Scenario: Admin navigates to /admin/projects
- **WHEN** an authenticated admin visits `/admin/projects`
- **THEN** the page SHALL display a table of all projects with columns for ID, name, tier, status, wallet, and created date, with a delete button per row

#### Scenario: Admin navigates to /admin/subdomains
- **WHEN** an authenticated admin visits `/admin/subdomains`
- **THEN** the page SHALL display a table of all subdomains with columns for name, project_id, deployment_id, and created date, with a release button per row

#### Scenario: Admin clicks delete on a project
- **WHEN** an admin clicks the delete button on a project row in `/admin/projects`
- **THEN** the page SHALL call `DELETE /projects/v1/:id` with the session cookie and update the table on success
