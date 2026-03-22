# Consultation Result

**Model**: gpt-5.4-pro
**Submitted**: 2026-03-21T20:21:16.139807
**Completed**: 2026-03-21T21:22:57.296079
**Status**: completed

---

Below is an implementation-ready spec for **sklinear**.

## 0. Product summary

**sklinear** = **Linear-like UX** + **Plane-style ownership** + **Shortcut-level planning simplicity**, built for **individuals and SMBs**, not enterprise.

Core promise:

- **No seat pricing**
- **MIT licensed**
- **One-click deploy to Run402**
- **Own your infra + data**
- **Fast, beautiful, keyboard-first**
- **Opinionated by default**
- **Easy for coding agents to fork/customize**

Important product choices:

- **Single workspace per deployment**
- **All data visible to all workspace members** in v1
  - No private teams/projects
  - No guest users
- **Every issue belongs to one team**
- **One assignee per issue**, many subscribers
- **Projects + cycles + labels + comments + attachments + inbox**
- **Roadmap = projects timeline**
- **No docs / initiatives / custom fields / automations / enterprise auth in v1**
- **No DB triggers**
- **All writes go through `function.js`**
- **Browser reads via PostgREST**
- **No-build static SPA** (`index.html + app.js + styles.css`)
- **Hash routing** (`#/...`) to avoid SPA rewrite requirements

This is the right scope for a second major forkable Run402 app.

---

# 1. Competitive analysis

Competitor summaries are high-level; their products evolve, but this is the relevant implementation baseline.

## 1.1 Comparison matrix

| Product | Core model | Best parts | Weak parts for our target | What sklinear should copy | What sklinear should avoid |
|---|---|---|---|---|---|
| **Linear** | teams, issues, projects, cycles, views, inbox, command menu, labels, comments, attachments, roadmap | Best UX, keyboard-first, fast, opinionated, beautiful | Closed source, seat-priced, expanding toward bigger-company complexity | Interaction model, issue modal, command palette, speed, team workflows | Docs/initiatives/enterprise surface area |
| **Shortcut** | stories, epics, milestones, objectives, iterations, workflows, roadmap | Good planning hierarchy, simple iteration planning | Less polished than Linear, story/agile terminology can feel rigid | Cycles/iterations and lightweight planning | Agile jargon overload |
| **Plane** | open-source workspaces, issues, cycles, modules, states, pages | Ownership + self-host story, configurable workflows | Broader/heavier, less opinionated, less polished | Open source/self-host posture, editable workflow tables | Large surface area and complexity |
| **Huly** | tasks/issues + docs + chat + broader collaboration suite | Big ownership story, ambitious integrated suite | Too broad for v1, not focused enough for issue tracking | Ownership narrative | Chat/docs/drive expansion |
| **Height** | tasks/projects/views/automation/AI | Nice UX ideas, automation mindset | Discontinued/pivoted, not a stable baseline | Some polish and automation inspiration later | Building “magic” into v1 |
| **Jira** | projects, issue types, workflows, sprints, boards, custom fields, permissions | Very powerful and mature | Enterprise-heavy, over-configurable, admin burden, ugly UX | Nothing beyond a few workflow concepts | Permission matrix, custom-field sprawl, enterprise complexity |
| **GitHub Projects** | issues, labels, milestones, projects, code-adjacent planning | Familiar to devs, simple issue model | Repo-centric, weak for broader SMB operations/product tracking | Lean issue concepts | Coupling to code hosting |

## 1.2 Competitor feature summary

### Linear
**Spec summary**
- Team-scoped workflows/states
- Issue IDs like `ENG-123`
- Projects, cycles, roadmap
- Keyboard shortcuts, command palette
- Fast issue modal
- Inbox/notifications
- Labels, comments, attachments
- Saved views / filters

**Conclusion**  
This is the primary UX benchmark.

---

### Shortcut
**Spec summary**
- Stories, epics, milestones, objectives
- Iterations
- Workflow states
- Planning/roadmap
- Docs
- Board/list planning

**Conclusion**  
Useful for cycle planning and simple planning hierarchy, but don’t copy the terminology.

---

### Plane
**Spec summary**
- Open-source/self-hostable project and issue tracking
- Projects, issues, cycles, states
- Modules/pages
- Multiple views
- Good workflow flexibility

**Conclusion**  
Best ownership/open-source reference, but too broad for our v1.

---

### Huly
**Spec summary**
- Tasks/issues plus docs/chat/collaboration
- Broader workspace suite

**Conclusion**  
Shows the ownership value prop, but it is much wider than the problem we should solve first.

---

### Height
**Spec summary**
- Tasks, projects, automations, AI-ish workflow ideas
- Strong UX emphasis

**Conclusion**  
Good reminder that “snappy + beautiful” matters. Do not build automations/AI into base v1.

---

### Jira
**Spec summary**
- Highly configurable projects, workflows, issue types, permissions, automations, custom fields

**Conclusion**  
Exactly what we should not become.

---

## 1.3 Final positioning

**sklinear should be:**
- **Linear’s feel**
- **Shortcut’s planning simplicity**
- **Plane’s ownership**
- **None of Jira’s complexity**

---

# 2. Product spec

## 2.1 Target users

- Solo founders
- Small software/product teams
- Agencies
- SMB internal ops/product/dev teams
- Technical-but-not-enterprise users

## 2.2 Goals

1. Replace Linear/Shortcut/Jira for many small teams
2. Feel premium on day 1
3. Be easy for an agent to fork/customize
4. Be deployable in one click on Run402
5. Keep infra and operational footprint tiny
6. Fit Run402’s “one app per tenant” model

## 2.3 Non-goals for v1

Do **not** ship these in base v1:

- Docs/wiki
- Initiatives / OKRs / objectives
- Private teams
- Private projects
- Guests / external collaborators
- Custom fields
- Workflow automation rules
- GitHub/Slack sync
- Time tracking
- SSO/SCIM
- Multi-workspace per deploy
- Native mobile app

## 2.4 Opinionated product rules

- One workspace per deploy
- All members can see all issues/projects/teams
- Teams have customizable statuses
- Statuses are rows, not enums
- Priorities/types/project statuses are rows, not enums
- Business logic lives in `function.js`
- Browser writes **never** go straight to PostgREST
- Projects can span teams
- Cycles are team-scoped
- One assignee, many subscribers
- Markdown only, no rich text editor
- Attachments are issue-level, not inline comment attachments
- Roadmap is derived from projects, not a separate object

---

# 3. Permissions

## 3.1 Roles

### Workspace roles
- `owner`
- `admin`
- `member`

### Team roles
- `lead`
- `member`

## 3.2 Permission matrix

