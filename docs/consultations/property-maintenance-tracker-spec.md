# Consultation Result

**Model**: gpt-5.4-pro
**Submitted**: 2026-03-21T16:04:01.817951
**Completed**: 2026-03-21T16:52:55.629107
**Status**: completed

---

Here’s the implementation-ready spec.

## Recommended name

**Primary:** **SkMeld**  
Reason: the closest direct category competitor is **Property Meld**, so **SkMeld** is instantly recognizable.

**Safer alt for repo/package slug:** **kymeld**  
Use **SkMeld** as the display/product name, and **kymeld** as the code slug if you want a little more trademark distance.

---

# SkMeld — Property Maintenance Request Tracker
_Open-source, MIT, one-click deployable to Run402_

## 0. Summary

SkMeld is a focused maintenance request tracker for **individual landlords, small property managers, HOAs, and office/facilities managers**.

It is **not** a full property management suite.  
It does **not** do rent, accounting, owner statements, inspections, or enterprise vendor operations.

It does one thing very well:

- users submit maintenance issues with photos
- staff triage them on a beautiful board
- staff update status, assign, schedule, and resolve
- users see progress and can confirm or reopen

This is the right scope for a **SaaS killer**:
- no per-seat pricing
- free to use
- infra-only cost
- open source MIT
- easy to fork and customize by an agent

---

# 1. Competitive analysis

Below is the practical competitor set that matters here. This is based on public product positioning/features known up to mid-2024; exact details may have changed.

## 1.1 Most relevant competitors

| Product | Market | Publicly marketed maintenance spec | What to copy | What not to copy |
|---|---|---|---|---|
| **Property Meld** | Maintenance-specific platform for property managers | Resident maintenance intake, maintenance workflows, vendor coordination, resident communication, automation, reporting/SLA-style analytics | Maintenance-specific lifecycle, resident updates, strong workflow | Deep automation, vendor marketplace/network effects, service-center complexity |
| **Buildium** | SMB/mid-market property management suite | Tenant portal requests, work orders, assignment, vendor management, communication, mobile, tied into broader PM/accounting | Multi-property basics, tenant portal, work-order tracking | Accounting suite, owner statements, broad PM sprawl |
| **AppFolio** | Mid-market / more enterprise PM suite | Online maintenance requests, service workflows, vendor coordination, owner/tenant communication, inspections/operations adjacent | Polished request lifecycle and PM-grade UX ideas | Enterprise breadth, accounting, approval layers, big-suite complexity |
| **DoorLoop** | SMB property management | Maintenance requests, tenant/owner portals, work orders, vendors, communication, reports | SMB simplicity + broad baseline expectations | Full-suite PM breadth we do not need |
| **TenantCloud** | DIY + SMB landlords | Tenant portal, maintenance requests, photos/files, messaging, contractor/vendor coordination, lighter workflows | Low-friction setup, landlord-friendly simplicity | Trying to be “everything” beyond maintenance |
| **Innago** | Smaller landlords / value segment | Tenant portal, maintenance requests, status tracking, communication, lightweight PM | Simplicity, “just get me a portal and tracker” | Underpowered workflow depth if we want a standout board UX |
| **Hemlane** | Remote/self-managing landlords | Maintenance coordination, service pros/contractors, tenant communication, PM assistance | Coordination focus and communication model | Outsourced-service model / operational layer outside software |
| **Fixflo** | Repairs reporting / specialized intake | Guided issue reporting, emergency triage, contractor workflow, repair reporting UX | Better intake UX, category hints, emergency copy | Complex diagnostics/compliance depth for v1 |

## 1.2 Lighter competitors adjacent to the space

These are less workflow-heavy but still shape expectations:

- **TurboTenant**
- **SimplifyEm**
- small landlord portal tools with maintenance tickets

These usually cover:
- tenant portal
- basic maintenance issue reporting
- simple status tracking
- communication

They are useful because they prove the SMB market does **not** need enterprise depth to be useful.

---

## 1.3 Distilled market baseline

Across competitors, the **real baseline** is:

1. **Issue intake** from tenant/user
2. **Photo attachments**
3. **Property/unit/location context**
4. **Status workflow**
5. **Priority/urgency**
6. **Public updates to requester**
7. **Internal notes for staff**
8. **Assignment to staff/vendor**
9. **Simple scheduling window**
10. **Dashboard/reporting/export**
11. **Mobile-friendly experience**

That is what SkMeld must include.

---

## 1.4 What we should deliberately not build in v1

These appear in broad PM suites, but they are **not** necessary for this seed app:

- rent collection
- accounting
- owner statements
- lease management
- inspections/preventive maintenance programs
- procurement / parts inventory
- contractor bidding
- inbound email parsing
- SMS/two-way texting
- native iOS/Android apps
- vendor portal/login
- property-owner approval chains
- call center / after-hours service desk
- enterprise role matrices
- property-level staff ACL complexity

