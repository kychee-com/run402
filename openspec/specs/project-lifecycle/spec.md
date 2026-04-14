### Requirement: Project status state machine
The platform SHALL model a project's end-of-life as a directed state machine with states `active`, `past_due`, `frozen`, `dormant`, `purged`, plus the legacy terminal state `archived`. A project SHALL transition forward only via lifecycle scheduler ticks and SHALL transition back to `active` from any non-terminal grace state when its wallet's lease is renewed.

#### Scenario: Project with a valid lease reports active
- **WHEN** a project's wallet has `lease_expires_at > NOW()`
- **THEN** the platform SHALL report `status = 'active'` and SHALL NOT advance its lifecycle state

#### Scenario: Project wallet lease expires
- **WHEN** the lifecycle scheduler observes a project in `status = 'active'` whose wallet has `lease_expires_at < NOW()`
- **THEN** the platform SHALL transition the project to `status = 'past_due'`, set `past_due_since = NOW()`, and enqueue a `project_past_due` email to the billing contact

#### Scenario: Past-due project reaches 14-day threshold
- **WHEN** the lifecycle scheduler observes a project in `status = 'past_due'` whose `past_due_since < NOW() - INTERVAL '14 days'`
- **THEN** the platform SHALL transition the project to `status = 'frozen'`, set `frozen_at = NOW()`, write subdomain reservation rows, and enqueue a `project_frozen` email

#### Scenario: Frozen project reaches 30-day threshold
- **WHEN** the lifecycle scheduler observes a project in `status = 'frozen'` whose `frozen_at < NOW() - INTERVAL '30 days'`
- **THEN** the platform SHALL transition the project to `status = 'dormant'`, set `dormant_at = NOW()`, and set `scheduled_purge_at = NOW() + INTERVAL '60 days'`

#### Scenario: Dormant project reaches 24 hours before scheduled purge
- **WHEN** the lifecycle scheduler observes a project in `status = 'dormant'` whose `scheduled_purge_at < NOW() + INTERVAL '24 hours'` and no final-warning email has been sent
- **THEN** the platform SHALL enqueue a `project_purge_final_warning` email and record `purge_warning_sent_at = NOW()`

#### Scenario: Dormant project reaches scheduled purge time
- **WHEN** the lifecycle scheduler observes a project in `status = 'dormant'` whose `scheduled_purge_at <= NOW()`
- **THEN** the platform SHALL invoke the project-purge cascade (see `cascade-project-delete`) and, on success, set `status = 'purged'`

#### Scenario: Wallet lease is renewed while project is in grace
- **WHEN** a project is in any of `past_due`, `frozen`, or `dormant` and its wallet's `lease_expires_at` is advanced to the future via topup, tier renewal, or tier upgrade
- **THEN** the platform SHALL transition the project to `status = 'active'`, clear `past_due_since`, `frozen_at`, `dormant_at`, `scheduled_purge_at`, and `purge_warning_sent_at`, and clear any subdomain reservation rows whose `reserved_for_project_id` matches this project

#### Scenario: Pinned project skips lifecycle entirely
- **WHEN** the lifecycle scheduler encounters a project with `pinned = true` whose wallet lease has expired
- **THEN** the platform SHALL leave the project in `status = 'active'` and SHALL NOT advance its lifecycle state

### Requirement: Control-plane write gate
The platform SHALL gate mutating control-plane endpoints (deploys, function uploads, secret rotation, subdomain claims, billing-plumbing writes, project settings) behind a middleware that rejects requests with HTTP 402 when the target project's `status != 'active'`. Read endpoints and data-plane endpoints (PostgREST, edge function execution, email send/receive, storage GETs) SHALL NOT be gated.

#### Scenario: Owner attempts to deploy a site to a frozen project
- **WHEN** an authenticated owner sends `POST /projects/v1/:id/deployments` for a project in `status = 'frozen'`
- **THEN** the platform SHALL respond `402 Payment Required` with a JSON body containing `lifecycle_state`, `entered_state_at`, and `next_transition_at`

