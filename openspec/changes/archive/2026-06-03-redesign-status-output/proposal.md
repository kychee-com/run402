## Why

`run402 status` carries three pieces of naming debt that have already tripped users (see the in-code `GH-32` note that split `balance`). The word "allowance" means the wallet here but "prepaid credit" on the billing page; the `wallet` and `allowance` blocks describe the same wallet with a duplicate `address`; `funded` looks like a balance but is a stale local boolean; and the wallet identity fields `name`/`label` read as two words for the same thing without conveying that one is the *local selector* and the other the *server-synced display name*. The same `name`/`label` ambiguity is repeated across `whoami`, `wallets list`, and `wallets current`, so the confusion is cross-surface, not local to one command.

## What Changes

- **Rename the wallet identity output fields** `name` → `local_label` and `label` → `server_label` across every user-facing surface that emits them: `run402 status`, `run402 wallets list`, `run402 wallets current`, the MCP `status` tool, and the SDK `r.whoami()` result. `server_label` is the wire/API term already used by `/wallets/v1/:address/label`, `getLabel`/`setLabel`, and `meta.json`; `local_label` is its symmetric local partner. Internal storage (`meta.json` keys, the credential provider's `WalletIdentity` shape) keeps `name`/`label` — only the rendered output is renamed, so there is no on-disk migration.
- **BREAKING (SDK):** the `WhoAmI` TypeScript interface fields `name`/`label` become `local_label`/`server_label`. Type-level break for SDK consumers; rides the next lockstep version bump.
- **Restructure the `run402 status` balances** into one `balances` object: `on_chain_usd_micros`, `on_chain_token` (`"USDC"` on x402/Base, `"pathUSD"` on mpp/Tempo), `prepaid_credit_usd_micros` (was `billing.available_usd_micros`), and `held_usd_micros`. Removes the top-level `wallet_balance_usd_micros` and the `billing` block in favor of the grouped shape. `rail` stays top-level.
- **Remove the `allowance` block from `status`** — its `address` duplicated `wallet.address`, and `funded` is dropped entirely (an `on_chain_usd_micros` reading reports funding for real). The no-allowance empty-state moves from `{ allowance: null, hint }` to `{ wallet: null, hint }`.
- **Document the multi-rail story** the restructure exposes: the on-chain reader is already rail-aware, `prepaid_credit` is rail-independent, and Stripe is a funding source for prepaid credit rather than a rail. No new rail branching is introduced.
- **Align `run402 init`** to the same model: replace its `allowance: { address, funded }` with a `wallet: { local_label, server_label, address }` object and its `balance: { symbol, usd_micros }` with the same `balances` object as `status` (init fetches the organization best-effort for `prepaid_credit`/`held`), dropping `funded` and the `allowance` key. The MCP `init` tool is aligned to match if it emits the same summary.

## Capabilities

### New Capabilities
- `status-account-balances`: The `run402 status` `balances` object — its fields, the rail-aware `on_chain_token`, the rail-independence of `prepaid_credit`, and the removal of the `funded`/`allowance` redundancy and standalone `wallet_balance_usd_micros`.

### Modified Capabilities
- `wallet-named-identity`: The surfaced wallet identity fields rename from `name`/`label` to `local_label`/`server_label` in `run402 status`, the MCP `status` tool, and the SDK `whoami` result/`WhoAmI` type. The "single synced name" philosophy is unchanged — the two fields remain the same synced value, now named to convey local-selector vs server-display.
- `cli-output-shape`: `run402 status` no longer emits an `allowance` block; the no-allowance empty-state reports `wallet: null` + `hint` instead of `allowance: null`; balance data moves under a `balances` object rather than the top-level `wallet_balance_usd_micros` + `billing` pair. The `run402 init` summary shape changes from `{ …, allowance, …, balance, … }` to `{ …, wallet, …, balances, … }` for the same reasons.
- `cli-wallet-profiles`: `run402 wallets list` (and `wallets current`) descriptors rename `name`/`label` → `local_label`/`server_label` for cross-surface consistency with `status`.

## Impact

- **Code:** `cli/lib/status.mjs` (JSON shape + HELP text), `cli/lib/init.mjs` (summary shape + HELP text), `src/tools/status.ts` (MCP markdown table), `src/tools/init.ts` (MCP init summary, if structured), `sdk/src/index.ts` (`whoami` + `WhoAmI` interface), `cli/lib/wallets.mjs` (`list`/`current` descriptors). The credential provider `getWalletIdentity` and `core` `meta.json` readers are unchanged (internal names retained; mapped at the output edge).
- **Tests:** `src/tools/status.test.ts`, `src/tools/init.test.ts`, `sdk/src/whoami.test.ts`, `cli-e2e.test.mjs`, and any `wallets` list/current and `init` summary assertions.
- **Docs:** `cli/llms-cli.txt`, `documentation.md` map, and the public site `llms.txt` status references.
- **Consumers:** BREAKING for anything parsing the `run402 status` JSON, the `r.whoami()` result, or `wallets list` descriptors by the old key names. Ships behind the next lockstep version bump; no runtime gateway change required.
