## Context

The gateway change `d28d3153` in the private run402 repo (shipped 2026-04-14) introduced a four-stage grace state machine and changed the wire behavior of several public endpoints. run402-public already routes every tool's API errors through `src/errors.ts::formatApiError`, which extracts `hint`, `retry_after`, `renew_url`, `usage`, and `expires_at` from the body and prints actionable next-step text. The gateway now adds `lifecycle_state`, `entered_state_at`, `next_transition_at`, and `scheduled_purge_at` to 402 bodies on mutating control-plane routes, and a new 409 response on `POST /subdomains/v1`. SKILL.md (MCP) and openclaw/SKILL.md (OpenClaw) document lifecycle behavior in their runtime sections and still use the 7-day archive vocabulary.

No local type mirrors `@run402/shared`'s `ProjectStatus` — the public repo treats `status` as an opaque string — so the widened union does not require a type change.

## Goals / Non-Goals

**Goals:**
- Agents invoking CLI/MCP tools that get blocked by grace-state 402s understand *which* state the project is in and *when* the next transition happens, without reading gateway source.
- Documentation (SKILL.md, openclaw/SKILL.md) accurately reflects the ~104-day grace window so agents don't plan against a fictional 7-day cliff.
- The 409 subdomain-reserved case is distinguishable from the existing 403 path (not-your-project) in the tool output.

**Non-Goals:**
- No new CLI/MCP commands for the new admin endpoints (`POST /projects/v1/admin/:id/reactivate`, `POST /subdomains/v1/admin/:name/release`) — those are admin-only and not part of the public agent surface.
- No schema/type changes in `core/src/` — the public repo never modeled `ProjectStatus` as a closed union.
- No change to `archive_project` semantics or endpoint; the DELETE path and tool name stay put.

## Decisions

### D1: Extend `formatApiError` in place rather than adding a lifecycle-specific helper
Add lifecycle-state extraction to the existing body-field walk in `src/errors.ts`. Every tool already funnels 402/403/409 through this one function, so a single edit covers the full surface.
**Alternative considered:** a dedicated `formatLifecycleError` called from `archive_project` / deploy tools. Rejected — the 402 body is returned from many routes (deploys, secrets, subdomains, contracts, domains, email-domains, mailboxes, publish) and we'd need to wire the helper into each. The body-field walk already handles the polymorphism.

### D2: 409 gets a new switch branch, not a reuse of 403
The gateway distinguishes 403 (not your project / admin required) from 409 (subdomain name reserved for another wallet's grace). Collapsing them loses the signal. Add a `case 409` branch with wording that specifically names the reservation window and suggests waiting until the grace window expires or picking another name.

### D3: Keep the `archive_project` tool name and endpoint
The DELETE endpoint and tool name are stable — only the response `status` value changed from `archived` to `purged` for new rows. Rename-in-text (tool description, success message) but not an MCP schema rename, so agents with cached tool lists keep working.

### D4: Don't model `ProjectStatus` as a TypeScript union locally
`core/src/` and `src/` never declared a local `ProjectStatus` type; they treat status as a string on whatever the API returns. Adding one now just to "match" the gateway creates maintenance drag when the next state is added. Leave it string-typed.

### D5: Docs updates go in SKILL.md prose, not a new file
Both SKILL.md and openclaw/SKILL.md already have a lifecycle paragraph. Edit the existing sections rather than adding a new subsection, matching the style of the gateway's `site/llms.txt` change.

## Risks / Trade-offs

- **[Risk] Older gateway deployments don't emit `lifecycle_state`** → `formatApiError` reads fields defensively (same `if (body.x)` pattern as `usage` / `hint`). Missing field → no line emitted; no crash.
- **[Risk] Renaming success text from "archived" to "purged" in `archive_project`** may confuse agents that scripted against the exact output string → Success-message text isn't part of any contract; no known consumer parses it. Low risk.
- **[Trade-off] SKILL.md prose has to stay aligned manually with gateway `site/llms.txt`** — there's no auto-sync. Documented in `project_last_integration.md`; `/upgrade` catches drift.
- **[Risk] 409 branch might be hit by other 409 cases we haven't enumerated** → Phrase the guidance generally ("resource already exists or is reserved"), not subdomain-specifically, and let the API's `message`/`hint` fields carry the specifics.

## Migration Plan

Single-phase: edit code + docs, ship in a patch version bump. No feature flag needed — the new 402 / 409 paths are already live on the gateway; we're just improving how run402-public *reads* them.
