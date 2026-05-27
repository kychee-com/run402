# Tasks — email-multi-mailbox-selector

## 1. SDK — resolveMailbox selector + create-409 fix (TDD)

- [x] 1.1 **Red:** In `sdk/src/namespaces/email.test.ts`, add tests against the new behavior:
  - `resolveMailbox`/`send` with `mailbox: "mbx_…"` → uses the id directly (no list GET).
  - with `mailbox: "<slug>"` → lists, matches slug; unknown slug → 404 error.
  - omitted + 1 mailbox → uses it; omitted + 0 → "create one first"; omitted + 2 → ambiguity error naming the slugs, no send.
  - `createMailbox` 409 (`Slug already in use`) → throws the 409, does NOT return `list[0]`.
  Run the file; confirm the new tests fail.
- [x] 1.2 **Green:** In `sdk/src/namespaces/email.ts`:
  - `resolveMailbox(projectId, selector?)`: id-prefix fast path; slug match via `listMailboxes`; omitted → 0/1/2+ rule (2+ throws a 409 `ApiError` naming slugs; use single quotes around `mailbox` in the message to avoid nested backticks). Refresh keystore cache only on the single-mailbox path.
  - Thread `mailbox?` through `send`/`list` (opts field), `get`/`getRaw`/`getMailbox` (trailing `opts?: { mailbox?: string }` or selector), `deleteMailbox` (existing arg accepts slug or id), and the `Webhooks` class (resolver closure takes a selector; each method gains a trailing selector/opts).
  - `getMailbox(projectId, selector?)`: return the selected/only mailbox; throw the ambiguity error instead of silently returning `list[0]`.
  - `createMailbox`: delete the `catch (409) → listMailboxes → return list[0]` block; let the 409 propagate. Keep the success-path cache write.
  - Add `mailbox?: string` to `SendEmailOptions` and `ListEmailsOptions`.
- [x] 1.3 Run `node --experimental-test-module-mocks --test --import tsx sdk/src/namespaces/email.test.ts` green.

## 2. MCP tools — `mailbox` parameter

- [x] 2.1 Add `mailbox: z.string().optional().describe("Target mailbox by slug or id; omit only when the project has exactly one.")` to the schemas and thread it into the SDK call for: `send-email`, `list-emails`, `get-email`, `get-email-raw`, `get-mailbox`, `delete-mailbox`, `register-mailbox-webhook`, `list-mailbox-webhooks`, `get-mailbox-webhook`, `update-mailbox-webhook`, `delete-mailbox-webhook` (`src/tools/*.ts` + `src/index.ts` schema registration).
- [x] 2.2 Update each tool's `*.test.ts` to cover passing `mailbox` through and (for send/list/get) the ambiguity-error surfacing.

## 3. CLI — `--mailbox` flag + HELP

- [x] 3.1 In `cli/lib/email.mjs`, add `--mailbox` to the value-flag lists and pass it to the SDK for `send`, `list`, `get`, `get-raw`, `reply`, `info`/`status`, `delete`. In `cli/lib/webhooks.mjs`, add `--mailbox` to each webhook subcommand.
- [x] 3.2 Update `HELP` + `SUB_HELP`: remove the two "One mailbox per project" notes; document `--mailbox <slug|id>` and "specify which mailbox when the project has more than one".
- [x] 3.3 Update `cli-*.test.mjs` (help/contract/e2e) assertions affected by the HELP text and the new flag.

## 4. Parity + specs

- [x] 4.1 Update `sync.test.ts` SURFACE so the `mailbox` selector is recognized as present across MCP + CLI (+ OpenClaw if it mirrors these) for the email/webhook tools. Run `npm run test:sync`.
- [x] 4.2 (Spec delta already authored at `specs/email-mailbox-selection/spec.md`.) Confirm it matches the implemented error messages and selector semantics.

## 5. Docs

- [x] 5.1 `cli/llms-cli.txt` email section: document `--mailbox` and multi-mailbox; drop "one mailbox per project".
- [x] 5.2 `cli/README.md`, root `SKILL.md`, `llms-mcp.txt`: update email examples to mention multi-mailbox + the `mailbox` selector. `grep -rin "one mailbox per project\|already has a mailbox" cli/ src/ *.md *.txt` returns no stale live claims.

## 6. Regression gate

- [x] 6.1 `npm run build` (core → sdk → mcp → cli) succeeds.
- [x] 6.2 Full test suite green. NOTE: `npm test` globs (`'sdk/src/**/*.test.ts'` etc.) do not expand under Windows `cmd.exe`; run the unit globs through Bash so node v22 expands them — `node --experimental-test-module-mocks --test --import tsx SKILL.test.ts sync.test.ts "core/src/**/*.test.ts" "sdk/src/**/*.test.ts" "src/**/*.test.ts"` — then the CLI `.mjs` tests (`node --test cli-*.test.mjs`), then `npm run test:docs`. All pass.
- [x] 6.3 No new failures vs a stashed clean HEAD (characterize any pre-existing failures the same way as run402).

## 7. Archive + publish

- [x] 7.1 Sync the `email-mailbox-selection` capability into `openspec/specs/` and move the change to `openspec/changes/archive/2026-05-27-email-multi-mailbox-selector/`.
- [x] 7.2 Commit + push to main.
- [x] 7.3 Publish: `gh workflow run publish.yml -f bump=minor` (lockstep 2.20.1 → 2.21.0 across `run402-mcp` + `run402` + `@run402/sdk`). The workflow runs the full `npm test` + tarball smoke before publishing. Verify the three npm versions + the `v2.21.0` tag.
