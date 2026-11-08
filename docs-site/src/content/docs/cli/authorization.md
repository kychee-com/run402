---
title: "Authorization manifest"
description: "The expose manifest a deploy applies as database.expose: dark-by-default tables, the built-in table policies (user_owns_rows, group_owns_rows, public_read_authenticated_write, public_read_append_only, public_read_write_UNRESTRICTED, custom), owner and group triggers, views, rpcs, and validate-expose."
order: 2.5
slice: authorization
summary: "database.expose: built-in table policies (user_owns_rows, group_owns_rows, …), owner and group triggers, views, rpcs, validate-expose"
---

### Authorization manifest

Authorization manifest (`https://run402.com/schemas/manifest.v1.json`): new tables are dark until declared with `expose: true`. Prefer `database.expose` or a `manifest.json` in bundle `files[]`; platform validates against migration SQL, applies it, and strips `manifest.json` before site deploy so it is never public. Success includes `manifest_applied: true`; missing migration table -> HTTP 400 with structured `errors[]`. Dry feedback: `run402 projects validate-expose [project_id] --file manifest.json [--migration-file setup.sql]`; validates auth/expose manifest only, does not execute SQL, exits 0 even with `has_errors: true`.

Built-in table policies:

- `user_owns_rows` — owner column matches `auth.uid()`; requires `owner_column`. With `force_owner_on_insert: true`, per-table trigger fills owner only when `NEW.<owner_column>` is `NULL`; explicit different owners still fail `WITH CHECK`. `service_key` bypasses RLS but trigger still runs; admin writes should set owner if no JWT. Best for user-scoped data. `uuid` owner columns get index-friendly policies; other types use `::text` cast with warning; btree index auto-created.
- `group_owns_rows` — rows whose `group_column` is one of the groups the user belongs to; requires `group_column` and `membership: { table, group_column, user_column }`, and the membership table must be declared in the same manifest with `expose: true` and `policy: "user_owns_rows"` on `membership.user_column` (validation issue `membership-not-user-owned` otherwise; a membership table may not itself be `group_owns_rows`). The predicate is a membership subselect run as the caller, plus `Run402-Group` when the request names its current group: that header narrows to one group and never widens, so a group the user is not in yields no rows (on the SQL route it is the body's `group`). With `force_group_on_insert: true`, a per-table trigger `<table>_set_group` fills a NULL `group_column` from `Run402-Group` and raises an error naming the header when none is named; an explicit value is kept and still faces `WITH CHECK`. `service_key` bypasses the policy; the trigger still runs, so a platform write sets the group explicitly. Types of the two group columns are introspected like `owner_column`; btree index auto-created on `group_column`. For families, clubs, classrooms, teams.
- `public_read_authenticated_write` — anyone reads; any authenticated user can INSERT/UPDATE/DELETE any row (not just their own). For collaborative content (shared boards, announcements).
- `public_read_write_UNRESTRICTED` — ⚠ fully open; `anon_key` can read AND write any row. For intentionally public tables only (guestbooks, waitlists, feedback forms). Requires `"i_understand_this_is_unrestricted": true` on the table entry.
- `custom` — escape hatch. Provide `custom_sql` containing `CREATE POLICY` statements; they run inside the apply transaction after RLS is enabled + forced.

| Policy | anon SELECT | anon writes | auth SELECT | auth writes |
|---|:---:|:---:|:---:|:---:|
| (omitted from manifest) | — | — | — | — |
| `user_owns_rows` | — | — | own rows | own rows |
| `group_owns_rows` | — | — | own groups' rows | own groups' rows |
| `public_read_authenticated_write` | all | — | all | all rows |
| `public_read_write_UNRESTRICTED` | all | yes | all | yes |

`—` = denied. `service_key` bypasses all policies. Views are always created with `security_invoker=true` — they inherit the underlying table's RLS. RPCs require an entry in `rpcs[*]` with `grant_to` to be callable as `/rest/v1/rpc/<fn>` — `CREATE FUNCTION` revokes PUBLIC EXECUTE automatically.

Worked example covering all three slices (drop in as `manifest.json` or under `database.expose` in a deploy manifest):

```json
{
  "$schema": "https://run402.com/schemas/manifest.v1.json",
  "version": "1",
  "tables": [
    { "name": "posts", "expose": true, "policy": "public_read_authenticated_write" },
    { "name": "notes", "expose": true, "policy": "user_owns_rows", "owner_column": "user_id", "force_owner_on_insert": true }
  ],
  "views": [
    { "name": "posts_public", "base": "posts", "select": ["id", "title", "published_at"], "expose": true }
  ],
  "rpcs": [
    { "name": "increment_counter", "signature": "(counter_name text)", "grant_to": ["authenticated"] },
    { "name": "now_utc", "signature": "()", "grant_to": ["anon", "authenticated"] }
  ]
}
```

`rpcs[*].signature`: parenthesized args (`"()"` for none), regex `^\([^;]*\)$`; `grant_to` non-empty roles (`anon`, `authenticated`, `service_role`, `project_admin`). Function must exist in migration SQL; manifest grants EXECUTE only. Views require `base` + non-empty `select`, are `security_invoker=true`, inherit base RLS. Ad-hoc: `projects apply-expose <project_id> --file manifest.json`; inspect with `projects get-expose <project_id>` (`source: "applied" | "introspected"`). Manifest is convergent; removed items revoke policies/grants/triggers/views, so include full desired exposed surface each apply.
