## Why

The run402 gateway shipped a **breaking rename** of the RLS templates on 2026-04-21 (run402 PR #35, commit `7bc547a9`):

- `public_read` → `public_read_authenticated_write`
- `public_read_write` → `public_read_write_UNRESTRICTED` (and now requires `i_understand_this_is_unrestricted: true` in the request body)
- `user_owns_rows` gained type-aware predicates and auto-indexing (no API shape change)

run402-public still advertises the old names in 28 places across the MCP tool schemas, CLI help, skill docs, and `cli/llms-cli.txt`. The MCP tool's Zod enum actively **rejects** the new names, so agents using the new docs against the new gateway can't call setup-rls or bundle-deploy at all through MCP. Agents using the old names get a 400 from the gateway with a message that lists only the new valid templates.

The rename was deliberate — the names are the security messaging. "public_read_write" downplayed what's actually a fully-open table; "public_read_write_UNRESTRICTED" + explicit ACK forces the caller to acknowledge what they're doing. Aliasing the old names on the client would undo that intent.

## What Changes

- **MCP tool schemas** (`src/tools/setup-rls.ts`, `src/tools/bundle-deploy.ts`): Zod enum replaces old names with the new three. Add optional `i_understand_this_is_unrestricted: z.boolean().optional()`. Use `.superRefine()` to require the ACK when template is `public_read_write_UNRESTRICTED` — catches the mistake at the tool boundary before the network call.
- **MCP tool description** (`src/index.ts`): update the `setup_rls` description string.
- **CLI help** (`cli/lib/projects.mjs`, `cli/lib/deploy.mjs`): replace old names in examples, help text, and the manifest RLS example. Keep help verbose (not terse) so agents that read `--help` get the safety context.
- **Skill docs** (`SKILL.md`, `openclaw/SKILL.md`): replace old names; adopt the new ⚠ warning copy and "prefer user_owns_rows for anything user-scoped" framing from the gateway `site/llms.txt`.
- **Agent-facing docs** (`cli/llms-cli.txt`): 11 refs across example curl, template list, permission matrix, and inline prose.
- **Tests**: update `cli-integration.test.ts:255` (hits live API — must use new name) and `cli-e2e.test.mjs:660` (mocked, but should reflect reality).
- **Version**: minor bump to **v1.36.0**. This is a breaking change to the MCP schema's accepted enum values, which warrants more than a patch even though the underlying API surface existed.

## Capabilities

### New Capabilities
- `rls-templates` — the three valid RLS template names, their semantics, the UNRESTRICTED ACK requirement, and the surfaces (MCP, CLI, docs) that must agree on them.

### Modified Capabilities
_None. No prior spec covered RLS template names._

## Impact

- **MCP**: `src/tools/setup-rls.ts`, `src/tools/bundle-deploy.ts`, `src/index.ts`.
- **CLI**: `cli/lib/projects.mjs`, `cli/lib/deploy.mjs`.
- **Docs (this repo, pulled by private site at deploy time)**: `SKILL.md`, `openclaw/SKILL.md`, `cli/llms-cli.txt`.
- **Tests**: `cli-integration.test.ts`, `cli-e2e.test.mjs`.
- **Version**: `package.json`, `cli/package.json`, `openclaw/package.json` — bump to `1.36.0`.
- **No gateway changes** — this is pure client alignment with the server shipped on 2026-04-21.

## Breaking-change acceptance

Agents with saved manifests using `public_read` / `public_read_write` will see 400s from the gateway on their next deploy. When they re-read the updated docs they'll find the new names and the ACK flag. We're accepting this break because:

1. The server already broke it — aliasing here only delays the inevitable docs re-read.
2. The rename *is* the security message; masking it would defeat the purpose.
3. The error message from the gateway lists the valid templates, so the discovery path is short.
