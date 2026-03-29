## 1. API (run402 gateway)

- [ ] 1.1 Add `since` query parameter parsing in `packages/gateway/src/routes/functions.ts` logs route (integer, epoch ms, optional)
- [ ] 1.2 Add `startTime` parameter to `getFunctionLogs()` in `packages/gateway/src/services/functions.ts`, pass to `FilterLogEventsCommand`
- [ ] 1.3 Test: `since` filters logs correctly, omitting `since` is backwards compatible, future `since` returns empty array

## 2. MCP tool

- [x] 2.1 Add optional `since` field (ISO string) to schema in `src/tools/get-function-logs.ts`
- [x] 2.2 Convert ISO string to epoch ms and pass as `?since=` query param to API
- [x] 2.3 Add unit test for `since` parameter in `src/tools/get-function-logs.test.ts`

## 3. CLI

- [x] 3.1 Add `--since` flag parsing in `cli/lib/functions.mjs` logs subcommand (accept ISO string or epoch ms)
- [x] 3.2 Pass `since` as query parameter to API request
- [x] 3.3 Add `--follow` flag with polling loop: poll every 3s, track last-seen timestamp, print new entries, use `since = lastTs + 1ms`
- [x] 3.4 Handle Ctrl-C cleanly in follow mode (process.on SIGINT)

## 4. Docs & sync

- [x] 4.1 Update SKILL.md functions logs section with `since` parameter
- [x] 4.2 Update `llms-cli.txt` in run402 repo with `--since` and `--follow` flags
