## 1. Drift-Protection Test (write first, fail until end)

- [x] 1.1 Add `cli-output-contract.test.mjs` that statically scans `cli/lib/*.mjs` for `JSON.stringify({ status:` patterns on stdout-bound code paths and fails on any match outside an explicit allowlist.
- [x] 1.2 Allowlist the stderr error envelope emissions in `cli/lib/sdk-errors.mjs` (both `reportSdkError` and the inline `status: "error"` literal at the top of the file).
- [x] 1.3 Ensure the scanner ignores per-item `status` fields inside payload objects (e.g. `checks[].status` inside `cli/lib/doctor.mjs`) by limiting matches to top-level `console.log(JSON.stringify({ status:` patterns.
- [x] 1.4 Wire the new test into `npm test` and confirm it fails initially against current `cli/lib/*.mjs` source — the failing list is the implementation punch list.

## 2. Spec-Triggering Fix: validate-expose

- [x] 2.1 In `cli/lib/projects.mjs:349`, drop the `{ status: "ok", ...data }` wrapper and emit `data` directly.
- [x] 2.2 Update the two `validate-expose` assertions in `cli-e2e.test.mjs` (around lines 1394 and 1408) to drop `parsed.status === "ok"` checks; assert directly on `hasErrors`, `errors`, and `warnings`.
- [x] 2.3 Confirm `npm run test:e2e` passes for `validate-expose`.

## 3. CLI Reads, Lists, And Info Commands (low-effort: most already unwrapped)

- [x] 3.1 `cli/lib/ai.mjs` — `translate`, `moderate`, `usage`: drop `{ status: "ok", ... }` wrappers; emit `{ text, from, to }`, `{ flagged, categories, category_scores }`, `{ ...usage }` raw.
- [x] 3.2 `cli/lib/email.mjs` — `info`/`status`, `get-raw`: drop wrappers; emit mailbox/message details raw.
- [x] 3.3 `cli/lib/ci.mjs` — `link github`, `list`, `revoke`, `set-asset-scopes`: drop wrappers; emit binding/list/revoke payloads raw.
- [x] 3.4 `cli/lib/deploy-v2.mjs` — `apply` (non-`--final-only` path), `resume`, `list`, `events`, `release get`/`active`/`diff`, `diagnose`, `resolve`: drop wrappers across all 9 emit sites (lines 512, 835, 863, 888, 936, 965, 1008, 1109, plus apply summary). Each payload already has informative fields (`release_id`, `operation_id`, `release`, `diff`, `would_serve`).
- [x] 3.5 `cli/lib/auth.mjs` — magic-link, create-user, invite-user, verify, set-password, settings, passkey-register-verify, passkey-login-verify, delete-passkey: drop wrappers (~11 emit sites).
- [x] 3.6 `cli/lib/init-astro.mjs` and `cli/lib/init.mjs` — drop wrappers; emit init-result payload raw.
- [x] 3.7 `cli/lib/billing.mjs` — `link-wallet`, `auto-recharge`: drop wrappers; emit billing payload raw.
- [x] 3.8 `cli/lib/image.mjs` — `generate`: drop wrappers; emit `{ file, size, aspect }` or `{ aspect, content_type, image }` raw.
- [x] 3.9 `cli/lib/message.mjs` — drop wrapper.
- [x] 3.10 `cli/lib/webhooks.mjs` — drop wrappers across the namespace (resolve the existing MIXED state to uniformly raw).

## 4. CLI Mutations With No Natural Payload (design new shapes per spec)

- [x] 4.1 `cli/lib/secrets.mjs` — `set` becomes `{ key, project_id, set: true }`; `delete` becomes `{ key, project_id, deleted: true }`.
- [x] 4.2 `cli/lib/subdomains.mjs` — `release` becomes `{ name, released: true }`.
- [x] 4.3 `cli/lib/functions.mjs` — `delete` becomes `{ name, project_id, deleted: true }`.
- [x] 4.4 `cli/lib/assets.mjs` — `rm` becomes `{ key, project_id, deleted: true }`; `get` becomes `{ key, output, bytes? }` (drop wrapper, keep informative fields).
- [x] 4.5 `cli/lib/email.mjs` — `delete` becomes `{ mailbox_id, address, deleted: true }`; `send` becomes `{ message_id, to, template, subject }` (drop wrapper); `reply` becomes `{ message_id, to, subject, in_reply_to }` (drop wrapper).
- [x] 4.6 `cli/lib/domains.mjs` — `delete` becomes `{ domain, released: true }`.
- [x] 4.7 `cli/lib/contracts.mjs` — `set-recovery` becomes `{ wallet_id, recovery_address }`; `set-alert` becomes `{ wallet_id, threshold_wei }`.
- [x] 4.8 `cli/lib/apps.mjs` — `update` becomes the updated app descriptor; `delete` becomes `{ app_id, deleted: true }`.