#### Scenario: Owner reads their frozen project's dashboard
- **WHEN** an authenticated owner sends `GET /projects/v1/:id` for a project in `status = 'frozen'`
- **THEN** the platform SHALL respond `200 OK` with the project document including its current `status` and timer fields

#### Scenario: End user reads from a frozen project's schema via PostgREST
- **WHEN** an anonymous or authenticated end-user request hits a PostgREST route serving a project in `status = 'frozen'`
- **THEN** the platform SHALL serve the request normally without invoking the control-plane gate

#### Scenario: Owner rotates a secret on a past-due project
- **WHEN** an authenticated owner sends `PUT /projects/v1/:id/secrets/:name` for a project in `status = 'past_due'`
- **THEN** the platform SHALL respond `402 Payment Required`

#### Scenario: Owner attempts to claim a new subdomain on a dormant project
- **WHEN** an authenticated owner sends `POST /projects/v1/:id/subdomains` for a project in `status = 'dormant'`
- **THEN** the platform SHALL respond `402 Payment Required`

### Requirement: Scheduled function pause during dormancy
The platform SHALL pause dispatch of scheduled functions for projects in `status = 'dormant'`. Scheduled functions for projects in `active`, `past_due`, and `frozen` SHALL continue to dispatch normally.

#### Scenario: Scheduled function fires for an active project
- **WHEN** a cron-triggered scheduled function is dispatched for a project in `status = 'active'`
- **THEN** the platform SHALL invoke the Lambda function as normal

#### Scenario: Scheduled function fires for a frozen project
- **WHEN** a cron-triggered scheduled function is dispatched for a project in `status = 'frozen'`
- **THEN** the platform SHALL invoke the Lambda function as normal

#### Scenario: Scheduled function fires for a dormant project
- **WHEN** a cron-triggered scheduled function is dispatched for a project in `status = 'dormant'`
- **THEN** the platform SHALL skip invocation, log a `scheduled_function_paused` event, and SHALL NOT charge the project for compute

#### Scenario: Dormant project is reactivated
- **WHEN** a project transitions from `dormant` back to `active` via wallet renewal
- **THEN** the platform SHALL resume normal scheduled-function dispatch on the next cron tick

### Requirement: Subdomain reservation during grace
The platform SHALL reserve a project's claimed subdomains when the project enters `status = 'frozen'` and SHALL hold the reservation through `dormant` and for 14 days past `scheduled_purge_at`. A reserved subdomain SHALL remain resolvable (Route 53 record intact) and SHALL continue to serve the live site during `frozen` and `dormant`. Other claimants SHALL be rejected while the reservation is active, except when the claimant's wallet matches the wallet of the reserving project.

#### Scenario: Project enters frozen state with a claimed subdomain
- **WHEN** a project that owns subdomain `myapp` transitions from `past_due` to `frozen`
- **THEN** the platform SHALL set `internal.subdomains.reserved_for_project_id = project.id` and `reserved_until = (project.scheduled_purge_at_when_set OR frozen_at + 104 days)` for that row, and SHALL leave the Route 53 record in place

#### Scenario: Different wallet attempts to claim a reserved subdomain
- **WHEN** an authenticated user whose wallet does not match the reservation owner sends `POST /projects/v1/:id/subdomains/myapp` while `myapp` has an active reservation
- **THEN** the platform SHALL respond `409 Conflict` with a body indicating `reserved_until` so the caller knows when the name becomes available

#### Scenario: Original owner reclaims a reserved subdomain via a new project
- **WHEN** the wallet that owned the reservation sends `POST /projects/v1/:id/subdomains/myapp` for a new active project
- **THEN** the platform SHALL accept the claim, clear the reservation columns, and update `internal.subdomains.project_id` to point to the new project