**Positioning:**  
**Take Property Meld’s maintenance focus, TenantCloud/Innago’s simplicity, and Linear/Trello-style UX. Do not become Buildium/AppFolio.**

---

# 2. Product definition

## 2.1 Product statement

**SkMeld** helps residents/users report maintenance issues with photos and lets staff track them from submission to resolution in a modern board-based workflow.

## 2.2 Who it is for

### Primary
- individual landlords
- small property managers
- HOAs
- office/facilities managers
- coworking space operators
- churches / schools / clubs with buildings

### Design center
- **1 deployment = 1 business/workspace**
- **1–20 staff**
- **10–500 spaces**
- **0–10k lifetime requests**
- not enterprise

## 2.3 Opinionated product choices

This app should be intentionally simple:

- **One primary object:** `maintenance_request`
- **One primary staff workflow:** board
- **One primary resident workflow:** list/detail
- **One communication model:** comments on the request
- **One external notification channel:** email
- **One attachment type:** images only
- **One org per deployment:** no multi-org system inside the app
- **One permission model:** global staff, requester-scoped residents

That makes it easy to understand and easy for an agent to fork.

---

# 3. Fit with Run402

## 3.1 Strong fit with current platform

This app fits Run402 well because it needs:

- Postgres
- PostgREST CRUD
- auth
- storage
- static site hosting
- a few serverless functions
- no realtime required
- no vector DB
- no mobile SDK
- no edge runtime required

## 3.2 Recommended default tier

- **Prototype**: demo/testing only
- **Hobby**: recommended default for real SMB usage
- **Team**: multi-property or photo-heavy usage

Because this app stores images, **client-side image compression is required** to keep infra costs low.

---

# 4. Roles and permissions

## 4.1 Roles

### `owner_admin`
Full access:
- settings
- properties/spaces
- people/invites
- vendors
- all requests/reports

### `staff`
Operational access:
- view all requests
- create requests
- triage/assign/update/resolve
- add internal/public comments
- manage vendors
- view/export reports

No access to:
- app settings
- people/invite management
- properties/spaces management

### `resident`
Limited access:
- view own requests only
- submit new requests
- add public comments/photos to own requests
- close or reopen resolved requests

---

## 4.2 Permission matrix

| Action | owner_admin | staff | resident |
|---|---:|---:|---:|
| View all requests | ✅ | ✅ | ❌ |
| View own requests | ✅ | ✅ | ✅ |
| Submit request for self | ✅ | ✅ | ✅ |
| Submit request on behalf of someone else | ✅ | ✅ | ❌ |
| Create internal/common-area request | ✅ | ✅ | ❌ |
| Change status | ✅ | ✅ | limited |
| Reopen resolved request | ✅ | ✅ | ✅ |
| Close resolved request | ✅ | ✅ | ✅ |
| Add public comment | ✅ | ✅ | ✅ |
| Add internal comment | ✅ | ✅ | ❌ |
| Assign staff/vendor | ✅ | ✅ | ❌ |
| Edit due dates/schedule | ✅ | ✅ | ❌ |
| Manage vendors | ✅ | ✅ | ❌ |
| Manage properties/spaces | ✅ | ❌ | ❌ |
| Invite users | ✅ | ❌ | ❌ |
| Edit branding/settings | ✅ | ❌ | ❌ |
| Export reports/CSV | ✅ | ✅ | ❌ |

### Resident transition limit
Resident can only:
- **close** a resolved request
- **reopen** a resolved request

Everything else is staff/admin.

---

# 5. Scope

## 5.1 In scope for v1

### Core operations
- maintenance request submission
- photo upload
- property + optional space selection
- priority
- category
- access/entry details
- staff board
- request detail timeline
- internal/public comments
- staff assignment
- vendor assignment (contact only, no vendor login)
- optional scheduled window
- resolve / close / reopen
- dashboard/reporting
- CSV export
- property/space management
- resident/staff invites
- mobile-responsive UI
- optional email notifications

### Setup/admin
- first-run bootstrap
- branding basics
- emergency instructions
- support email/phone
- CSV import for properties/spaces
- CSV import for resident invites

---

## 5.2 Out of scope for v1

- rent/accounting/owner portal
- inspections/checklists
- native mobile apps
- SMS
- inbound email threading
- public anonymous issue intake
- vendor portal/login
- asset/inventory tracking
- recurring maintenance
- AI triage
- per-property staff permissions
- multi-organization support
- document/PDF attachments
- arbitrary custom fields UI
- workflow editor UI for statuses/transitions

**Note:** statuses/transitions/categories/priorities should still be stored as data tables, but **not** exposed in a full admin editor in v1.

---

# 6. UX / product spec

## 6.1 UX goals

- Resident can submit a request in **under 60 seconds**
- Staff can triage a new request in **under 30 seconds**
- App feels modern, fast, and calm
- Mobile-first for residents
- Beautiful desktop board for staff

## 6.2 Visual direction

