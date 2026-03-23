## ADDED Requirements

### Requirement: Auth flow with role-based routing
The app SHALL support signup, login, and invite claim flows. After auth, the app SHALL look up the user's profile to determine role (owner_admin, staff, resident) and route accordingly: staff/admin to /app/board, residents to /app/my-requests.

#### Scenario: Staff login
- **WHEN** a staff user logs in
- **THEN** they SHALL be routed to /app/board

#### Scenario: Resident login
- **WHEN** a resident logs in
- **THEN** they SHALL be routed to /app/my-requests

#### Scenario: Invite claim
- **WHEN** a user opens /claim?token=abc and signs up
- **THEN** the invite SHALL be redeemed, their profile created with the correct role, and they SHALL be routed to their role's home page

### Requirement: Staff board (kanban)
The board SHALL display one column per active open status (from request_statuses where show_in_board=true). Cards SHALL show: request number, title, property+space, requester name, category, priority, age, overdue badge, assignee, photo count. Cards SHALL be draggable between columns (triggering transition_request). Board SHALL support filters: search, property, assignee, category, priority, "mine", "unassigned", "overdue". Board SHALL poll every 15s.

#### Scenario: Board displays populated columns
- **WHEN** staff opens /app/board
- **THEN** columns SHALL appear for each show_in_board status with request cards sorted by urgency/age

#### Scenario: Drag card between columns
- **WHEN** staff drags a card from "New" to "Under review"
- **THEN** transition_request SHALL be called and the card SHALL move optimistically

### Requirement: Request detail view
A detail view SHALL show: header (number, title, status, priority, actions), summary (property/space, requester, category, location, access, schedule, assignee/vendor), photo gallery with lightbox, activity timeline (status changes, comments, assignments chronologically), and a comment composer (public/internal toggle for staff, public-only for residents). On desktop, detail SHALL open as a side drawer over the board. On mobile, full page. Route SHALL update for deep linking.

#### Scenario: Staff opens request detail
- **WHEN** staff clicks a board card
- **THEN** a drawer SHALL open showing the full request detail with all sections

#### Scenario: Resident views own request
- **WHEN** a resident opens /app/requests/:id for their own request
- **THEN** they SHALL see the request detail with only public timeline entries (no internal comments)

### Requirement: Resident report form
The form SHALL include: property selector, optional space/unit, category cards with icons, title, description, room/location, priority (if enabled in settings), entry preference, pets present (if enabled), preferred visit window (if enabled), access instructions, up to 6 photo uploads with previews and client-side compression. Submission SHALL take under 60 seconds. Mobile-first UX with camera-friendly upload. Emergency instruction banner at top.

#### Scenario: Resident submits issue with photos
- **WHEN** a resident fills the form and submits with 3 photos
- **THEN** photos SHALL be compressed client-side, uploaded to storage, and submit_request SHALL be called with the form data + attachment metadata

### Requirement: Resident my-requests list
/app/my-requests SHALL show the resident's requests grouped: open first, resolved-awaiting-confirmation next, recently closed after. Each card SHALL show: request number, title, status, property/unit, updated_at, priority. Tapping opens request detail. Poll every 30s.

#### Scenario: Resident sees their requests
- **WHEN** a resident opens /app/my-requests
- **THEN** they SHALL see only their own requests in grouped order

### Requirement: Admin pages
- **/app/properties**: list/add/edit/archive properties and spaces, CSV import
- **/app/people** (owner_admin only): active users, pending invites, invite staff/resident, CSV import residents
- **/app/vendors**: contact directory with trade/category, phone/email, notes, active/inactive
- **/app/settings** (owner_admin only): app_name, company_name, logo, theme, support contact, emergency instructions, time_zone, intake toggles
- **/app/reports**: KPI cards (open, overdue, unassigned, avg response time), charts by status/category/property, CSV export

#### Scenario: Admin adds property with spaces
- **WHEN** admin opens /app/properties and adds a property with 5 units
- **THEN** the property and spaces SHALL be created via PostgREST

#### Scenario: CSV export
- **WHEN** staff clicks export on /app/reports
- **THEN** a CSV file SHALL download with request data matching current filters

### Requirement: Visual quality bar
The app SHALL have: loading skeletons, optimistic drag/drop, clean empty states, image preview + lightbox, dark mode, AA contrast targets, keyboard-accessible forms, and theme presets (emerald default, blue, indigo, rose, amber). Mobile-responsive across phone/tablet/desktop.

#### Scenario: Dark mode
- **WHEN** user toggles dark mode
- **THEN** all pages SHALL render with dark theme colors while maintaining readability

#### Scenario: Performance
- **WHEN** board loads with 200 open requests
- **THEN** initial load SHALL complete in under 2 seconds
