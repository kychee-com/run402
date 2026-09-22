---
title: "Org membership & project grants"
description: "Native SDK reference — organizations."
order: 90
---

## Org membership & project grants (`r.orgs`, `r.org(id)`, `r.grants` — org-owned control plane; first-class orgs)

A wallet **authenticates** (SIWX → a control-plane *principal*); an **org** owns projects, and what a principal may do is decided by its org membership role (`owner > admin > developer > billing > viewer`) or a per-project grant — never `wallet_address == signer`. The collection + identity lives on `r.orgs`; per-org operations on the scoped sub-client **`r.org(id)`** (the org analog of `r.project(id)` — the id is bound once). Memberships carry `org_id` + `display_name`.

- **`r.orgs.create({ displayName? })`** → `{ org_id, display_name, tier, lease_started_at, lease_expires_at }` (POST `/orgs/v1`). Creates an empty org on the prototype tier; you become owner. Accepts only `displayName` — no tier input. Step-up gated; the soft per-owner free-org cap answers 403 `FREE_ORG_OWNER_LIMIT_EXCEEDED` with `next_actions` (a policy refusal, never retried; the SDK raises it as `Unauthorized` with that `code`).
- **`r.orgs.list()`** → orgs you are an active member of (`OrgMembership[]`, each `{ org_id, display_name, role, status }`).
- **`r.orgs.whoami()`** → `{ principal, memberships[], authenticator_id }` (GET `/agent/v1/whoami`). The REMOTE, gateway-resolved identity — distinct from **`r.whoami()`** (local + network-free wallet/profile label, used by `run402 status`).
- **`r.org(id).get()`** → `{ org_id, display_name, tier, lease_started_at, lease_expires_at, role }`. Any active member; a non-member (incl. a guessed id) gets the same non-revealing 403.
- **`r.org(id).rename(displayName | null)`** → `{ org_id, display_name, tier, lease_started_at, lease_expires_at }`. Owner-only; set or clear the label (`null`/`""` clears). Step-up gated.
- **`r.org(id).setSlug(slug, { idempotencyKey? })`** → `{ org_id, slug, previous_slug, created }` (POST `/orgs/v1/:org_id/slug`, repo-first-onramp design D6). Owner-only. A genesis set debits a small one-time fee; a rename is free but releases the OLD slug into a ~90-day cooldown (typed `SLUG_RELEASED` refusal thereafter, naming this org's new slug as successor). A paid, side-effecting mutation — requires `Idempotency-Key`; the SDK generates a fresh one per call when `idempotencyKey` is omitted, so a retried call after a dropped response cannot double-bill. `OrgSummary`/`OrgDetail` gain an additive `slug: string | null` field.
- **`r.org(id).members.list()` / `.add({ wallet, role? })` / `.setRole(principalId, { role })` / `.revoke(principalId)`** — owner-gated; a new wallet is provisioned as a `human` principal, `role` defaults to `developer`. Removing/demoting the org's only active owner throws `ApiError code: "LAST_OWNER"` (409).
- **`r.org(id).invites.list()` / `.create({ email, role, inviteTtlHours? })` / `.revoke(principalId)`** — email invites, claimed automatically at the invitee's first login.
- **`r.org(id).audit({ limit?, before? })`** → control-plane audit trail (admin+), newest-first; page with `before`.
- **`r.grants.create(projectId, { wallet, capability, policy?, expiresAt? })`** / **`r.grants.revoke(projectId, grantId)`** — per-project capability grants for agent/CI principals; requires owner of the project's org. Also project-scoped: **`r.project(id).grants.create({...})`** / `.revoke(grantId)`. `capability` examples: `"deploy"`, `"functions:write"`.

Control-plane denials throw `NotAuthorizedError` (403 `NOT_AUTHORIZED`, carrying `requiredRole` / `requiredCapability` / `reason`). Bad input is `ApiError` `code: "VALIDATION_ERROR"` (400). Exported types: `OrgRole`, `Principal`, `OrgMembership`, `OrgMember`, `WhoAmIResult`, `OrgSummary`, `OrgDetail`, `CreateOrgInput`, `ProjectGrant`, plus input/result types.
