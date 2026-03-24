## 1. MCP Tools

- [x] 1.1 Create `src/tools/create-mailbox.ts` — Zod schema (`project_id`, `slug`) + handler: validate slug, `getProject()`, `POST /mailboxes/v1`, store `mailbox_id`/`mailbox_address` in keystore via `updateProject()`
- [x] 1.2 Create `src/tools/send-email.ts` — Zod schema (`project_id`, `template` enum, `to`, `variables` object) + handler: lookup mailbox ID from keystore (with fallback discovery via `GET /mailboxes/v1`), `POST /mailboxes/v1/:id/messages`
- [x] 1.3 Create `src/tools/list-emails.ts` — Zod schema (`project_id`) + handler: lookup mailbox ID, `GET /mailboxes/v1/:id/messages`, format as markdown table
- [x] 1.4 Create `src/tools/get-email.ts` — Zod schema (`project_id`, `message_id`) + handler: lookup mailbox ID, `GET /mailboxes/v1/:id/messages/:messageId`, format details + replies
- [x] 1.5 Register all 4 tools in `src/index.ts` via `server.tool()`

## 2. CLI Commands

- [x] 2.1 Create `cli/lib/email.mjs` with HELP string (matching existing module style: title, usage, subcommands table, examples, notes) and `run(sub, args)` dispatcher with `--help`/`-h` support
- [x] 2.2 Implement `create` subcommand — parse slug arg, validate, `POST /mailboxes/v1`, save mailbox ID to keystore
- [x] 2.3 Implement `send` subcommand — parse `--template`, `--to`, `--var key=value` flags, lookup mailbox ID, `POST /mailboxes/v1/:id/messages`
- [x] 2.4 Implement `list` subcommand — lookup mailbox ID, `GET /mailboxes/v1/:id/messages`, JSON output
- [x] 2.5 Implement `get` subcommand — parse message_id arg, lookup mailbox ID, `GET /mailboxes/v1/:id/messages/:messageId`, JSON output
- [x] 2.6 Register `email` command group in CLI entry point (`cli/index.mjs`)

## 3. OpenClaw Shim

- [x] 3.1 Create `openclaw/scripts/email.mjs` — re-export `run` from `../../cli/lib/email.mjs`

## 4. Sync & Documentation

- [x] 4.1 Add 4 email capabilities to the `SURFACE` array in `sync.test.ts` (`create_mailbox`, `send_email`, `list_emails`, `get_email`)
- [x] 4.2 Add email tool documentation sections to `SKILL.md`
- [x] 4.3 Add `### email` section to `~/dev/run402/site/llms-cli.txt` in the Command Reference area (after `message` / before the `---` separator), matching existing format: intro line, bullet list of commands with args

## 5. Tests

- [x] 5.1 Create `src/tools/create-mailbox.test.ts` — mock fetch, temp keystore, test success + slug validation + project not found + API error
- [x] 5.2 Create `src/tools/send-email.test.ts` — mock fetch, test success + no mailbox + invalid template + API error
- [x] 5.3 Create `src/tools/list-emails.test.ts` — mock fetch, test success + empty list + no mailbox
- [x] 5.4 Create `src/tools/get-email.test.ts` — mock fetch, test success + not found + no mailbox
- [x] 5.5 Run `npm test` and verify all tests pass (unit + sync + skill)
