## 1. Error formatting

- [x] 1.1 In `src/errors.ts::formatApiError`, extract `lifecycle_state`, `entered_state_at`, `next_transition_at`, and `scheduled_purge_at` from `body` defensively (same `if (body.x)` pattern as `hint`, `retry_after`, `renew_url`, `usage`, `expires_at`)
- [x] 1.2 Emit one "Lifecycle:" line when `lifecycle_state` is present, listing the state plus any accompanying timestamps that are present
- [x] 1.3 Add a `case 409` branch to the status switch with next-step text mentioning that the resource is reserved/held (phrased generically so it covers subdomain-grace-reservation without being subdomain-specific)
- [x] 1.4 When status is 402 and `lifecycle_state` is present, augment the existing 402 guidance to point at `set_tier` / renew as the reactivation path (distinct from the plain "usage exceeded" 402 variant)

## 2. Error-formatting tests

- [x] 2.1 Create or extend `src/errors.test.ts` (or whichever test file covers `formatApiError`); add a case asserting a 402 with full lifecycle fields renders all four fields and a reactivate hint
- [x] 2.2 Add a case for a 402 with only some lifecycle fields — assert no `undefined`/`null` placeholders appear and the present fields still render
- [x] 2.3 Add a case for a 409 response — assert the new branch-specific guidance appears and the existing 403 lease-expired guidance does not
- [x] 2.4 Keep existing 402-with-usage test green to confirm the non-lifecycle 402 path is unchanged

## 3. archive_project tool text

- [x] 3.1 Update `src/tools/archive-project.ts` tool description so it describes the call as triggering the soft-delete grace window (project enters `purged` state, not "archived"); keep the Zod schema and endpoint untouched
- [x] 3.2 Update the success-message text to use purge/grace vocabulary instead of "archived"
- [x] 3.3 If a CLI wrapper exists for DELETE /projects (search `cli/lib/*.mjs` for the endpoint path), align its user-visible text with the MCP tool
- [x] 3.4 Run `npm test` locally to confirm no test asserts on the old "archived" string

## 4. SKILL.md + openclaw/SKILL.md lifecycle sections

- [x] 4.1 In `SKILL.md` (root), replace the "Lease lifecycle" bullet list (currently "Expired (day 0): read-only for 7 days / Grace period ends (day 7): archived") with the four-stage `active → past_due → frozen → dormant → purged` description, noting ~104-day total grace and that data plane continues serving
- [x] 4.2 In `openclaw/SKILL.md`, update the "Project Lifecycle" section (around line 516) and the inline "auto-archived" mention (around line 154) with the same grace-period vocabulary; replace the 7-day wording
- [x] 4.3 Confirm no other SKILL.md section still references the 7-day archive cliff (grep for `archive`, `7 days`, `read-only`); update or remove as needed
- [x] 4.4 Run `npm run test:skill` to confirm SKILL.md still passes structural validation

## 5. Sync test + version bump

- [x] 5.1 Run `npm run test:sync` to confirm the SURFACE array still matches (no new tools added, so it should pass without edits)
- [x] 5.2 Bump version in `package.json`, `cli/package.json`, and `openclaw/` manifest per the repo's release conventions (patch bump, since no new tools — just docs + error UX)
- [x] 5.3 Run the full `npm test` once more end-to-end before commit

## 6. Memory + sync bookkeeping

- [ ] 6.1 After the change ships, update `~/.claude/projects/-Users-talweiss-Developer-run402-public/memory/project_last_integration.md` with the new last-synced commit (`2ab48095` from run402) and the run402-public commit that ships this change