- modern SaaS aesthetic, not “legacy proptech”
- use a board UI inspired by Linear/Trello cleanliness
- soft neutrals + strong status colors
- image-forward detail pages
- crisp typography
- subtle motion only
- dark mode supported

## 6.3 Frontend stack

One opinionated stack:

- **React + TypeScript + Vite**
- **Tailwind CSS**
- **shadcn/ui**
- **TanStack Query**
- **React Router**
- **dnd-kit** for board drag/drop
- **react-hook-form + zod** for forms

All dependencies must be MIT/Apache/BSD/SIL-compatible. No GPL/AGPL.

---

## 6.4 Information architecture

### Logged-out
- `/`
- `/login`
- `/claim?token=...`

### Staff/admin
- `/app/board`
- `/app/requests/:request_id`
- `/app/report`
- `/app/properties`
- `/app/people` (owner_admin only)
- `/app/vendors`
- `/app/reports`
- `/app/settings` (owner_admin only)

### Resident
- `/app/my-requests`
- `/app/report`
- `/app/requests/:request_id`
- `/app/account`

---

## 6.5 Key screens

### A. Resident “Report issue” page
Fields:
- property
- optional space/unit
- category
- title
- description
- room / exact location
- priority (if enabled in settings)
- entry preference
- pets present (if enabled)
- preferred visit window (if enabled)
- access instructions
- up to **6 photos**

UX requirements:
- category cards with icons
- helper text/hints per category
- emergency instruction banner at top
- on mobile, camera-friendly upload
- image previews before submit

### B. Resident “My requests”
- open requests first
- resolved-awaiting-confirmation next
- recent closed after that
- each card shows:
  - request number
  - title
  - status
  - property/unit
  - updated_at
  - priority
- tap opens request detail

### C. Staff board
Desktop primary view:
- horizontal kanban board
- one column per active open status
- sticky column headers
- counts per column
- request cards sortable by urgency/age

Board card fields:
- request number
- title
- property + space
- requester name
- category
- priority
- age
- overdue badge if applicable
- assignee avatar/initials
- photo count
- optional thumbnail (first image)

Board filters:
- search
- property
- assignee
- category
- priority
- “mine”
- “unassigned”
- “overdue”

### D. Request detail
Single detail screen used by all roles, with permission-based visibility.

Sections:
1. Header
   - request number
   - title
   - status
   - priority
   - actions
2. Summary
   - property/space
   - requester
   - source
   - category
   - location detail
   - access details
   - schedule
   - assignee/vendor
3. Photos
   - gallery + lightbox
4. Activity timeline
   - status changes
   - comments
   - assignment changes
   - schedule changes
5. Composer
   - public/internal for staff
   - public only for resident
   - image attachments

Desktop:
- opened as side drawer over board
- route still changes so deep links work

Mobile:
- full page

### E. Properties page
- list of properties
- expandable spaces/units
- add/edit/archive property
- add/edit/archive space
- import CSV

### F. People page (owner_admin)
Tabs:
- active users
- pending invites
- import residents CSV
- invite staff/resident

### G. Vendors page
- simple contact directory
- trade/category
- phone/email
- notes
- active/inactive

### H. Reports page
Top KPIs:
- open requests
- overdue requests
- unassigned requests
- avg first response time (30d)

Secondary:
- requests by status
- requests by category
- requests by property
- reopened count (30d)
- CSV export

### I. Settings page
Editable:
- app_name
- company_name
- logo_url
- theme_key
- support_email
- support_phone
- emergency_instructions
- time_zone
- intake toggles:
  - allow_requester_priority_selection
  - show_pets_field
  - show_preferred_visit_window
  - show_entry_preference

Not in v1 UI:
- workflow editor
- category editor
- priority editor
- transition editor

Those remain data-driven but agent/SQL-edited.

---

# 7. Core workflows

## 7.1 Bootstrap / first admin claim

### Required flow
1. App is deployed/forked
2. A bootstrap owner invite is generated
3. Deploy response includes a `bootstrap_url`
4. Owner opens `/claim?token=...`
5. Owner signs up / logs in
6. Invite is redeemed
7. Owner lands on setup wizard

### Setup wizard
1. Set business/app name
2. Set support email/phone
3. Set emergency instructions
4. Add first property
5. Add spaces/units
6. Invite first resident/staff

---

## 7.2 Invite flow

### Owner/admin invites user
- chooses role: `staff` or `resident`
- enters email + name
- for resident, assigns one or more spaces
- system generates single-use invite token
- if email configured: send invite email
- if not: show copyable invite URL

### User claims invite
- opens claim link
- signs up / logs in
- redeem invite
- profile + occupancies created
- pending invite marked accepted

---

## 7.3 Resident submits request

1. Resident opens report form
2. Chooses property and optional space
3. Adds title/description/category/priority
4. Adds location/access details
5. Uploads photos
6. Submits