| Action | owner/admin | team lead | member |
|---|---:|---:|---:|
| View workspace data | yes | yes | yes |
| Edit own profile | yes | yes | yes |
| Create/edit issues | yes | yes | yes |
| Comment / subscribe | yes | yes | yes |
| Create/edit projects | yes | yes | yes |
| Create/edit labels | yes | yes | yes |
| Create personal saved views | yes | yes | yes |
| Create/edit team cycles | yes | yes (own team) | no |
| Create/edit team statuses | yes | yes (own team) | no |
| Manage team membership | yes | yes (own team) | no |
| Create/archive teams | yes | no | no |
| Invite/remove workspace members | yes | no | no |
| Edit workspace branding/settings | yes | no | no |
| Edit priorities/types/project statuses | yes | no | no |
| Create shared workspace views | yes | no | no |
| Create shared team views | yes | yes (own team) | no |
| Export workspace JSON | yes | no | no |

---

# 4. Repo/file structure

Matches Krello:

```txt
sklinear/
  schema.sql
  function.js
  deploy.ts
  site/
    index.html
    app.js
    styles.css
    favicon.svg
```

Recommended extra repo dirs:

```txt
  tests/
    schema.test.js
    function.test.js
    e2e.spec.js
```

---

# 5. Data model (`schema.sql`)

## 5.1 Design notes

- Single workspace per deployment
- No triggers
- All writes go through `function.js`
- RLS is primarily for **read access** from browser/PostgREST
- Functions use service/privileged DB access
- Denormalized access arrays follow the Krello pattern:
  - `workspace.member_ids`
  - `workspace.admin_ids`
  - `teams.member_ids`
  - `teams.lead_ids`
- Arrays are maintained by functions, not triggers
- Orderable entities use `position DOUBLE PRECISION`

---

## 5.2 Full schema.sql

