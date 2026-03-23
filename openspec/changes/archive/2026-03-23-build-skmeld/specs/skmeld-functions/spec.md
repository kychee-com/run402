## ADDED Requirements

### Requirement: submit_request function
POST /functions/v1/submit-request SHALL create a maintenance request with photo attachments. It SHALL verify the caller via getUser(req), enforce that residents can only submit for spaces they occupy, set default priority if requester selection is disabled, create the request in 'submitted' status, snapshot SLA due dates from priority, log a request_event, and return the created request.

#### Scenario: Resident submits request
- **WHEN** a resident calls submit-request with title, description, property_id, space_id, category_key, and attachment metadata
- **THEN** a maintenance_request row SHALL be created with status_key='submitted', requester_profile_user_id set to the caller's user id, and first_response_due_at/resolution_due_at computed from the priority's SLA hours

#### Scenario: Staff submits on behalf of resident
- **WHEN** a staff user calls submit-request with requester_email and requester_name
- **THEN** the request SHALL be created with the provided requester info and created_by_user_id set to the staff user

### Requirement: update_request function
POST /functions/v1/update-request SHALL update staff-controlled metadata (category, priority, assignee, vendor, schedule, access fields) without changing status. Staff/admin only. SHALL log request_events for meaningful changes.

#### Scenario: Staff assigns request
- **WHEN** staff calls update-request with assignee_user_id
- **THEN** the request SHALL be updated and a request_event with event_type='assigned' SHALL be created

### Requirement: transition_request function
POST /functions/v1/transition-request SHALL change request status. It SHALL enforce allowed transitions via the status_transitions table, require a public note when entering waiting_on_resident, require resolution_summary when entering resolved, require cancellation_reason when entering canceled. Residents SHALL only be allowed resolved→closed and resolved→triaged (reopen). It SHALL set timestamps (first_responded_at, resolved_at, closed_at, canceled_at) and log events.

#### Scenario: Staff resolves request
- **WHEN** staff calls transition-request with to_status_key='resolved' and resolution_summary
- **THEN** the request status SHALL change, resolved_at SHALL be set, and a public event SHALL be logged

#### Scenario: Resident reopens resolved request
- **WHEN** a resident calls transition-request with to_status_key='triaged' on a resolved request
- **THEN** the status SHALL change to triaged, resolved_at SHALL be cleared, and a reopen event SHALL be logged

#### Scenario: Invalid transition rejected
- **WHEN** a user attempts a transition not in status_transitions for their role
- **THEN** the function SHALL return 400 with an error message

### Requirement: add_comment function
POST /functions/v1/add-comment SHALL add a public or internal comment to a request. Residents SHALL only add public comments. Comments are append-only. Attachment metadata can be included.

#### Scenario: Resident adds public comment
- **WHEN** a resident calls add-comment with visibility='public' and body text
- **THEN** a request_comment SHALL be created and a public event logged

#### Scenario: Resident cannot add internal comment
- **WHEN** a resident calls add-comment with visibility='internal'
- **THEN** the function SHALL return 403

### Requirement: create_invites function
POST /functions/v1/create-invites SHALL create invite tokens for staff or resident roles. Owner_admin only. For residents, optional space_ids create occupancy intent. SHALL return invite URLs for manual sharing. SHALL send emails if RESEND_API_KEY is configured.

#### Scenario: Admin invites resident
- **WHEN** an admin calls create-invites with email, full_name, role_key='resident', and space_ids
- **THEN** an invite row SHALL be created with a unique token and the response SHALL include the invite URL

### Requirement: redeem_invite function
POST /functions/v1/redeem-invite SHALL complete an invite claim. Requires authenticated caller. SHALL create/update the profile with the invite's role, create space_occupancies if applicable, and mark the invite as accepted.

#### Scenario: User redeems invite
- **WHEN** an authenticated user calls redeem-invite with a valid token
- **THEN** their profile SHALL be created with the invite's role_key, space_occupancies SHALL be created, and the invite's accepted_at SHALL be set

#### Scenario: Expired or used invite rejected
- **WHEN** a user calls redeem-invite with an expired or already-accepted token
- **THEN** the function SHALL return 400

### Requirement: bootstrap function
POST /functions/v1/bootstrap SHALL handle first-admin setup. It SHALL accept admin_email, app_name, and seed_demo_data variables. It SHALL create an admin user via auth signup, insert their profile as owner_admin, update app_settings, optionally run demo seed data, and return a login URL or claim URL.

#### Scenario: Bootstrap with admin setup
- **WHEN** bootstrap is called with admin_email and app_name
- **THEN** an auth user SHALL be created, a profile with role_key='owner_admin' SHALL be inserted, app_settings SHALL be updated with app_name, and the response SHALL include login credentials or a claim URL

#### Scenario: Bootstrap with demo data
- **WHEN** bootstrap is called with seed_demo_data=true
- **THEN** demo properties, spaces, and maintenance requests SHALL be created in addition to admin setup