System behavior:
- request created in `submitted`
- SLA due dates snapshot from priority
- event logged
- attachments stored privately
- internal notification triggered

---

## 7.4 Staff triage

1. Staff sees new request in `submitted`
2. Opens detail drawer
3. Sets/adjusts:
   - category
   - priority
   - assignee
   - vendor
   - schedule
4. Moves request to:
   - `triaged`
   - `scheduled`
   - `in_progress`
   - `waiting_on_resident`
   - `waiting_on_vendor`
5. Adds public note if needed

Rules:
- first staff response should set `first_responded_at`
- moving to `waiting_on_resident` should require a public note
- moving to `resolved` should require a public completion note

---

## 7.5 Work in progress

Staff can:
- add internal notes
- add public updates
- upload after/fix photos
- change assignee
- change vendor
- set or edit schedule

Residents can:
- add public comments/photos to their own requests
- view public timeline only

---

## 7.6 Resolve

Staff marks request `resolved` and must provide:
- resolution_summary
- optional after photos

System behavior:
- set `resolved_at`
- add public event/comment
- notify requester

---

## 7.7 Close or reopen

### Resident closes
If fixed:
- click “Mark fixed / close”
- status -> `closed`
- event logged

### Resident reopens
If not fixed:
- click “Still not fixed”
- must add comment
- status -> `triaged`
- `resolved_at` cleared
- reopen event logged

### Staff/admin can also close or reopen as needed

---

## 7.8 CSV import/export

### CSV import: properties/spaces
Owner/admin uploads CSV:
- preview rows
- validation first
- all-or-nothing import

### CSV import: residents
Owner/admin uploads CSV:
- name
- email
- phone
- property/space assignment
- preview
- creates invites

### CSV export: requests
Export respects filters. Columns include:
- request_number
- title
- property_name
- space_name
- category_key
- priority_key
- status_key
- requester_name
- assignee_name
- vendor_name
- created_at
- first_responded_at
- resolved_at
- closed_at
- resolution_due_at
- scheduled_start_at
- scheduled_end_at

---

# 8. Technical architecture

## 8.1 Data access rule

Use one clear rule:

### Reads
Use **PostgREST** on:
- tables
- security-invoker views

### Workflow writes
Use **serverless functions** for multi-table actions:
- submit request
- update request
- transition request
- add comment
- create invites
- redeem invite

### Simple admin/config CRUD
Use **PostgREST** directly with RLS for:
- properties
- spaces
- vendors
- settings
- profile edits
- archived flags

This is the right balance:
- domain logic stays centralized
- config data stays easy to edit
- advanced agents can customize cleanly

---

## 8.2 Polling, not realtime

Run402 does not currently have realtime/WebSockets. That is fine.

Use:
- board polling every **15s** when tab active
- request detail polling every **10–15s**
- resident pages polling every **30s**
- refetch on window focus
- optimistic UI for local actions

Realtime is **not required** for v1.

---

## 8.3 Storage

Use one private bucket:

- **`request-photos`**

Rules:
- images only
- max **6 photos** on initial request
- max **4 photos** per comment
- client-side compression required
- EXIF stripped if possible
- no public bucket for request images

Image policy:
- max long edge ~1600px
- target compressed size under ~700KB/image
- JPEG/WebP preferred

This matters a lot for infra cost control.

---

# 9. Data model

## 9.1 General modeling rules

- use **snake_case**
- avoid DB enums
- use **text keys + FK tables** for configurable workflow data
- use **plain SQL migrations**
- no ORM
- no workflow/business triggers
- add `metadata jsonb default '{}'` to major domain tables as escape hatch for forks

Also: use generic schema nouns where useful.

Example:
- `spaces`, not `units`
- `profiles`, not `tenants`

Default UI can still say “Resident” and “Unit”.

---

## 9.2 Tables

## A. App/settings

### `app_settings`
Single-row app config.

Key fields:
- `id`
- `app_name`
- `company_name`
- `logo_url`
- `theme_key`
- `support_email`
- `support_phone`
- `emergency_instructions`
- `time_zone`
- `allow_requester_priority_selection`
- `show_pets_field`
- `show_preferred_visit_window`
- `show_entry_preference`
- `ui_labels jsonb`
- `metadata jsonb`
- `created_at`
- `updated_at`

### `ui_labels` default
```json
{
  "requester_singular": "Resident",
  "requester_plural": "Residents",
  "property_singular": "Property",
  "property_plural": "Properties",
  "space_singular": "Unit",
  "space_plural": "Units",
  "request_singular": "Request",
  "request_plural": "Requests"
}
```

---

## B. People/auth

### `role_definitions`
Seeded:
- `owner_admin`
- `staff`
- `resident`

Fields:
- `key`
- `label`
- `sort_order`

### `profiles`
One row per app user.

Fields:
- `user_id` (auth user id, PK)
- `email`
- `full_name`
- `phone`
- `role_key`
- `is_active`
- `created_at`
- `updated_at`
- `metadata jsonb`

