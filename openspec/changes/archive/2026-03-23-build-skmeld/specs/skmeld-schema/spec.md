## ADDED Requirements

### Requirement: Core tables exist
The schema SHALL include tables: app_settings, role_definitions, profiles, invites, space_occupancies, properties, space_types, spaces, request_statuses, priority_levels, request_categories, entry_preferences, request_sources, status_transitions, vendors, maintenance_requests, request_comments, attachments, request_events, notification_log. All tables SHALL use snake_case column names and include `metadata JSONB DEFAULT '{}'` on major domain tables.

#### Scenario: Schema deployed successfully
- **WHEN** the schema SQL is applied to a Run402 project
- **THEN** all tables SHALL exist and be queryable via PostgREST

### Requirement: Workflow config is data-driven
Statuses, priorities, categories, entry preferences, request sources, and status transitions SHALL be stored as data tables with text keys — not database enums. This allows agents to customize workflows by inserting/updating rows.

#### Scenario: Default statuses seeded
- **WHEN** seed-base.sql is applied
- **THEN** request_statuses SHALL contain: submitted, triaged, scheduled, in_progress, waiting_on_resident, waiting_on_vendor, resolved, closed, canceled — each with label, color_token, board_order, show_in_board, is_open, is_terminal, resident_visible

#### Scenario: Default priorities seeded
- **WHEN** seed-base.sql is applied
- **THEN** priority_levels SHALL contain: low (72h/168h), normal (24h/72h), high (8h/24h), urgent (2h/8h) with SLA target hours

#### Scenario: Default categories seeded
- **WHEN** seed-base.sql is applied
- **THEN** request_categories SHALL contain: plumbing, electrical, hvac, appliance, lock_access, pest, damage, common_area, cleaning, other — each with label, icon_name, intake_hint

### Requirement: RLS enforces role-based access
RLS policies SHALL enforce: owner_admin and staff see all requests; residents see only their own (where requester_profile_user_id = auth.uid()). Internal comments and events SHALL be hidden from residents.

#### Scenario: Resident cannot see other residents' requests
- **WHEN** a resident queries maintenance_requests via PostgREST with their access_token
- **THEN** they SHALL only see rows where requester_profile_user_id matches their user id

#### Scenario: Resident cannot see internal comments
- **WHEN** a resident queries request_comments for their own request
- **THEN** only rows with visibility = 'public' SHALL be returned

#### Scenario: Staff sees all requests
- **WHEN** a staff user queries maintenance_requests
- **THEN** all rows SHALL be returned regardless of requester

### Requirement: Security-invoker views for efficient reads
The schema SHALL include views: v_request_board (denormalized board cards with joins), v_request_activity (union of events + comments + attachments), v_request_export (flat CSV-friendly), v_request_metrics (aggregates for reports). Views SHALL use SECURITY INVOKER so RLS applies.

#### Scenario: Board view returns denormalized data
- **WHEN** staff queries v_request_board
- **THEN** each row SHALL include: request fields, property/space names, assignee name, vendor name, status label/color, priority label/color, category label/icon, attachment_count, age_hours, is_overdue flags

### Requirement: App settings is single-row config
The app_settings table SHALL be a single-row table with app_name, company_name, logo_url, theme_key, support_email, support_phone, emergency_instructions, time_zone, intake toggles (allow_requester_priority_selection, show_pets_field, show_preferred_visit_window, show_entry_preference), and ui_labels JSONB for terminology customization.

#### Scenario: ui_labels defaults
- **WHEN** seed-base.sql is applied
- **THEN** ui_labels SHALL default to: requester_singular="Resident", property_singular="Property", space_singular="Unit", request_singular="Request" (and plurals)

### Requirement: Demo seed data
A separate seed-demo.sql SHALL create: at least 2 properties with spaces, requests across all key statuses, 1 urgent issue, 1 overdue issue, 1 request with public + internal comments, 1 resolved request awaiting confirmation, 1 common-area request.

#### Scenario: Demo data makes app visually compelling
- **WHEN** seed-demo.sql is applied after seed-base.sql
- **THEN** the board SHALL show populated columns with realistic data across multiple statuses
