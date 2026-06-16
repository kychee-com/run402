## Context

Gateway `3e60da4b` added `GET /projects/v1/:project_id` — an authoritative single-project read authorized via `controlPlaneSessionOrWalletAuth()` + `requireProjectAuthz("project.read")` against the owning org. It returns 13 fields (identity, `org_id`, `tier`, `effective_status`, `organization_lifecycle_state`, `site_url`, `custom_domains[]`, `last_deploy` pointer, active `mailbox[]` addresses, `usage` with limits, `created_at`) and deliberately returns **no key material**. It is authorize-before-reveal: `403` (never `404`) for unauthorized callers **and** for the post-authz deleted/archived race.

The public client today exposes three project reads, all **local-only**:

- `r.projects.info(id)` → `{ project_id, ...keys }` from the keystore; "does not make an API call." Surfaced by MCP `project_info` and CLI `projects info` (which also print `rest_url`, `site_url`).
- `r.projects.keys(id)` → `{ anon_key, service_key }` from the keystore. Surfaced by MCP `project_keys` / CLI `projects keys`.
- `r.projects.list(wallet?)` → `GET /projects/v1` inventory — summary rows that are a strict subset of the new detail (no `public_id`, `last_deploy`, `mailbox[]`, or usage limits).

There is no client path to the authoritative server detail.

## Goals / Non-Goals

**Goals:**
- One typed SDK method wrapping `GET /projects/v1/:project_id`, plus a `ProjectDetail` type naming all 13 fields faithfully.
- Natural scoped access (`r.project(id).get()`) alongside the collection form (`r.projects.get(id)`).
- MCP + CLI + OpenClaw verbs that render the authoritative view for agents.
- Preserve authorize-before-reveal end-to-end — no existence oracle in client errors.
- Keep the offline `info`/`keys` primitives working unchanged.

**Non-Goals:**
- Rewiring or removing the local `info`/`keys` surface (see Decision 1).
- Caching the server detail in the keystore — it is live, fetched on demand.
- Any gateway change — the endpoint already shipped.
- Synthesizing key material into the new read (the endpoint never returns it; the client must not invent it).

## Decisions

### Decision 1 — Add a distinct `get` verb; do NOT rewire `project_info`

The gateway commit frames the follow-up as "rewire `project_info`." We instead add `r.projects.get(id)` and leave `info`/`keys` untouched. Rationale:

- `project_info` / `projects info` today returns **key material** from the keystore with **no network call**. The new endpoint returns **no keys** and **requires** an authenticated round-trip. Rewiring `info` onto it would (a) strip the keys agents read right after `provision`, and (b) turn a previously-offline call network- and auth-dependent.
- A distinct `get` verb yields a clean model: **`get` = authoritative live server view (no secrets)**; **`info` / `keys` = local cached connection material**. Two orthogonal needs, two verbs. It also matches the platform's existing `get`-is-a-server-read convention (`r.org(id).get()`).
- **Alternative considered — merge:** `info` calls the server AND splices in local keys. Rejected: couples an online authz read to an offline secret read, doubles the failure modes, and muddies the endpoint's no-keys guarantee.
- **Alternative considered — rewire (the commit's wording):** point `info` at the server, drop its keys (covered by `keys`). Rejected as the default because it makes the previously-offline `info` online-only; recorded as the reversible fallback in Open Questions.

### Decision 2 — Map `403` to `Unauthorized`, never invent a `404`

The endpoint is authorize-before-reveal: unauthorized callers and the deleted/archived-after-authz race both return `403`. The SDK surfaces the gateway `403` as `Unauthorized` verbatim and does **not** translate it to `ProjectNotFound`, preserving the no-existence-oracle property. `ProjectNotFound` stays reserved for the *local* keystore miss in `info`/`keys`. A genuine pre-authz `404 PROJECT_NOT_FOUND` to an authorized caller still maps to `ProjectNotFound`.

### Decision 3 — Default credential, no project keys required

`get` uses the `withAuth` default (wallet SIWX or control-plane session, like `rename` / `list`) so it works for a project **not** in the local keystore — e.g. triaging a project owned via org membership but never provisioned on this machine. It must NOT require `getProject(id)` to succeed first.

### Decision 4 — Faithful field names + explicit `null`

`ProjectDetail` mirrors the wire snake_case exactly (`public_id`, `org_id`, `effective_status`, `organization_lifecycle_state`, `last_deploy`, `custom_domains`, `mailbox`, `created_at`). `site_url` and `last_deploy` are `T | null` (the server always emits the key with explicit `null`, never omits it). `usage` carries the four counters/limits as numbers. The container is an open object so a newer gateway field does not break parsing.

### Decision 5 — Scoped wrapper is `get()` on the `ScopedProjects` sub-namespace

`get()` joins `info()` / `keys()` / `rename()` / `delete()` on the `ScopedProjects` class in `scoped.ts`, reached as `(await r.project(id)).projects.get()` (project-scoped methods live under `.projects`, not directly on `ScopedRun402`). The `scoped.test.ts` drift guard mandates a wrapper for every project-id-bearing namespace method — required, not optional. (Note: implementation revealed the scoped access path is `.projects.get()`; an earlier draft wrote `r.project(id).get()`. The sibling docs' `r.project(id).rename(name)` shorthand is similarly imprecise — pre-existing, out of scope here.)

## Risks / Trade-offs

- **Verb proliferation (`get` vs `info` vs `keys`)** → docs state the split in one line each (live-server vs local-keys); names follow platform convention.
- **Agents expecting `info` to become the rich view** (per the commit's phrasing) → recorded here + flagged in Open Questions; trivially reversible (redirect `project_info` → `get`) if the reviewer prefers the rewire.
- **`mailbox[]` / `custom_domains[]` shape drift** if the gateway later enriches entries from strings to objects → typed as `string[]` today (matches shipped wire), open container; a future enrichment is its own change.
- **CLI e2e silently skipped** if a new `cli-projects-*.test.mjs` isn't registered → explicit task to add it to the `package.json` test allow-list.

## Migration Plan

Additive, non-breaking, client-only. No keystore migration, no gateway change. Ships in the normal lockstep `run402-mcp` / `run402` / `@run402/sdk` release. Rollback = revert the client commit; the gateway endpoint is independent and already live.

## Open Questions

- **Rewire vs add (Decision 1):** confirm `project_info` / `projects info` should stay local-offline and the authoritative read lands under a new `get` verb. If the reviewer prefers honoring the commit's "rewire `project_info`" wording, point MCP `project_info` + CLI `projects info` at `projects.get` and rely on `project_keys` for secrets — a one-line redirect, no change to the `get` spec itself.
- **`r.project(id).get()` naming** — `get()` for the project's own detail reads naturally; revisit only if a future "get a sub-resource" verb collides.