## 5. CLI Local-State Inspection Redesign

- [x] 5.1 `cli/lib/status.mjs` — replace `{ status: "no_allowance", message: "..." }` with `{ allowance: null, hint: "Run: run402 init" }`; replace the success branch's `status` wrapper with raw allowance + project state.
- [x] 5.2 `cli/lib/allowance.mjs` — `status`: replace `{ status: "no_wallet", message: "..." }` with `{ wallet: null, hint: "Run: run402 allowance create" }`; replace the present-state branch's wrapper with `{ wallet: { address, rail, ... } }` (or equivalent typed shape).
- [x] 5.3 `cli/lib/allowance.mjs` — `create`, `faucet`: drop wrappers; emit `{ address, rail, ... }` and faucet payload raw.

## 6. Tests And Snapshots Sweep

- [x] 6.1 Update `cli-e2e.test.mjs` — sweep for every `parsed.status === "ok"` assertion (estimated ~40–60 sites); replace with assertions on the new payload-specific fields.
- [x] 6.2 Update `cli-help.test.mjs` snapshots if any reference output JSON shapes.
- [x] 6.3 Update `cli/lib/projects.mjs` `cli-provision-active.test.mjs` and `cli-argv.test.mjs` and `cli-env.test.mjs` for any envelope-dependent assertions.
- [x] 6.4 Update unit tests in `src/tools/*.test.ts` if any reference CLI output shapes (MCP tool tests should NOT need changes — they use a different envelope).
- [x] 6.5 Run `npm test` and confirm all suites pass, including the drift-protection test from §1.
- [x] 6.6 Run `npm run test:integration` and `npm run test:integration:full` to confirm integration tests still pass against a live gateway.

## 7. Docs And Skills Sweep

- [x] 7.1 Add a new top-level "Output Contract" section to `cli/llms-cli.txt`, placed before the first per-command reference. Cover stdout shape, stderr shape, exit codes, mutation echo conventions, local-state inspection conventions, plain-text exception, and the `status` field's exclusive use as the stderr error envelope sentinel.
- [x] 7.2 Sweep `cli/llms-cli.txt` per-command examples — remove every `"status": "ok"` in success-path JSON examples; update example outputs to match the new payload shapes.
- [x] 7.3 Update `cli/README.md` examples for any `status: "ok"` references.
- [x] 7.4 Update `openclaw/SKILL.md` and `openclaw/README.md` examples to match.
- [x] 7.5 Update root `SKILL.md` if it cites CLI output shapes (most likely it does not — verify by grep).
- [x] 7.6 Walk `documentation.md` and update every surface listed there that demonstrates CLI output (npm package readmes, etc.).
- [x] 7.7 Add a CHANGELOG entry for `run402` CLI calling out the breaking change with one before/after example pair.

## 8. Cross-Surface Sync And Drift Guards

- [x] 8.1 Update `sync.test.ts` if it asserts anything envelope-shaped (most likely just verifies command surface, but confirm).
- [x] 8.2 Confirm `SKILL.test.ts` does not assert envelope shapes (this test focuses on tool/verb names, but re-run to be sure).
- [x] 8.3 Re-run `npm run test:skill` and `npm run test:sync`.

## 9. Release

- [ ] 9.1 Bump `run402` CLI package to v3.0.0 in `cli/package.json` (this is a breaking change to the public CLI machine-readable output contract).
- [ ] 9.2 Note in the publish notes that `run402-mcp` and `@run402/sdk` do not have output contract changes — only the CLI's stdout envelope is affected. Per the lockstep release policy, they still bump together, but the breaking change is CLI-only.
- [ ] 9.3 Publish via `/publish` (separate explicit publish authorization per `feedback_publish_authorization`).

## 10. Verification

- [ ] 10.1 After publish, run a smoke check: `npx run402@latest projects list`, `npx run402@latest status`, `npx run402@latest allowance status` — confirm raw payload shapes and no `status: "ok"` envelope.
- [ ] 10.2 Confirm `npx run402@latest projects validate-expose '<bad-manifest>'` no longer emits `status: "ok"` alongside `hasErrors: true` — the original trigger for this change is resolved.
- [ ] 10.3 Spot-check `cli/llms-cli.txt` rendering on the public docs site (canonical source is `cli/llms-cli.txt` in this repo per `reference_llms_txt`).
