## 1. CLI `run402 status` (cli/lib/status.mjs)

- [x] 1.1 Rename the `wallet` object output fields: `name` → `local_label`, `label` → `server_label` (map from `walletName` / `walletMeta?.label`); keep `address`.
- [x] 1.2 Remove the `allowance` block and the `funded`-derived data from the success payload.
- [x] 1.3 Replace top-level `wallet_balance_usd_micros` and the `billing` block with a single `balances` object: `on_chain_usd_micros` (from `walletBalance`), `on_chain_token` (`rail === "mpp" ? "pathUSD" : "USDC"`), `prepaid_credit_usd_micros` (from `billing.available_usd_micros`, `null` when no account), `held_usd_micros` (from `billing.held_usd_micros`, `null` when no account).
- [x] 1.4 Change the no-allowance empty-state from `{ allowance: null, hint }` to `{ wallet: null, hint: "Run: run402 init" }`.
- [x] 1.5 Update the HELP text block to describe `local_label`/`server_label`, the `balances` object, and drop references to `wallet_balance_usd_micros`, `allowance`, and `funded`.

## 2. CLI `run402 init` (cli/lib/init.mjs)

- [x] 2.1 Replace `summary.allowance = { address, funded }` with `summary.wallet = { local_label, server_label, address }` — reads `getActiveProfile` + `readMeta` like `status.mjs`; drops `funded` (the `summary.allowance.funded` assignments in both faucet branches were removed; on-disk `saveAllowance({funded})` is unchanged).
- [x] 2.2 Replace `summary.balance = { symbol, usd_micros }` (both rail branches) with `summary.balances = { on_chain_usd_micros, on_chain_token, prepaid_credit_usd_micros, held_usd_micros }`; added a best-effort `billing.checkBalance(address)` for prepaid_credit/held (`null` when no account).
- [x] 2.3 Updated the top-level `summary` shape to `{ config_dir, wallet, rail, network, balances, tier, projects_saved, next_step }` and the HELP "Output:" block.

## 3. SDK `whoami` (sdk/src/index.ts)

- [x] 3.1 Renamed `WhoAmI` fields `name` → `local_label`, `label` → `server_label` (+ JSDoc); kept `address`/`activeProject`.
- [x] 3.2 `whoami()` maps the internal `WalletIdentity` (`name`/`label`, unchanged) to `local_label`/`server_label` at the return edge.
- [x] 3.3 Grepped the repo — no non-test production consumers read `.name`/`.label` off a `whoami()` result or `wallet` status object.

## 4. MCP tools (src/tools/status.ts, src/tools/init.ts)

- [x] 4.1 `status.ts`: replaced `wallet`/`allowance`/`funded` rows with `local_label`, `server_label`, `address`, `rail`.
- [x] 4.2 `status.ts`: replaced the single `balance` row with `prepaid_credit` + `held`. NOTE: MCP does not read on-chain balance, so no `on_chain` row is added; use `run402 status` (CLI) for the on-chain figure. Added `held_usd_micros?` to the `OrganizationDetail` SDK type so this typechecks.
- [x] 4.3 `init.ts`: the MCP init table had no `funded`/`balance` rows; renamed the overloaded `| allowance |` row label → `| address |`.

## 5. CLI `wallets list` / `wallets current` (cli/lib/wallets.mjs)

- [x] 5.1 Renamed `walletInfo` descriptor fields `name`/`label` → `local_label`/`server_label` (feeds `wallets list`); kept `address`, `address_short`, `rail`, `active`.
- [x] 5.2 Renamed `wallets current` `name` → `local_label`, added `server_label`; also renamed the `new`/`use`/`import`/`rm` echo `name` → `local_label` for command-family consistency (on-disk `writeMeta` keys unchanged).

## 6. Tests

- [x] 6.1 Updated `sdk/src/whoami.test.ts` for the renamed `WhoAmI` fields (mocks keep internal `name`/`label`).
- [x] 6.2 `src/tools/status.test.ts` passes unmodified (asserts substrings still present); `src/tools/init.test.ts` passes unmodified (asserts `(created)` + address value, not the row label).
- [x] 6.3 Updated `cli-e2e.test.mjs` (status shape, init JSON shape, GH-81 mpp test, empty-state `wallet: null`), `cli-argv.test.mjs` (init `wallet`), `cli-wallets.test.mjs` (list/current `local_label`/`server_label`), `cli-integration.test.ts` (live status).
- [x] 6.4 Added assertions for rail-aware `on_chain_token` (`x402`→`USDC`, `mpp`→`pathUSD`) and the grouped `balances` shape.
- [x] 6.5 `npm test` green: 614 pass / 0 fail, plus doc-snippet check.

## 7. Docs

- [x] 7.1 Updated `cli/llms-cli.txt` status / wallets / local-state-inspection sections to the new field names and `balances` shape.
- [x] 7.2 Scanned `documentation.md` (no row enumerates these fields — no edit needed); updated the `README.md` status one-liner. No SDK doc prose enumerated `whoami` fields. No init JSON shape was documented in llms-cli.txt.

## 8. Finalize

- [x] 8.1 Re-run `openspec validate redesign-status-output --strict`.
- [x] 8.2 Confirm every spec scenario maps to an updated test or implementation behavior.
