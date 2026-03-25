## 1. Make create_mailbox idempotent on 409

- [x] 1.1 Update `src/tools/create-mailbox.ts`: on 409 response, call `GET /mailboxes/v1` to discover existing mailbox, cache in keystore, return success with "already existed" note
- [x] 1.2 Update `cli/lib/email.mjs` `create()`: on 409 response, call `resolveMailboxId()` to discover existing mailbox, output `{ status: "ok", ..., already_existed: true }`
- [x] 1.3 Update `src/tools/create-mailbox.test.ts`: add tests for 409 recovery (successful GET returns mailbox) and 409 recovery failure (GET returns empty)

## 2. Add get_mailbox tool / email status command

- [x] 2.1 Create `src/tools/get-mailbox.ts` with `getMailboxSchema` and `handleGetMailbox` — calls `GET /mailboxes/v1`, caches result, returns mailbox info
- [x] 2.2 Register `get_mailbox` tool in `src/index.ts`
- [x] 2.3 Add `status` subcommand to `cli/lib/email.mjs` — calls `GET /mailboxes/v1`, outputs JSON
- [x] 2.4 Update CLI HELP string in `cli/lib/email.mjs` to include `status` subcommand
- [x] 2.5 Verify OpenClaw `openclaw/scripts/email.mjs` re-exports cover the new subcommand (it re-exports `run` which dispatches on sub, so just the switch case is needed)

## 3. Tests

- [x] 3.1 Create `src/tools/get-mailbox.test.ts` with tests: successful retrieval, no mailbox found, project not in keystore, API error
- [x] 3.2 Add `get_mailbox` to `SURFACE` array in `sync.test.ts` with MCP `get_mailbox`, CLI `email:status`, OpenClaw `email:status`
- [x] 3.3 Run `npm test` to verify all tests pass

## 4. Documentation

- [x] 4.1 Update `~/dev/run402/site/llms-cli.txt` to include `status` in the email subcommands section (if file exists)
- [x] 4.2 Update `~/dev/run402/site/llms.txt` (no MCP Tools table — no changes needed) to include `get_mailbox` in the MCP Tools table (if file exists)
- [x] 4.3 Update `SKILL.md` to include `get_mailbox` tool if email tools are listed there