```sql
-- schema.sql
-- Browser clients use PostgREST for reads only.
-- All writes happen via function.js.
-- No DB triggers. Functions must update updated_at and access arrays.

create extension if not exists pgcrypto;

-- =========================================================
-- Profiles
-- =========================================================
create table profiles (
  user_id uuid primary key,
  email text,
  username text not null check (username ~ '^[a-z0-9_]{2,32}$'),
  display_name text not null check (char_length(display_name) between 1 and 80),
  full_name text,
  avatar_url text,
  bio text not null default '',
  timezone text not null default 'UTC',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index profiles_username_lower_idx
  on profiles (lower(username));

create unique index profiles_email_lower_idx
  on profiles (lower(email))
  where email is not null;

-- =========================================================
-- Workspace (singleton)
-- =========================================================
create table workspace (
  id uuid primary key default gen_random_uuid(),
  singleton_key boolean not null default true unique check (singleton_key),
  name text not null check (char_length(name) between 1 and 120),
  slug text not null check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  icon text,
  logo_url text,
  accent_color text not null default '#5E6AD2',
  owner_user_id uuid not null references profiles(user_id),
  member_ids uuid[] not null default '{}'::uuid[],
  admin_ids uuid[] not null default '{}'::uuid[],
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (admin_ids <@ member_ids),
  check (owner_user_id = any(member_ids)),
  check (owner_user_id = any(admin_ids))
);

create unique index workspace_slug_lower_idx
  on workspace (lower(slug));

create table workspace_members (
  user_id uuid primary key references profiles(user_id),
  role text not null check (role in ('owner', 'admin', 'member')),
  invited_by uuid references profiles(user_id),
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index workspace_members_active_role_idx
  on workspace_members (role)
  where is_active;

create unique index workspace_members_owner_unique_idx
  on workspace_members ((role))
  where role = 'owner' and is_active;

create table workspace_invites (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  role text not null check (role in ('admin', 'member')),
  token text not null unique,
  invited_by uuid not null references profiles(user_id),
  initial_team_ids uuid[] not null default '{}'::uuid[],
  max_uses integer not null default 1 check (max_uses > 0),
  use_count integer not null default 0 check (use_count >= 0),
  expires_at timestamptz,
  accepted_at timestamptz,
  accepted_by uuid references profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index workspace_invites_email_idx
  on workspace_invites (lower(email));

-- =========================================================
-- Teams
-- =========================================================
create table teams (
  id uuid primary key default gen_random_uuid(),
  key text not null check (key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  name text not null check (char_length(name) between 1 and 80),
  description text not null default '',
  icon text,
  color text not null default '#5E6AD2',
  member_ids uuid[] not null default '{}'::uuid[],
  lead_ids uuid[] not null default '{}'::uuid[],
  issue_counter integer not null default 0 check (issue_counter >= 0),
  is_archived boolean not null default false,
  position double precision not null default 1000,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid not null references profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (lead_ids <@ member_ids)
);

create unique index teams_key_lower_idx
  on teams (lower(key));

create unique index teams_name_lower_idx
  on teams (lower(name));

create index teams_position_idx
  on teams (position);

create table team_members (
  team_id uuid not null references teams(id) on delete cascade,
  user_id uuid not null references profiles(user_id),
  role text not null check (role in ('lead', 'member')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

create index team_members_user_idx
  on team_members (user_id, team_id);

create table team_statuses (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9_]{2,40}$'),
  name text not null check (char_length(name) between 1 and 80),
  category text not null check (category in ('backlog', 'unstarted', 'started', 'completed', 'canceled')),
  color text not null default '#6B7280',
  icon text,
  position double precision not null default 1000,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, key)
);

alter table team_statuses
  add constraint team_statuses_id_team_id_unique unique (id, team_id);

create unique index team_statuses_team_name_lower_idx
  on team_statuses (team_id, lower(name));

create unique index team_statuses_default_per_team_idx
  on team_statuses (team_id)
  where is_default;

create index team_statuses_team_category_position_idx
  on team_statuses (team_id, category, position);

-- =========================================================
-- Workspace-level workflow dictionaries
-- =========================================================
create table issue_priorities (
  id uuid primary key default gen_random_uuid(),
  key text not null check (key ~ '^[a-z0-9_]{2,40}$'),
  name text not null check (char_length(name) between 1 and 40),
  level smallint not null check (level between 0 and 100),
  color text not null default '#6B7280',
  icon text,
  position double precision not null default 1000,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (key)
);

create unique index issue_priorities_name_lower_idx
  on issue_priorities (lower(name));

create unique index issue_priorities_level_idx
  on issue_priorities (level);

create unique index issue_priorities_default_idx
  on issue_priorities (is_default)
  where is_default;

create index issue_priorities_position_idx
  on issue_priorities (position);

create table issue_types (
  id uuid primary key default gen_random_uuid(),
  key text not null check (key ~ '^[a-z0-9_]{2,40}$'),
  name text not null check (char_length(name) between 1 and 40),
  color text not null default '#6B7280',
  icon text,
  position double precision not null default 1000,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (key)
);

create unique index issue_types_name_lower_idx
  on issue_types (lower(name));

create unique index issue_types_default_idx
  on issue_types (is_default)
  where is_default;

create index issue_types_position_idx
  on issue_types (position);

create table labels (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 50),
  color text not null default '#6B7280',
  description text not null default '',
  position double precision not null default 1000,
  created_by uuid not null references profiles(user_id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index labels_name_lower_idx
  on labels (lower(name));

create index labels_position_idx
  on labels (position);

create table project_statuses (
  id uuid primary key default gen_random_uuid(),
  key text not null check (key ~ '^[a-z0-9_]{2,40}$'),
  name text not null check (char_length(name) between 1 and 40),
  category text not null check (category in ('planned', 'active', 'paused', 'completed', 'canceled')),
  color text not null default '#6B7280',
  icon text,
  position double precision not null default 1000,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (key)
);

create unique index project_statuses_name_lower_idx
  on project_statuses (lower(name));

create unique index project_statuses_default_idx
  on project_statuses (is_default)
  where is_default;

create index project_statuses_position_idx
  on project_statuses (position);

-- =========================================================
-- Projects
-- =========================================================
create table projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  slug text not null check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  description_markdown text not null default '',
  status_id uuid not null references project_statuses(id),
  lead_user_id uuid references profiles(user_id),
  icon text,
  color text not null default '#5E6AD2',
  start_date date,
  target_date date,
  completed_at timestamptz,
  is_archived boolean not null default false,
  position double precision not null default 1000,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid not null references profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (target_date is null or start_date is null or target_date >= start_date)
);

create unique index projects_slug_lower_idx
  on projects (lower(slug));

create index projects_name_lower_idx
  on projects (lower(name));

create index projects_status_updated_idx
  on projects (status_id, updated_at desc);

create index projects_target_date_idx
  on projects (target_date)
  where is_archived = false and target_date is not null;

create index projects_position_idx
  on projects (position);

create table project_teams (
  project_id uuid not null references projects(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (project_id, team_id)
);

create index project_teams_team_idx
  on project_teams (team_id, project_id);

-- =========================================================
-- Cycles
-- =========================================================
create table cycles (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  number integer not null check (number > 0),
  name text not null check (char_length(name) between 1 and 120),
  goal text not null default '',
  starts_on date not null,
  ends_on date not null,
  status text not null check (status in ('planned', 'active', 'completed')),
  completed_at timestamptz,
  created_by uuid not null references profiles(user_id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, number),
  check (ends_on >= starts_on)
);

alter table cycles
  add constraint cycles_id_team_id_unique unique (id, team_id);

create unique index cycles_team_active_idx
  on cycles (team_id)
  where status = 'active';

create index cycles_team_dates_idx
  on cycles (team_id, starts_on desc, ends_on desc);

-- =========================================================
-- Issues
-- =========================================================
create table issues (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id),
  number integer not null check (number > 0),
  title text not null check (char_length(title) between 1 and 500),
  description_markdown text not null default '',
  status_id uuid not null,
  priority_id uuid not null references issue_priorities(id),
  type_id uuid not null references issue_types(id),
  project_id uuid references projects(id) on delete set null,
  cycle_id uuid,
  parent_issue_id uuid references issues(id) on delete set null,
  assignee_user_id uuid references profiles(user_id) on delete set null,
  creator_user_id uuid not null references profiles(user_id),
  due_date date,
  estimate smallint check (estimate is null or estimate between 0 and 100),
  position double precision not null default 1000,
  started_at timestamptz,
  completed_at timestamptz,
  canceled_at timestamptz,
  archived_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  search_document tsvector generated always as (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description_markdown, ''))
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, number),
  check (completed_at is null or canceled_at is null)
);

alter table issues
  add constraint issues_status_fk
  foreign key (status_id, team_id)
  references team_statuses (id, team_id);

alter table issues
  add constraint issues_cycle_fk
  foreign key (cycle_id, team_id)
  references cycles (id, team_id);

create index issues_team_status_position_idx
  on issues (team_id, status_id, position)
  where archived_at is null;

create index issues_team_updated_idx
  on issues (team_id, updated_at desc);

create index issues_assignee_updated_idx
  on issues (assignee_user_id, updated_at desc)
  where archived_at is null and assignee_user_id is not null;

create index issues_project_updated_idx
  on issues (project_id, updated_at desc)
  where archived_at is null and project_id is not null;

create index issues_cycle_updated_idx
  on issues (cycle_id, updated_at desc)
  where archived_at is null and cycle_id is not null;

create index issues_parent_position_idx
  on issues (parent_issue_id, position)
  where parent_issue_id is not null;

create index issues_due_date_idx
  on issues (due_date)
  where archived_at is null and due_date is not null;

create index issues_created_at_idx
  on issues (created_at desc);

create index issues_search_gin_idx
  on issues using gin (search_document);

create table issue_labels (
  issue_id uuid not null references issues(id) on delete cascade,
  label_id uuid not null references labels(id) on delete cascade,
  created_by uuid not null references profiles(user_id),
  created_at timestamptz not null default now(),
  primary key (issue_id, label_id)
);

create index issue_labels_label_idx
  on issue_labels (label_id, issue_id);

create table issue_subscribers (
  issue_id uuid not null references issues(id) on delete cascade,
  user_id uuid not null references profiles(user_id),
  created_at timestamptz not null default now(),
  primary key (issue_id, user_id)
);

create index issue_subscribers_user_idx
  on issue_subscribers (user_id, issue_id);

create table issue_comments (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references issues(id) on delete cascade,
  author_user_id uuid not null references profiles(user_id),
  body_markdown text not null,
  edited_at timestamptz,
  deleted_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (deleted_at is not null or char_length(btrim(body_markdown)) > 0)
);

create index issue_comments_issue_created_idx
  on issue_comments (issue_id, created_at asc);

create table issue_attachments (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references issues(id) on delete cascade,
  bucket text not null default 'attachments',
  object_key text not null unique,
  file_name text not null,
  mime_type text,
  size_bytes bigint not null check (size_bytes >= 0),
  uploaded_by uuid not null references profiles(user_id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index issue_attachments_issue_created_idx
  on issue_attachments (issue_id, created_at desc);

create table issue_relations (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references issues(id) on delete cascade,
  related_issue_id uuid not null references issues(id) on delete cascade,
  relation_type text not null check (relation_type in ('blocks', 'related', 'duplicate')),
  created_by uuid not null references profiles(user_id),
  created_at timestamptz not null default now(),
  check (issue_id <> related_issue_id),
  unique (issue_id, related_issue_id, relation_type)
);

create index issue_relations_issue_idx
  on issue_relations (issue_id, created_at desc);

create index issue_relations_related_idx
  on issue_relations (related_issue_id, created_at desc);

create table issue_activity (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references issues(id) on delete cascade,
  actor_user_id uuid references profiles(user_id),
  action text not null,
  summary text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index issue_activity_issue_created_idx
  on issue_activity (issue_id, created_at desc);

-- =========================================================
-- Saved views + notifications
-- =========================================================
create table saved_views (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  scope text not null check (scope in ('workspace', 'team', 'personal')),
  team_id uuid references teams(id) on delete cascade,
  owner_user_id uuid references profiles(user_id) on delete cascade,
  layout text not null check (layout in ('list', 'board')),
  filter_json jsonb not null default '{}'::jsonb,
  sort_json jsonb not null default '[]'::jsonb,
  display_json jsonb not null default '{}'::jsonb,
  is_default boolean not null default false,
  position double precision not null default 1000,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (scope = 'personal' and owner_user_id is not null and team_id is null) or
    (scope = 'team' and owner_user_id is null and team_id is not null) or
    (scope = 'workspace' and owner_user_id is null and team_id is null)
  )
);

create index saved_views_scope_position_idx
  on saved_views (scope, position);

create index saved_views_owner_idx
  on saved_views (owner_user_id, position)
  where owner_user_id is not null;

create index saved_views_team_idx
  on saved_views (team_id, position)
  where team_id is not null;

create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(user_id) on delete cascade,
  type text not null,
  issue_id uuid references issues(id) on delete cascade,
  comment_id uuid references issue_comments(id) on delete cascade,
  actor_user_id uuid references profiles(user_id),
  title text not null,
  body text not null default '',
  read_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index notifications_user_unread_idx
  on notifications (user_id, created_at desc)
  where read_at is null;

create index notifications_user_created_idx
  on notifications (user_id, created_at desc);

-- =========================================================
-- Helper functions for RLS
-- =========================================================
create or replace function app_is_member(uid uuid default auth.uid())
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from workspace w
    where uid = any(w.member_ids)
  );
$$;

create or replace function app_is_admin(uid uuid default auth.uid())
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from workspace w
    where uid = any(w.admin_ids)
  );
$$;

create or replace function app_is_team_lead(target_team_id uuid, uid uuid default auth.uid())
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from teams t
    where t.id = target_team_id
      and uid = any(t.lead_ids)
  );
$$;

-- =========================================================
-- Enable + force RLS
-- =========================================================
do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles',
    'workspace',
    'workspace_members',
    'workspace_invites',
    'teams',
    'team_members',
    'team_statuses',
    'issue_priorities',
    'issue_types',
    'labels',
    'project_statuses',
    'projects',
    'project_teams',
    'cycles',
    'issues',
    'issue_labels',
    'issue_subscribers',
    'issue_comments',
    'issue_attachments',
    'issue_relations',
    'issue_activity',
    'saved_views',
    'notifications'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end $$;

-- =========================================================
-- RLS policies
-- =========================================================
-- Workspace is visible only to members
create policy workspace_select
  on workspace
  for select
  using (auth.uid() = any(member_ids));

-- Member-readable tables
create policy profiles_select
  on profiles
  for select
  using (app_is_member());

create policy workspace_members_select
  on workspace_members
  for select
  using (app_is_member());

create policy teams_select
  on teams
  for select
  using (app_is_member());

create policy team_members_select
  on team_members
  for select
  using (app_is_member());

create policy team_statuses_select
  on team_statuses
  for select
  using (app_is_member());

create policy issue_priorities_select
  on issue_priorities
  for select
  using (app_is_member());

create policy issue_types_select
  on issue_types
  for select
  using (app_is_member());

create policy labels_select
  on labels
  for select
  using (app_is_member());

create policy project_statuses_select
  on project_statuses
  for select
  using (app_is_member());

create policy projects_select
  on projects
  for select
  using (app_is_member());

create policy project_teams_select
  on project_teams
  for select
  using (app_is_member());

create policy cycles_select
  on cycles
  for select
  using (app_is_member());

create policy issues_select
  on issues
  for select
  using (app_is_member());

create policy issue_labels_select
  on issue_labels
  for select
  using (app_is_member());

create policy issue_subscribers_select
  on issue_subscribers
  for select
  using (app_is_member());

create policy issue_comments_select
  on issue_comments
  for select
  using (app_is_member());

create policy issue_attachments_select
  on issue_attachments
  for select
  using (app_is_member());

create policy issue_relations_select
  on issue_relations
  for select
  using (app_is_member());

create policy issue_activity_select
  on issue_activity
  for select
  using (app_is_member());

-- Admin-only read
create policy workspace_invites_select
  on workspace_invites
  for select
  using (app_is_admin());

-- Shared/personal views
create policy saved_views_select
  on saved_views
  for select
  using (
    app_is_member()
    and (
      scope in ('workspace', 'team')
      or owner_user_id = auth.uid()
    )
  );

-- Notifications are private to the recipient
create policy notifications_select
  on notifications
  for select
  using (user_id = auth.uid());

-- No INSERT/UPDATE/DELETE policies on purpose.
-- All writes go through function.js using service access.
```

