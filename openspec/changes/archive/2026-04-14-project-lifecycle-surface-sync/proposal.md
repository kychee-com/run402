## Why

The private run402 gateway replaced the old "lease expires + 7 days → archived" path with a ~104-day soft-delete state machine (`active → past_due → frozen → dormant → purged`). Control-plane mutating routes now return 402 with `{lifecycle_state, entered_state_at, next_transition_at}` once a project is past_due, DELETE `/projects/v1/:id` returns `status: "purged"` instead of `"archived"`, and `POST /subdomains/v1` can now return 409 when a name is reserved under another wallet's grace period. The public CLI, MCP server, OpenClaw skill, and docs still describe the old 7-day archive flow — agents using run402-public today will see 402 errors they can't interpret and will read lifecycle guidance that contradicts how the gateway actually behaves.

## What Changes

- **BREAKING (terminology)**: `archive_project` MCP tool and `run402 archive` CLI subcommand now reflect the purge/grace vocabulary in their text output. The tool name stays the same (DELETE endpoint path is unchanged); only user-visible strings change.
- Extend `src/errors.ts` `formatApiError` to extract `lifecycle_state`, `entered_state_at`, `next_transition_at`, and `scheduled_purge_at` from 402 response bodies and surface them with actionable guidance ("renew to reactivate" when in grace, distinct from existing renew-url/usage 402 paths).
- Add a 409 branch to `formatApiError` guidance so subdomain-claim tools (`add_custom_domain`, subdomain-related CLI) explain the grace-period reservation case.
- Update `SKILL.md` and `openclaw/SKILL.md` lifecycle/runtime sections to replace the 7-day archive description with the four-stage grace window, and clarify that end-user data plane keeps serving throughout while owner control-plane returns 402 after day 14.
- Update any CLI/MCP tool descriptions that hardcode "archived" wording (at minimum `src/tools/archive-project.ts` and `cli/lib/projects.mjs` or equivalent).
- Add tests covering the new 402 (lifecycle_state) and 409 (subdomain reserved) branches in `src/errors.test.ts` (create if missing).

## Capabilities

### New Capabilities
<!-- None -->

### Modified Capabilities
<!-- No capabilities in openspec/specs/ describe the lifecycle surface today; this change introduces a new one covering how run402-public renders lifecycle/grace signals from the gateway. -->
- `project-lifecycle-surface`: new capability describing how CLI/MCP/skill surface the gateway's soft-delete state machine (grace 402s, purge DELETE response, subdomain 409 reservation, documentation vocabulary).

## Impact

- Code: `src/errors.ts`, `src/tools/archive-project.ts`, CLI `cli/lib/projects.mjs` archive subcommand, possibly subdomain-related tools for 409 wording.
- Docs: `SKILL.md`, `openclaw/SKILL.md`, any README lifecycle sections.
- Tests: new/updated `src/errors.test.ts` cases for lifecycle 402 and subdomain 409.
- Dependencies: none (no new packages, no schema changes).
- External: no gateway API changes in this repo; this is a pure public-surface catch-up to a gateway change already shipped in run402 (`d28d3153`, `3c303ddf`).