### `invites`
Fields:
- `id`
- `email`
- `full_name`
- `role_key`
- `token`
- `expires_at`
- `accepted_at`
- `invited_by_user_id`
- `created_at`
- `metadata jsonb`

### `space_occupancies`
Assigns residents to spaces.

Fields:
- `id`
- `profile_user_id`
- `space_id`
- `start_date`
- `end_date`
- `is_primary`
- `created_at`
- `metadata jsonb`

---

## C. Property structure

### `properties`
Fields:
- `id`
- `name`
- `code`
- `street_1`
- `street_2`
- `city`
- `state`
- `postal_code`
- `country`
- `notes`
- `is_active`
- `created_at`
- `updated_at`
- `metadata jsonb`

### `space_types`
Seeded examples:
- `unit`
- `common_area`
- `suite`
- `office`
- `room`
- `amenity`
- `parking`
- `other`

### `spaces`
Fields:
- `id`
- `property_id`
- `name`
- `code`
- `space_type_key`
- `floor`
- `notes`
- `is_active`
- `created_at`
- `updated_at`
- `metadata jsonb`

---

## D. Workflow config

### `request_statuses`
Seeded with stable keys and editable labels.

Recommended defaults:

| key | default label | show_in_board | is_open | resident_visible |
|---|---|---:|---:|---:|
| `submitted` | New | ✅ | ✅ | ✅ |
| `triaged` | Under review | ✅ | ✅ | ✅ |
| `scheduled` | Scheduled | ✅ | ✅ | ✅ |
| `in_progress` | In progress | ✅ | ✅ | ✅ |
| `waiting_on_resident` | Waiting on you | ✅ | ✅ | ✅ |
| `waiting_on_vendor` | Waiting on contractor | ✅ | ✅ | ✅ |
| `resolved` | Marked fixed | ✅ | ✅ | ✅ |
| `closed` | Closed | ❌ | ❌ | ✅ |
| `canceled` | Canceled | ❌ | ❌ | ✅ |

Fields:
- `key`
- `label`
- `color_token`
- `board_order`
- `show_in_board`
- `is_open`
- `is_terminal`
- `resident_visible`
- `created_at`
- `updated_at`

### `priority_levels`
Defaults:

| key | label | first response hrs | resolution hrs |
|---|---|---:|---:|
| `low` | Low | 72 | 168 |
| `normal` | Normal | 24 | 72 |
| `high` | High | 8 | 24 |
| `urgent` | Urgent | 2 | 8 |

Fields:
- `key`
- `label`
- `color_token`
- `sort_order`
- `target_first_response_hours`
- `target_resolution_hours`
- `is_default`

### `request_categories`
Seeded defaults:
- `plumbing`
- `electrical`
- `hvac`
- `appliance`
- `lock_access`
- `pest`
- `damage`
- `common_area`
- `cleaning`
- `other`

Fields:
- `key`
- `label`
- `icon_name`
- `intake_hint`
- `sort_order`
- `is_active`

### `entry_preferences`
Defaults:
- `can_enter_if_away`
- `contact_first`
- `do_not_enter_without_me`

### `request_sources`
Defaults:
- `portal`
- `phone`
- `email`
- `walkthrough`
- `staff`

### `status_transitions`
Stores allowed transitions.

Fields:
- `id`
- `from_status_key`
- `to_status_key`
- `actor_role_key`
- `created_at`

This makes the workflow changeable by agents without rewriting core logic.

---

## E. Operations

### `vendors`
Fields:
- `id`
- `name`
- `primary_contact_name`
- `email`
- `phone`
- `trade_category_key`
- `notes`
- `is_active`
- `created_at`
- `updated_at`
- `metadata jsonb`

### `maintenance_requests`
Main object. No separate `work_orders` table in v1.

Fields:
- `id`
- `request_number` (identity sequence)
- `title`
- `description`
- `property_id`
- `space_id` nullable
- `category_key`
- `priority_key`
- `status_key`
- `source_key`
- `requester_profile_user_id` nullable
- `requester_name`
- `requester_email`
- `requester_phone`
- `created_by_user_id`
- `assignee_user_id` nullable
- `vendor_id` nullable
- `location_detail`
- `entry_preference_key` nullable
- `pets_present` nullable
- `preferred_visit_window` nullable
- `access_instructions` nullable
- `scheduled_start_at` nullable
- `scheduled_end_at` nullable
- `first_response_due_at`
- `resolution_due_at`
- `first_responded_at` nullable
- `resolved_at` nullable
- `closed_at` nullable
- `canceled_at` nullable
- `resolution_summary` nullable
- `cancellation_reason` nullable
- `created_at`
- `updated_at`
- `metadata jsonb`

### `request_comments`
Fields:
- `id`
- `request_id`
- `author_user_id`
- `visibility` (`public` / `internal`)
- `body`
- `created_at`
- `metadata jsonb`