---

## 5.3 Bootstrap seed data

Seed in `POST /sklinear/v1/bootstrap`, not in SQL.

### Default issue priorities
| key | name | level | is_default |
|---|---|---:|---:|
| `urgent` | Urgent | 4 | no |
| `high` | High | 3 | no |
| `medium` | Medium | 2 | no |
| `low` | Low | 1 | no |
| `none` | No priority | 0 | yes |

### Default issue types
| key | name | is_default |
|---|---|---:|
| `task` | Task | yes |
| `bug` | Bug | no |
| `feature` | Feature | no |
| `chore` | Chore | no |

### Default project statuses
| key | name | category | is_default |
|---|---|---|---:|
| `planned` | Planned | planned | yes |
| `active` | Active | active | no |
| `paused` | Paused | paused | no |
| `completed` | Completed | completed | no |
| `canceled` | Canceled | canceled | no |

### Default team statuses
| key | name | category | is_default |
|---|---|---|---:|
| `backlog` | Backlog | backlog | yes |
| `todo` | Todo | unstarted | no |
| `in_progress` | In Progress | started | no |
| `in_review` | In Review | started | no |
| `done` | Done | completed | no |
| `canceled` | Canceled | canceled | no |

---

# 6. API / `function.js` design

## 6.1 API strategy

### Reads
- Browser uses **PostgREST** directly for reads:
  - workspace metadata
  - profiles/members
  - teams/statuses
  - projects/cycles
  - issues/comments/activity/labels
  - saved views
  - notifications

### Writes
- Browser uses **`/sklinear/v1/*` function routes** for all mutations:
  - bootstrap
  - profile update
  - invites/member changes
  - teams/statuses/cycles
  - issue create/update/move/bulk actions
  - comments
  - attachments
  - views
  - notifications read
  - search
  - export

