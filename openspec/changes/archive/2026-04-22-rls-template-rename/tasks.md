## 1. MCP tool schemas

- [x] 1.1 Update Zod enum in `src/tools/setup-rls.ts:9` to `["user_owns_rows", "public_read_authenticated_write", "public_read_write_UNRESTRICTED"]`
- [x] 1.2 Add `i_understand_this_is_unrestricted: z.boolean().optional()` field to `setupRlsSchema`
- [x] 1.3 Wrap `setupRlsSchema` with `z.object().superRefine()` that requires the ACK flag when template is `public_read_write_UNRESTRICTED` (applied at handler boundary via exported `setupRlsRefined`; MCP SDK accepts only raw shapes)
- [x] 1.4 Update `setupRlsSchema` description text to reflect new template names and ACK requirement
- [x] 1.5 Pass `i_understand_this_is_unrestricted` through to the API request body in `handleSetupRls`
- [x] 1.6 Repeat 1.1–1.3 for the `rls` sub-schema in `src/tools/bundle-deploy.ts:15` (refinement via exported `bundleDeployRlsRefined`)
- [x] 1.7 Pass `i_understand_this_is_unrestricted` through in `handleBundleDeploy`'s rls object
- [x] 1.8 Update tool description in `src/index.ts:179` to list new names

## 2. MCP tool tests

- [x] 2.1 Add a unit test in `src/tools/setup-rls.test.ts` verifying Zod rejects `public_read` with a clear error
- [x] 2.2 Add a unit test verifying Zod rejects `public_read_write_UNRESTRICTED` without the ACK flag (via superRefine)
- [x] 2.3 Add a unit test verifying `public_read_write_UNRESTRICTED` with `i_understand_this_is_unrestricted: true` passes validation and forwards the flag in the request body
- [x] 2.4 Repeat the three tests in `src/tools/bundle-deploy.test.ts` for the nested `rls` block (if such a test file exists; else create)

## 3. CLI help text

- [x] 3.1 Update `cli/lib/projects.mjs:39` example to use `public_read_authenticated_write`
- [x] 3.2 Update `cli/lib/projects.mjs:48` template list to new three names
- [x] 3.3 Update `cli/lib/deploy.mjs:97` manifest example template to `public_read_write_UNRESTRICTED` + add `"i_understand_this_is_unrestricted": true` line
- [x] 3.4 Update `cli/lib/deploy.mjs:133–134` help text to new three names with a short safety note per template

## 4. Skill docs

- [x] 4.1 Update `SKILL.md:679` `public_read` reference to `public_read_authenticated_write` + 1-sentence "any authenticated user can write any row" warning
- [x] 4.2 Update `SKILL.md:680` `public_read_write` reference to `public_read_write_UNRESTRICTED` + ⚠ warning + ACK requirement + example with the flag
- [x] 4.3 Update `openclaw/SKILL.md:366–375` — same two changes, keep the section structure
- [x] 4.4 Add "Prefer `user_owns_rows` for anything user-scoped" preamble sentence to the RLS templates section in both SKILL.md files

## 5. Agent-facing docs (`cli/llms-cli.txt`)

- [x] 5.1 Update line 115 manifest example to `public_read_write_UNRESTRICTED` + ACK field
- [x] 5.2 Update lines 159–160 template list: new three names, short safety note per
- [x] 5.3 Update lines 164–165 permission matrix header rows to new names
- [x] 5.4 Update line 193 example CLI invocation
- [x] 5.5 Update line 235 CLI synopsis argument list
- [x] 5.6 Update line 568 `anon_key` paragraph mentioning `public_read_write` to the new name
- [x] 5.7 Update lines 623, 653 `public_read_write` references in the sample app section
- [x] 5.8 Update lines 689–690 guestbook example to new name + ACK
- [x] 5.9 Update line 841 manifest RLS description
- [x] 5.10 Add "Prefer `user_owns_rows`" preamble to the RLS section to match SKILL.md

## 6. Tests

- [x] 6.1 Update `cli-integration.test.ts:255` to use `public_read_authenticated_write` (3-arg CLI path; UNRESTRICTED requires the deploy-manifest path which is already covered via `cli-e2e` deploy tests)
- [x] 6.2 Update `cli-e2e.test.mjs:660` to use `public_read_authenticated_write` (mock-based, align with reality)
- [x] 6.3 Run `npm test` and `npm run test:e2e` to confirm all pass (287 unit + 98 CLI e2e, 0 fail)

## 7. Version + publish

- [x] 7.1 Bump version to `1.36.0` in `package.json`
- [x] 7.2 Bump version to `1.36.0` in `cli/package.json`
- [x] 7.3 ~~Bump `openclaw/package.json`~~ — openclaw has no package.json (it's a skill directory, not a separate npm package)
- [x] 7.4 Run `npm run build` and `npm test` — confirm clean (build clean; 287 unit + 98 CLI e2e tests all pass)
- [ ] 7.5 Run `/publish` skill to publish both packages (needs explicit user confirmation — publishing to npm)

## 8. Memory + archive

- [ ] 8.1 Update `project_last_integration.md` memory: move `7bc547a9` from "pending action" to "synced", note the public commit that closes it, bump the "last synced" commit to current public HEAD
- [ ] 8.2 Archive this change per OpenSpec convention (`openspec/changes/archive/`)