### `attachments`
Fields:
- `id`
- `request_id`
- `comment_id` nullable
- `uploaded_by_user_id`
- `visibility`
- `bucket`
- `object_path`
- `file_name`
- `mime_type`
- `size_bytes`
- `width` nullable
- `height` nullable
- `created_at`
- `metadata jsonb`

### `request_events`
Audit/event stream.

Fields:
- `id`
- `request_id`
- `actor_user_id` nullable
- `event_type`
- `visibility`
- `summary`
- `payload jsonb`
- `created_at`

### `notification_log`
Fields:
- `id`
- `request_id` nullable
- `recipient_email`
- `template_key`
- `delivery_status`
- `error_message` nullable
- `sent_at` nullable
- `created_at`

---

# 10. Views

Create these as **security invoker** views.

### `v_request_board`
Denormalized board card view:
- request core fields
- joined property/space names
- assignee name
- vendor name
- status label/color/order
- priority label/color
- category label/icon
- attachment_count
- age_hours
- is_overdue_response
- is_overdue_resolution

### `v_request_activity`
Union of:
- events
- comments
- attachment summaries

Sorted chronologically.

### `v_request_export`
Flat export-friendly view for CSV.

### `v_request_metrics`
Aggregates for reports:
- open_count
- overdue_count
- unassigned_count
- avg_first_response_hours
- avg_resolution_hours
- reopened_count_30d
- grouped counts

---

# 11. Functions / API contracts

## 11.1 `POST /functions/v1/submit_request`

Purpose:
- create request
- attach uploaded image metadata
- log event
- send notifications

Input:
- request fields from report form
- attachment metadata array

Rules:
- resident can only submit for active occupied property/space
- staff/admin can submit for any property
- if resident and priority selection disabled, force `normal`
- creates request in `submitted`

Returns:
- created request object

---

## 11.2 `POST /functions/v1/update_request`

Purpose:
- edit staff-controlled request metadata without a status change

Allowed fields:
- category_key
- priority_key
- assignee_user_id
- vendor_id
- scheduled_start_at
- scheduled_end_at
- resolution_due_at
- location_detail
- access fields
- requester contact snapshot fields (staff only)

Rules:
- staff/admin only
- log event rows for meaningful changes

Returns:
- updated request

---

## 11.3 `POST /functions/v1/transition_request`

Purpose:
- status changes

Input:
- request_id
- to_status_key
- optional public note
- optional internal note
- optional resolution_summary
- optional cancellation_reason

Rules:
- enforce allowed transitions via `status_transitions`
- resident only allowed:
  - `resolved -> closed`
  - `resolved -> triaged`
- entering `waiting_on_resident` requires public note
- entering `resolved` requires resolution summary/public note
- entering `canceled` requires reason
- set timestamps accordingly
- log event
- notify requester if public/resident-visible

Returns:
- updated request

---

## 11.4 `POST /functions/v1/add_comment`

Purpose:
- add public/internal comment
- register attached images
- notify recipients

Input:
- request_id
- visibility
- body
- attachment metadata array

Rules:
- resident can only add `public`
- internal comments hidden from residents
- comments are append-only in v1

Returns:
- created comment

---

## 11.5 `POST /functions/v1/create_invites`

Purpose:
- single or bulk invite creation

Input:
- array of invites:
  - email
  - full_name
  - role_key
  - optional space_ids

Behavior:
- owner_admin only
- create tokens
- create occupancy-intent metadata for residents
- send emails if configured
- always return invite URLs for manual sharing

Returns:
- invite records + invite URLs + send result status

---

## 11.6 `POST /functions/v1/redeem_invite`

Purpose:
- complete account claim

Input:
- token

Behavior:
- requires authenticated user
- create/update profile
- apply role
- create occupancies
- mark invite accepted

Returns:
- current profile + app access summary

---

# 12. Security / RLS

## 12.1 Core RLS model

### `profiles`
- user can read/update self
- owner_admin can read/update all
- staff can read basic profile info needed for operations
- residents cannot read other users

### `space_occupancies`
- owner_admin full access
- resident reads own occupancies only
- staff no need for broad access unless needed for request creation UX

### `properties`, `spaces`, `vendors`
- owner_admin full
- staff read all
- residents read only what they need for own request form

### `maintenance_requests`
- owner_admin/staff: read all
- resident: read only rows where `requester_profile_user_id = auth.uid()`

### `request_comments`, `attachments`, `request_events`
- owner_admin/staff: read all
- resident: only where request belongs to them and `visibility = public`

### `invites`
- owner_admin only
- users do not query invites directly except through function behavior

## 12.2 Important privacy choices

- residents **do not** see other residents’ requests, even in the same unit
- internal notes are hidden from residents
- vendor/internal assignment details are internal by default
- request images are private storage objects
- no public object URLs for request photos

## 12.3 Auditability

- every status change writes `request_events`
- every assignment change writes `request_events`
- no destructive delete for requests in UI
- comments are append-only in v1