This is the cleanest “one way” implementation.

---

## 6.2 Core function helpers

Inside `function.js`, define helpers:

- `require_user(req)`
- `require_member(req)`
- `require_admin(req)`
- `require_team_lead_or_admin(req, team_id)`
- `load_workspace()`
- `sync_workspace_access_arrays()`
- `sync_team_access_arrays(team_id)`
- `slugify(text)`
- `next_position(before, after)`
- `reindex_positions(table, where_clause, start = 1000, step = 1000)`
- `insert_issue_activity(issue_id, actor_user_id, action, summary, metadata)`
- `notify_users([{ user_id, type, issue_id, comment_id, actor_user_id, title, body, metadata }])`
- `parse_mentions(body_markdown)` → usernames
- `resolve_mentions(usernames)` → profile rows

---

## 6.3 Route list

## Session / bootstrap

### `GET /sklinear/v1/session`
Auth required.

Returns:
- whether workspace exists
- whether current user is a member
- current profile
- membership role
- permissions object

Use on every app load.

**Example response**
```json
{
  "ok": true,
  "data": {
    "workspace_exists": true,
    "is_member": true,
    "role": "admin",
    "profile": {
      "user_id": "uuid",
      "email": "alex@example.com",
      "username": "alex",
      "display_name": "Alex",
      "avatar_url": null
    },
    "permissions": {
      "can_manage_workspace": true,
      "can_manage_members": true,
      "can_manage_workflow": true
    }
  }
}
```

---

### `POST /sklinear/v1/bootstrap`
Auth required. Allowed only when no workspace exists.

Creates:
- current user profile
- workspace row
- owner membership
- default workflow dictionaries
- first team
- first team membership
- first team statuses

**Request**
```json
{
  "workspace_name": "Acme",
  "workspace_slug": "acme",
  "workspace_icon": "⚡",
  "display_name": "Alex",
  "username": "alex",
  "first_team_name": "Product",
  "first_team_key": "PROD"
}
```

**Rules**
- reject if workspace already exists
- normalize slug lowercase
- normalize team key uppercase
- set workspace arrays immediately
- set team member/lead arrays immediately

---

### `PATCH /sklinear/v1/profile`
Auth + member required.

Editable fields:
- `display_name`
- `full_name`
- `username`
- `avatar_url`
- `bio`
- `timezone`

Notes:
- `email` is synced from auth, not user-editable in v1
- username unique case-insensitive

---

## Workspace / members / invites

### `PATCH /sklinear/v1/workspace`
Admin only.

Editable:
- `name`
- `slug`
- `icon`
- `logo_url`
- `accent_color`

---

### `POST /sklinear/v1/invites`
Admin only.

Creates invite token and returns invite URL.

**Request**
```json
{
  "email": "teammate@example.com",
  "role": "member",
  "initial_team_ids": ["team_uuid"],
  "expires_at": "2026-04-01T00:00:00Z"
}
```

**Behavior**
- lowercases email
- default `max_uses = 1`
- if optional email secret exists, send email
- always return copyable URL

---

### `GET /sklinear/v1/invites/:token`
Anon allowed.

Returns invite preview:
- workspace name
- masked email
- role
- expired/valid

Used by `#/invite/<token>` page.

---

### `POST /sklinear/v1/invites/:token/accept`
Auth required.

Rules:
- current user email must match invite email
- create/update profile
- upsert workspace member
- add team memberships from `initial_team_ids`
- sync workspace/team access arrays
- increment invite `use_count`
- set `accepted_at` / `accepted_by` if exhausted

---

### `POST /sklinear/v1/members/:user_id/role`
Admin only.

Changes workspace role.

Rules:
- cannot remove last owner in v1
- no ownership transfer UI in v1
- owner role should be effectively fixed

---

### `POST /sklinear/v1/members/:user_id/deactivate`
Admin only.

Behavior:
- set `workspace_members.is_active = false`
- remove user from all `team_members`
- sync workspace arrays
- sync all affected team arrays

Profile row remains for historical issue/comment attribution.

---

## Teams / workflow

### `POST /sklinear/v1/teams`
Admin only.

Creates team and seeds default statuses.

Fields:
- `name`
- `key`
- `description`
- `icon`
- `color`

Rules:
- team key immutable once issues exist
- creator becomes team lead by default

---

### `PATCH /sklinear/v1/teams/:team_id`
Admin only.

Editable:
- `name`
- `description`
- `icon`
- `color`
- `is_archived`
- `position`

Rules:
- `key` can change only if `issue_counter = 0`

---

### `PUT /sklinear/v1/teams/:team_id/members`
Team lead or admin.

Replaces full team membership list.

**Request**
```json
{
  "members": [
    { "user_id": "uuid1", "role": "lead" },
    { "user_id": "uuid2", "role": "member" }
  ]
}
```

Rules:
- all users must be active workspace members
- sync `teams.member_ids` and `teams.lead_ids`

---

### `PUT /sklinear/v1/teams/:team_id/statuses`
Team lead or admin.

Replaces ordered team statuses list.

**Request**
```json
{
  "items": [
    {
      "id": "existing_or_null",
      "key": "backlog",
      "name": "Backlog",
      "category": "backlog",
      "color": "#6B7280",
      "icon": "inbox",
      "is_default": true
    }
  ],
  "replacements": {
    "old_status_uuid": "new_status_uuid"
  }
}
```

Rules:
- exactly one default status
- at least one `completed` category status
- if deleting status used by issues, `replacements` must supply a destination
- update positions by array order
- no enums anywhere

---

### `PUT /sklinear/v1/workflow/priorities`
Admin only.

Replaces ordered issue priorities list.

---

### `PUT /sklinear/v1/workflow/types`
Admin only.

Replaces ordered issue types list.

---

### `PUT /sklinear/v1/workflow/project-statuses`
Admin only.

Replaces ordered project statuses list.

---

## Cycles

### `POST /sklinear/v1/teams/:team_id/cycles`
Team lead or admin.

Creates planned cycle.

Fields:
- `name`
- `goal`
- `starts_on`
- `ends_on`

Behavior:
- `number = max(team cycle number) + 1`

---

### `PATCH /sklinear/v1/cycles/:cycle_id`
Team lead or admin.

Editable:
- `name`
- `goal`
- `starts_on`
- `ends_on`

If status is `completed`, editing dates still allowed.

---

### `POST /sklinear/v1/cycles/:cycle_id/start`
Team lead or admin.

Rules:
- only one active cycle per team
- if another active cycle exists, return conflict

---

### `POST /sklinear/v1/cycles/:cycle_id/complete`
Team lead or admin.

**Request**
```json
{
  "rollover": "backlog"
}
```

or