#### Scenario: Project is purged and reservation tail expires
- **WHEN** 14 days have passed since `scheduled_purge_at` for a purged project
- **THEN** the platform SHALL allow the subdomain to be claimed by any user

#### Scenario: Site continues to serve during frozen state
- **WHEN** an end-user request hits `myapp.run402.com` for a project in `status = 'frozen'`
- **THEN** the platform SHALL serve the live site normally and SHALL NOT return a payment-required response

### Requirement: Lifecycle email cadence
The platform SHALL send exactly three platform emails to the project's billing contact during the grace window: `project_past_due` on entry to `past_due`, `project_frozen` on entry to `frozen`, and `project_purge_final_warning` 24 hours before `scheduled_purge_at`. Each email SHALL name the project, its current state, and the next transition date.

#### Scenario: Project enters past-due state
- **WHEN** a project transitions from `active` to `past_due`
- **THEN** the platform SHALL enqueue a `project_past_due` email to the billing contact containing the project name and the frozen-transition date (`past_due_since + 14 days`)

#### Scenario: Project enters frozen state
- **WHEN** a project transitions from `past_due` to `frozen`
- **THEN** the platform SHALL enqueue a `project_frozen` email to the billing contact containing the project name, the statement that deploys and control-plane writes are now blocked, and the dormant-transition date (`frozen_at + 30 days`)

#### Scenario: Project is 24 hours away from purge
- **WHEN** the lifecycle scheduler first observes a dormant project whose `scheduled_purge_at < NOW() + 24h`
- **THEN** the platform SHALL enqueue a `project_purge_final_warning` email to the billing contact containing the project name and the exact `scheduled_purge_at` timestamp, and SHALL NOT re-enqueue that email on subsequent ticks

#### Scenario: Billing contact email is unavailable
- **WHEN** the platform attempts to look up the billing contact for a transitioning project and no email is on file
- **THEN** the platform SHALL log a warning, skip the email, and still complete the state transition

### Requirement: Lifecycle scheduler cadence
The platform SHALL run the lifecycle advancement logic at least once per hour, using the same scheduler tick that today owns wallet-lease checking. Transitions SHALL be idempotent: a tick that sees a project already in the correct state for current time SHALL make no changes.

#### Scenario: Hourly tick advances a mid-grace project
- **WHEN** the lifecycle scheduler fires and a project's past-due threshold was crossed 3 minutes before the tick
- **THEN** the platform SHALL transition that project to `frozen` on this tick

#### Scenario: Two concurrent ticks observe the same purge-ready project
- **WHEN** two lifecycle scheduler ticks concurrently observe a dormant project whose `scheduled_purge_at <= NOW()`
- **THEN** the platform SHALL ensure only one tick invokes the purge cascade, using a row-level update guard (`UPDATE ... WHERE status = 'dormant' RETURNING id`)

### Requirement: Operator reactivation endpoint
The platform SHALL expose an admin-authenticated endpoint `POST /projects/v1/admin/:id/reactivate` that transitions a project from any non-terminal lifecycle state back to `active`. The endpoint SHALL be callable only by operators with the `@kychee.com` admin identity.

#### Scenario: Operator reactivates a dormant project for a paying customer
- **WHEN** an operator sends `POST /projects/v1/admin/:id/reactivate` for a project in `status = 'dormant'`
- **THEN** the platform SHALL transition the project to `status = 'active'`, clear all lifecycle timer columns, clear subdomain reservations owned by that project, and log the operator identity and reason in an audit record

#### Scenario: Non-admin calls reactivate endpoint
- **WHEN** a non-admin caller sends `POST /projects/v1/admin/:id/reactivate`
- **THEN** the platform SHALL respond `403 Forbidden`

#### Scenario: Operator attempts to reactivate a purged project
- **WHEN** an operator sends `POST /projects/v1/admin/:id/reactivate` for a project in `status = 'purged'` or `status = 'archived'`
- **THEN** the platform SHALL respond `409 Conflict` with a body indicating the project is terminal and cannot be restored