---

# 13. Notifications

## 13.1 Notification channel

V1 supports **email only**.

Use Resend if configured, because it is already a good fit for Run402 functions.

### Optional secrets
- `RESEND_API_KEY`
- `MAIL_FROM`

If these are absent:
- app still works
- invite links can be copied manually
- status emails are skipped
- `notification_log` records skipped state

## 13.2 Notification triggers

### Internal
- new request submitted -> owner_admins + support email
- resident public comment -> assignee if set, else owner_admins

### External/requester
- request submitted confirmation
- public comment from staff
- status changed to scheduled/in_progress/waiting_on_resident/resolved/closed/canceled
- reopen acknowledgment

### Vendor
Optional:
- vendor assigned -> send summary email to vendor contact

No SMS, no push, no inbound email sync.

---

# 14. Reporting

## 14.1 Required report outputs

- open requests
- overdue requests
- unassigned requests
- average first response time
- average resolution time
- requests by status
- requests by category
- requests by property
- reopened count
- CSV export

## 14.2 Date logic

- use wall-clock hours, not business-hours calendars
- timestamps stored UTC
- displayed in `app_settings.time_zone`

---

# 15. Beautiful-from-day-1 requirements

## 15.1 UI quality bar

- responsive on phone/tablet/desktop
- loading skeletons
- optimistic drag/drop
- clean empty states
- image preview + lightbox
- board/detail route sync
- dark mode
- keyboard accessible forms
- AA-ish contrast targets

## 15.2 Theme

Use theme presets:
- `emerald` (default)
- `blue`
- `indigo`
- `rose`
- `amber`

Status colors use separate `color_token` values.

## 15.3 Performance targets

- board initial load under ~2s for 200 open requests
- detail open under ~300ms after data cached
- mobile submit flow should feel instant aside from upload time
- lazy-load images

---

# 16. Seed/demo/package requirements

## 16.1 Marketplace bundle contents

Include:
- SQL schema
- SQL seed base
- RLS policies
- security-invoker views
- functions source
- site assets
- documentation
- tests

## 16.2 Important publish/fork rule

**Published marketplace version must be clean.**

That means:
- no real users
- no invite tokens
- no demo requests in the production fork bundle

Use:
- `seed_base.sql` for published template
- separate `seed_demo.sql` for public demo deployment only

## 16.3 Demo data requirements

Public demo should include:
- at least 2 properties
- several spaces
- requests across all key statuses
- 1 urgent issue
- 1 overdue issue
- 1 request with resident/public/internal comments
- 1 resolved request waiting confirmation
- 1 common-area request

This makes the app visually compelling immediately.

---

# 17. Documentation requirements

Repo must include:

- `README.md`
- `LICENSE` (MIT)
- `docs/setup.md`
- `docs/customization.md`
- `docs/data-dictionary.md`
- `docs/fork-prompts.md`
- `docs/testing.md`

## 17.1 Customization docs must explicitly show

How to change:
- branding
- support phone/email
- emergency copy
- category list
- priority list
- status labels/order
- terminology via `ui_labels`
- default spaces for non-residential forks

## 17.2 Fork prompts

Include prompts like:

1. **HOA fork**  
   “Fork SkMeld into an HOA common-area issue tracker. Rename Resident to Member, Unit to Home, add categories for landscaping, gate access, pool, clubhouse, and parking lot lighting.”

2. **Office manager fork**  
   “Fork SkMeld into an office facilities tracker. Rename Resident to Employee, Unit to Suite, hide pets field, add categories for AV, restroom, janitorial, badge access, and conference rooms.”

3. **Church / nonprofit building fork**
   “Fork SkMeld into a facilities request app for a church campus. Rename Property to Building, Unit to Room, add categories for sanctuary AV, kitchen, nursery, and grounds.”

### Bootstrap examples

These use the platform's bootstrap convention — pass variables at fork time, the bootstrap function handles setup:

```json
POST /fork/v1
{
  “version_id”: “ver_skmeld_v1”,
  “name”: “sunrise-properties”,
  “bootstrap”: {
    “admin_email”: “manager@sunrise.com”,
    “app_name”: “Sunrise Properties”,
    “seed_demo_data”: true
  }
}
```

Response includes `bootstrap_result` with login URL for the first admin.

```json
POST /fork/v1
{
  “version_id”: “ver_skmeld_v1”,
  “name”: “oak-valley-hoa”,
  “bootstrap”: {
    “admin_email”: “board@oakvalley.org”,
    “app_name”: “Oak Valley HOA”,
    “seed_demo_data”: false
  }
}
```

---

# 18. Testing requirements

This app should be fully tested.

## 18.1 Test layers

### SQL / RLS tests
Verify:
- resident cannot read another resident’s request
- resident cannot read internal comments
- staff can read all requests
- owner_admin can manage settings/invites
- archived/inactive rows behave correctly