```json
{
  "rollover": "next_cycle",
  "next_cycle_id": "uuid"
}
```

Supported rollover modes:
- `keep`
- `backlog`
- `next_cycle`

Behavior:
- marks cycle completed
- optionally moves incomplete issues

No scheduler/cron required.

---

## Projects

### `POST /sklinear/v1/projects`
Member.

Fields:
- `name`
- `slug` (optional; else auto-generated)
- `description_markdown`
- `status_id`
- `lead_user_id`
- `icon`
- `color`
- `start_date`
- `target_date`
- `team_ids`

---

### `PATCH /sklinear/v1/projects/:project_id`
Member.

Editable same as create plus:
- `is_archived`
- `position`

Behavior:
- replaces `project_teams` if `team_ids` sent
- set/clear `completed_at` when status category changes to/from `completed` or `canceled`

---

## Labels

### `POST /sklinear/v1/labels`
Member.

### `PATCH /sklinear/v1/labels/:label_id`
Member.

### `DELETE /sklinear/v1/labels/:label_id`
Member.

Delete behavior:
- remove label row
- cascade remove `issue_labels`

---

## Issues

### `POST /sklinear/v1/issues`
Member.

This is the most important route.

**Request**
```json
{
  "team_id": "uuid",
  "title": "Fix signup redirect",
  "description_markdown": "",
  "status_id": null,
  "priority_id": null,
  "type_id": null,
  "project_id": null,
  "cycle_id": null,
  "assignee_user_id": null,
  "due_date": null,
  "estimate": null,
  "label_ids": [],
  "parent_issue_id": null,
  "before_issue_id": null,
  "after_issue_id": null
}
```

**Behavior**
- lock team row
- increment `teams.issue_counter`
- assign `number`
- default status = team default status
- default priority/type = workspace defaults
- compute `position`
- insert issue
- insert labels
- auto-subscribe creator + assignee
- if project set and team not already attached to project, insert into `project_teams`
- insert activity row
- notify assignee if actor != assignee

---

### `PATCH /sklinear/v1/issues/:issue_id`
Member.

Partial update of issue scalar fields:
- `title`
- `description_markdown`
- `status_id`
- `priority_id`
- `type_id`
- `project_id`
- `cycle_id`
- `assignee_user_id`
- `due_date`
- `estimate`
- `parent_issue_id`
- `archived_at`

Behavior:
- validate status/cycle belong to same team
- parent cannot equal self
- UI supports one-level sub-issues
- update timestamps:
  - entering `started` category sets `started_at` if null
  - entering `completed` sets `completed_at`, clears `canceled_at`
  - entering `canceled` sets `canceled_at`, clears `completed_at`
  - reopening clears completed/canceled timestamps
- bump `updated_at`
- activity row with diff
- assignee change notifies new assignee
- if project set, auto-link team to project

---

### `POST /sklinear/v1/issues/:issue_id/move`
Member.

For board/list reordering.

**Request**
```json
{
  "status_id": "uuid",
  "before_issue_id": "uuid_or_null",
  "after_issue_id": "uuid_or_null"
}
```

Behavior:
- compute fractional position
- if gap too small, reindex the column/list with `1000` increments
- if status changed, apply same category timestamp rules as `PATCH`

---

### `POST /sklinear/v1/issues/bulk-update`
Member. Max 100 issues per request.

**Request**
```json
{
  "issue_ids": ["uuid1", "uuid2"],
  "changes": {
    "status_id": "uuid",
    "assignee_user_id": "uuid",
    "priority_id": "uuid",
    "project_id": "uuid",
    "cycle_id": "uuid",
    "due_date": "2026-03-25",
    "add_label_ids": ["uuid"],
    "remove_label_ids": ["uuid"]
  }
}
```

Use for triage.

---

### `POST /sklinear/v1/issues/:issue_id/subscribe`
Member.

### `DELETE /sklinear/v1/issues/:issue_id/subscribe`
Member.

---

### `POST /sklinear/v1/issues/:issue_id/relations`
Member.

Fields:
- `related_issue_id`
- `relation_type` in `blocks | related | duplicate`

Rules:
- no self relation
- for `related` / `duplicate`, normalize canonical ordering to avoid duplicates
- for `blocks`, directional row from blocker → blocked

---

### `DELETE /sklinear/v1/relations/:relation_id`
Member.

---

## Comments

### `POST /sklinear/v1/issues/:issue_id/comments`
Member.

Fields:
- `body_markdown`

Behavior:
- insert comment
- auto-subscribe author
- parse `@username` mentions
- create mention notifications
- create comment notifications for other subscribers
- bump issue `updated_at`
- insert activity row

Notes:
- mentions are **comments-only** in v1
- description mentions are out of scope

---

### `PATCH /sklinear/v1/comments/:comment_id`
Author or admin.

Fields:
- `body_markdown`

Behavior:
- set `edited_at`
- update `updated_at`
- no new mention notifications on edit in v1

---

### `DELETE /sklinear/v1/comments/:comment_id`
Author or admin.

Behavior:
- soft-delete:
  - `body_markdown = ''`
  - `deleted_at = now()`
  - `updated_at = now()`

---

## Attachments

### `POST /sklinear/v1/issues/:issue_id/attachments/prepare`
Member.

Returns:
- `bucket`
- `object_key`
- upload target/path

Object key pattern:
`issues/<issue_id>/<attachment_id>-<safe_file_name>`

---

### `POST /sklinear/v1/issues/:issue_id/attachments/commit`
Member.

**Request**
```json
{
  "bucket": "attachments",
  "object_key": "issues/issue_uuid/attachment_uuid-screenshot.png",
  "file_name": "screenshot.png",
  "mime_type": "image/png",
  "size_bytes": 12345
}
```

Behavior:
- record attachment row
- bump issue `updated_at`
- insert activity row

---

### `DELETE /sklinear/v1/attachments/:attachment_id`
Member.

Behavior:
- delete storage object
- delete DB row
- activity row

---

## Saved views / notifications / search / export

### `POST /sklinear/v1/views`
- `scope = personal`: member
- `scope = team`: team lead/admin
- `scope = workspace`: admin

### `PATCH /sklinear/v1/views/:view_id`
Same rules.

### `DELETE /sklinear/v1/views/:view_id`
Same rules.

Validation:
- `board` layout only if view effectively scopes to a single team

---

### `POST /sklinear/v1/notifications/:notification_id/read`
Owner only.

### `POST /sklinear/v1/notifications/read-all`
Owner only.

---

### `GET /sklinear/v1/search?q=...`
Member.

Searches:
- direct issue identifier (`TEAM-123`)
- issue title/description
- projects
- teams
- people

Return shape:
```json
{
  "ok": true,
  "data": {
    "issues": [],
    "projects": [],
    "teams": [],
    "people": []
  }
}
```

---

### `GET /sklinear/v1/export/json`
Admin only.

Returns JSON dump of:
- all application tables
- attachment manifest (`bucket`, `object_key`, metadata)

Note: this is convenience export. Real ownership still comes from owning the DB + bucket.

---

# 7. UI/UX spec

## 7.1 Design goals

- Feels premium immediately
- Dark mode first, light mode supported
- Keyboard-first, but mouse-first users are fine
- Fast, compact, modern
- Desktop-first, responsive enough for tablet/mobile
- No frontend framework
- No bundler
- No giant JS libraries

## 7.2 Technical UI architecture

`site/app.js` should be organized into plain modules/objects:

- `auth`
- `api`
- `store`
- `router`
- `views`
- `components`
- `shortcuts`
- `theme`
- `state_sync`

`site/styles.css` sections:
- tokens
- light/dark themes
- shell layout
- sidebar
- lists/board
- issue drawer
- dialogs
- forms/buttons/chips
- markdown
- utilities

Use:
- hash routing (`#/...`)
- native `<dialog>` for quick-create / command palette
- native `<input type="date">`
- textarea + markdown preview, not rich text
- inline SVG icons

## 7.3 Routes

Use hash routes:

- `#/login`
- `#/bootstrap`
- `#/invite/<token>`
- `#/inbox`
- `#/my-issues`
- `#/issues`
- `#/views/<view_id>`
- `#/teams`
- `#/teams/<team_id>`
- `#/cycles/<cycle_id>`
- `#/projects`
- `#/projects/<project_id>`
- `#/roadmap`
- `#/settings/workspace`
- `#/settings/members`
- `#/settings/workflow`
- `#/settings/labels`
- `#/issue/<TEAM-123>`

Issue route opens a right drawer on desktop and full screen on smaller screens.

## 7.4 App shell

### Sidebar
Sections:
- Workspace header
- Quick create button
- Inbox
- My Issues
- All Issues
- Projects
- Roadmap
- Saved Views
- Teams
- Settings
- User menu

### Header area
- current page title
- search / command button
- context actions
- filter chips for list/board pages

## 7.5 Main screens

### Login
- email/password login
- sign up
- Google OAuth
- clean, centered auth card
- no marketing-site bloat

### Bootstrap
Shown only if no workspace exists.

Fields:
- workspace name
- workspace slug
- workspace icon
- your display name
- your username
- first team name
- first team key

### Inbox
- unread first
- grouped as “Unread” and “Earlier”
- clicking notification opens issue and marks read
- notifications in v1:
  - assigned to you
  - mentioned in comment
  - new comment on subscribed issue

### My Issues
Default home after login.

Defaults:
- assignee = me
- hide completed/canceled
- list view
- grouped by team or ungrouped sorted by priority/due date

### All Issues
- list view default
- filter chips
- saved views
- checkbox multi-select
- bulk actions
- board toggle only when a single team context is selected

### Team page
- header with team name/key
- current active cycle pill if any
- board/list toggle
- cycle filter
- issue filters
- settings tab for leads/admins
- cycles tab showing planned/active/completed cycles

### Cycle page
- cycle goal, dates, progress
- issue list/board for that cycle
- complete cycle action with rollover modal

### Projects page
- list of projects
- create project
- filters by status/team/lead
- toggle to roadmap

### Roadmap
- projects on a week/month timeline
- bars based on `start_date` / `target_date`
- active/planned first
- clicking project opens project detail
- no drag-to-edit in v1

### Project detail
- name, status, lead, dates, teams, progress
- description markdown
- issue list filtered by project
- board toggle only if single team filter is applied

### Issue drawer
Sections:
- header: identifier, title
- metadata row: status, assignee, priority, type, project, cycle, due date, estimate
- labels
- description (markdown editor + preview)
- related issues / parent / children
- attachments
- tabs:
  - Discussion
  - Activity

Comments are under Discussion. Activity shows field changes and system events.

### Settings
- Workspace
- Members & invites
- Workflow (priorities, types, project statuses)
- Labels
- Team-specific settings live under team page

---

## 7.6 Interaction rules

### Quick create issue
- shortcut or button opens dialog
- only required fields:
  - title
  - team
- defaults status to team default
- prefill team/project/cycle from current context

### Editing
- simple metadata chips save immediately
- description/comments use explicit Save + Cancel
- `Cmd/Ctrl+Enter` saves editor
- comments are markdown only

### Board
- columns ordered by `team_statuses.position`
- cards ordered by `issues.position`
- drag between columns updates status + position
- completed/canceled columns may appear at the end
- horizontal scroll on smaller widths

### List
Default columns:
- checkbox
- identifier
- title
- status
- priority
- assignee
- project
- cycle
- due date
- updated

### Filters
Supported filters:
- text
- team
- status
- status category
- assignee
- project
- cycle
- priority
- type
- labels
- due date
- archived toggle
- subscribed-only

Saved views store the same filter JSON.

---

## 7.7 Keyboard shortcuts

### Global
- `c` → new issue
- `cmd/ctrl + k` → command palette
- `?` → shortcuts help
- `g then i` → all issues
- `g then m` → my issues
- `g then p` → projects
- `g then t` → teams
- `g then n` → inbox
- `esc` → close drawer/dialog

### Lists/boards
- `j` / `k` → move selection
- `enter` → open issue
- `space` → toggle multi-select
- `a` → assign picker
- `s` → status picker
- `p` → priority picker
- `l` → labels picker
- `x` → archive issue

### Editors
- `cmd/ctrl + enter` → save
- `esc` → cancel/close

Shortcuts are disabled while typing in text inputs except explicit combos.

---

## 7.8 Visual design requirements

- dark mode default, light optional
- clean typography
- subtle borders, low-noise shadows
- compact spacing
- issue chips/pills look crisp
- consistent radii
- focus states visible
- status/priority/labels color-coded but not gaudy
- no cluttered top nav

Recommended design tone:
- close to Linear, but not a pixel copy
- more warmth in accent color and empty states is okay

---

# 8. Read model recommendations

Use PostgREST for reads.

## 8.1 Initial app boot
Fetch in parallel:
- workspace
- current user profile
- workspace_members
- profiles
- teams
- team_members
- team_statuses
- issue_priorities
- issue_types
- labels
- project_statuses
- saved_views
- unread notifications count

## 8.2 Team board
Fetch:
- team
- statuses for team
- issues for team + embeds:
  - assignee
  - project
  - cycle
  - labels
  - priority
  - type

## 8.3 Issue detail
Fetch:
- issue
- labels
- comments
- activity
- attachments
- relations
- child issues

## 8.4 Projects list
Fetch:
- projects
- project_teams
- optional issue counts/progress via extra issue query or client-side aggregation

---

# 9. Deployment (`deploy.ts`)