### Function tests
Verify:
- `submit_request`
- `update_request`
- `transition_request`
- `add_comment`
- `create_invites`
- `redeem_invite`

### Frontend tests
Verify:
- form validation
- board rendering
- route behavior
- role-based visibility
- mobile nav/layout basics

### End-to-end tests
At minimum:
1. bootstrap owner claim
2. owner adds property + spaces
3. owner invites resident
4. resident submits request with photos
5. staff sees request on board
6. staff triages and assigns
7. staff adds internal note
8. resident cannot see internal note
9. staff resolves
10. resident reopens
11. staff resolves again
12. resident closes
13. export CSV works

### Visual regression
Snapshot key screens:
- resident report form
- resident request detail
- staff board
- request drawer
- light and dark mode

---

# 19. Run402 requirements / gaps

These are the important platform requirements this app needs.

## 19.1 ~~Blocker~~ Resolved

### ~~1. Authenticated function caller identity~~ — SHIPPED

~~For app-domain actions, functions need a standard way to know who is calling.~~

**Resolved:** `getUser(req)` is now exported from `@run402/functions`. It verifies the caller's JWT and returns `{ id, role }` or `null`. Deployed to production and fully tested. Functions use it as:

```typescript
import { db, getUser } from '@run402/functions';

export default async (req) => {
  const user = getUser(req);
  if (!user) return new Response('Unauthorized', { status: 401 });
  // user.id and user.role available for authorization checks
};
```

---

## ~~19.2 Blocker~~ Resolved

### ~~2. Fork/deploy-time app variables + bootstrap output~~ — SHIPPED

~~This app needs a clean first-admin bootstrap flow.~~

**Resolved:** Bootstrap function convention is now live. Fork and deploy endpoints accept an optional `bootstrap` object with arbitrary variables. If the app includes a function named `bootstrap`, the platform auto-invokes it after deployment with those variables. The response includes `bootstrap_result` (the function's return value) or `bootstrap_error` (if it failed — the fork still succeeds).

```json
POST /fork/v1
{
  "version_id": "ver_skmeld_v1",
  "name": "sunrise-properties",
  "bootstrap": {
    "admin_email": "manager@sunrise.com",
    "app_name": "Sunrise Properties",
    "seed_demo_data": true
  }
}
```

The bootstrap function handles first-admin creation, app configuration, and optional demo data seeding. Published apps can declare expected variables in `run402.yaml` for agent discoverability via `GET /apps/v1/:versionId`. Bootstrap can also be re-invoked manually via `POST /functions/v1/bootstrap`.

---

## 19.3 Important, but not a blocker for v1

### 3. Password reset / magic-link auth
Not documented in the provided Run402 summary.

This app can technically launch without it, but SMB polish is much better with:
- password reset
- or magic-link sign-in

For v1 workaround:
- owner/admin can resend invite links
- but proper password reset is strongly recommended platform-wide

---

## 19.4 Nice-to-have, not required

### 4. Scheduled jobs
Would help later with:
- reminder emails
- auto-close after N days
- daily digest

Not required for v1.

### 5. Realtime
Nice for live board updates, but polling is good enough for v1.

---

# 20. Implementation order

This is the fastest practical build path.

1. **Adapt existing board shell from Krello/Prello**
   - board columns
   - card components
   - drawer behavior
   - drag/drop interactions

2. **Build SQL schema + seed_base**
   - tables
   - reference data
   - views
   - RLS

3. **Build bootstrap + invite flow**
   - claim page
   - create_invites
   - redeem_invite

4. **Build resident flow**
   - login
   - my requests
   - report issue
   - request detail

5. **Build staff flow**
   - board
   - detail drawer
   - update/transition functions
   - comments

6. **Build admin setup**
   - properties/spaces
   - vendors
   - settings
   - CSV import

7. **Build reports/export**

8. **Wire optional email notifications**

9. **Add demo data + demo deploy**

10. **Finish tests/docs and publish to marketplace**

---

# 21. Final product positioning

## SkMeld should be marketed as:

**“Maintenance requests with photos, a real triage board, and resident updates — open source, forkable, no seat fees.”**

It should compete by being:
- focused
- beautiful
- cheap to run
- easy to customize
- understandable by agents
- not bloated

---

# 22. Short verdict

**Yes — this is a very good Run402 marketplace app.**  
It maps well to existing platform capabilities, especially because it does **not** require realtime or enterprise infrastructure.

The right product is:

- **Property Meld’s maintenance focus**
- **TenantCloud/Innago-level SMB simplicity**
- **Linear/Trello-style UX**
- **Run402-native open source / infra-only economics**

**Best name:** **SkMeld**

If you want, I can next turn this into:
1. a file-by-file repo layout,  
2. exact SQL table definitions, or  
3. a page-by-page acceptance checklist for implementation.

---
**Wall time**: 48m 53s
**Tokens**: 65,727 input, 16,794 output (16,794 reasoning), 82,521 total
**Estimated cost**: $4.9947