## 9.1 Deployment goals

- one function
- one schema
- one static site
- one private storage bucket
- publishable to marketplace
- one-click deployable to Run402

## 9.2 Manifest requirements

`deploy.ts` should deploy:

- `schema.sql`
- `function.js` mounted at `/sklinear/v1/*`
- `site/` to static hosting
- storage bucket: `attachments` (private)
- marketplace metadata:
  - name: `sklinear`
  - title: `sklinear`
  - description: `Fast Linear-style issue tracker for individuals and SMBs. MIT, forkable, no seat pricing.`
  - tags: `project-management`, `issue-tracker`, `linear-clone`, `open-source`
  - license: `MIT`
  - forkable: `true`

## 9.3 Runtime config injection

Because the SPA needs the project anon key, `deploy.ts` should inject into `index.html`:

- `api_origin` = `location.origin` (or left implicit)
- `anon_key`
- `function_base = /sklinear/v1`
- `storage_bucket = attachments`

Simplest approach:
- template placeholders in `index.html`
- `deploy.ts` replaces them before manifest creation

## 9.4 Optional secrets

Support optional secrets for invite emails:
- `RESEND_API_KEY`
- `EMAIL_FROM`

If absent:
- invite flow still works via copyable link

## 9.5 Deploy flow

1. Validate files exist
2. Read `schema.sql`, `function.js`, `site/*`
3. Inject public runtime config into `index.html`
4. Build manifest
5. `run402 deploy --manifest ...`
6. Claim subdomain
7. Publish/update marketplace listing

## 9.6 Important deployment behavior

- template deploy should start with **no workspace row**
- first user bootstraps workspace
- app should fit easily in Run402 tiers because it uses:
  - 1 function
  - static SPA
  - 1 bucket

---

# 10. Testing strategy

Must be fully tested.

## 10.1 Test stack
- Node 22 built-in test runner for function/schema tests
- Playwright for E2E
- no frontend build/test framework necessary

## 10.2 Schema tests
Test `schema.sql` on a clean database:

1. schema applies cleanly
2. singleton workspace constraint works
3. username uniqueness works
4. team key uniqueness works
5. issue number uniqueness per team works
6. composite FK enforces status-team match
7. composite FK enforces cycle-team match
8. RLS:
   - non-member cannot read
   - member can read shared tables
   - admin can read invites
   - users can read only their own notifications

## 10.3 Function tests
Cover at minimum:

### bootstrap
- first user creates workspace
- default workflow rows seeded
- first team seeded with statuses
- arrays synced correctly

### membership/invites
- create invite
- invite preview
- accept invite with matching email
- reject mismatched email
- deactivate member removes workspace/team access

### issue lifecycle
- create issue assigns correct team-local number
- concurrent issue creates remain unique/ordered
- move issue computes new position
- reindex works when positions compress
- status changes set timestamps correctly
- assignee change notifies assignee
- auto-subscribe creator/commenter

### comments/notifications
- comment creates activity
- mention creates notification
- subscriber comment notification excludes actor

### projects/cycles
- project create/update with team links
- cycle start uniqueness
- cycle complete rollover modes

### workflow/settings
- replace statuses with remap
- replace priorities/types/project statuses

### export
- admin export contains all tables and attachments manifest

## 10.4 E2E tests
Playwright scenarios:

1. sign up → bootstrap → create issue
2. create/edit/move issue in board
3. comment on issue
4. create project and link issue
5. create cycle and assign issue
6. save personal view
7. invite second user
8. second user accepts invite and sees workspace
9. inbox notification opens issue
10. keyboard shortcuts:
   - `c`
   - `cmd/ctrl+k`
   - `j/k`
   - `enter`
   - `?`

## 10.5 Visual/polish tests
- screenshot snapshots:
  - login
  - bootstrap
  - inbox
  - my issues
  - team board
  - issue drawer
  - projects list
  - roadmap
- dark and light theme snapshots

## 10.6 Run402-specific smoke tests
- deploy fresh app
- bootstrap workspace
- create data
- fork app
- confirm fork is independent

---

# 11. Run402 platform requirements / gaps

These are not blockers, but if any are missing they should be explicitly added.

## Required

### 1. Privileged DB access from functions
Needed because:
- browser PostgREST is read-only via RLS
- all writes go through `function.js`

If `db` in functions does not bypass RLS / use service credentials, add that.

---

### 2. Transaction support in functions
Needed for:
- bootstrap
- create issue (`FOR UPDATE` on team counter)
- invite accept
- cycle complete rollover
- status replacement/remapping

If no first-class transaction helper exists, `db.sql()` must be sufficient.

---

### 3. `getUser(req)` must include auth metadata
At minimum:
- `id`
- `email`

Strongly preferred:
- `name`
- `avatar_url`

Needed for:
- invite email matching
- profile bootstrap/sync

---

### 4. Private storage bucket support
Needed for attachments.

Required either:
- auth-restricted object API for project bucket, or
- signed upload/download URLs

Attachments should **not** be public.

---

### 5. Public anon key injection path for static site
The SPA needs the project anon key to call:
- `/auth/v1/*`
- `/rest/v1/*`
- function routes

If deploy tooling cannot inject that easily, add support.

---

## Optional / nice to have

### 6. Built-in transactional email helper
Not required, but nice for invite emails.

Without it:
- copy-link invites are enough

### 7. Realtime
Not required for v1.
Polling + optimistic UI is fine.

### 8. Scheduled jobs
Not required for v1.
Cycles are manually started/completed.

---

# 12. Recommended implementation order

1. **Schema + bootstrap + session**
2. **Auth UI + shell + dictionary reads**
3. **Issue create/list/detail/edit**
4. **Team pages + board + move/reorder**
5. **Projects + roadmap**
6. **Cycles**
7. **Comments + notifications**
8. **Saved views + bulk actions + search**
9. **Invites + members + settings**
10. **Attachments + export**
11. **Polish + keyboard + tests + marketplace publish**

---

# 13. Bottom line

If you build **exactly this scope**, sklinear will be:

- a credible **Linear alternative** for SMBs/individuals
- much more ownable than SaaS
- a strong **Run402 showcase app**
- agent-friendly to customize
- small enough to actually ship

The main product formula is:

> **Fast issue tracking + projects + cycles + roadmap + inbox + beautiful UX**  
> **without enterprise complexity, seat pricing, or hidden platform lock-in**

If you want, I can turn this next into:
1. a concrete **`function.js` route skeleton**,  
2. a **`deploy.ts` manifest spec**, and/or  
3. a **screen-by-screen implementation checklist for `site/app.js` and `styles.css`**.

---
**Wall time**: 61m 41s
**Tokens**: 86,461 input, 12,522 output (12,522 reasoning), 98,983 total
**Estimated cost**: $4.8478
