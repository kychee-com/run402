## Why

Run402 today only handles payments — it has no capability for products to perform on-chain actions other than receiving x402 USDC. Products that need to *write* to the blockchain (e.g., kysigned recording signature events to a SignatureRegistry contract on Base) have no path through run402: they would have to manage their own signing keys, RPC endpoints, gas top-ups, and contract-call retry logic from scratch.

The kysigned spec (v0.3.0, F4) requires a platform wallet that calls `recordEmailSignature`, `recordWalletSignature`, and `recordCompletion` on Base mainnet for every envelope. Per kysigned § Costs: "Wallet custody / KMS key management for the platform wallet" is explicitly a run402 responsibility, not a kysigned one. Today this responsibility exists only on paper.

The same gap blocks any future run402-hosted product that needs to mint NFTs, anchor data, register identities, write to oracles, or interact with any other smart contract. Each product would otherwise have to re-solve key custody, signing, broadcasting, gas accounting, and idempotency. This feature provides a generic, custodial signing-and-call layer once.

**Security posture (non-negotiable):** Private keys MUST NEVER exist in plaintext outside AWS KMS. Signing happens inside KMS; only signed transaction bytes leave KMS. There is no "export private key" operation, ever.

## What Changes

- **KMS-backed wallets**: New service that provisions an AWS KMS key (secp256k1) per project on demand and derives an Ethereum address from the KMS public key. **Soft default of one wallet per project** — the CLI/MCP nudge users toward a single wallet, but the API has no hard cap. Projects can request additional wallets as long as they have cash to pay rent. Private keys never leave KMS.
- **Wallet rental (recurring) + sign-fee passthrough**: Wallets rent for **$0.04/day** ($1.20/month) debited daily from the project's cash balance via a new `kms_wallet_rental` ledger entry. Each contract call additionally incurs a **$0.000005 KMS sign fee** ($0.05 per 10,000 calls) recorded as a separate `kms_sign_fee` ledger line. Both line items are visible on the project's billing history — no hidden markup.
- **Creation gate (30 days prepaid)**: `POST /contracts/v1/wallets` requires the project's cash balance to be **at least $1.20 (30 days rent)** at creation time. Projects with insufficient balance get HTTP 402 and a clear error. This prevents zombie wallets that get suspended on day 1.
- **No negative balance, ever**: When a project's cash balance can't cover the next day's rent, every wallet on that project transitions to `suspended`. Suspended wallets accept reads (`GET /contracts/v1/wallets/:id`, status lookups) but reject `POST /contracts/v1/call` with HTTP 402. Reactivation is automatic on top-up — no support ticket, no admin action.
- **90-day suspension grace, then delete (with funds rescue)**: A wallet that stays `suspended` for 90 consecutive days has its KMS key **scheduled for deletion** (AWS KMS minimum deletion window: 7 days; we use the minimum). The wallet row remains for audit purposes (it's referenced by historical `contract_calls`), marked `deleted_at`, and `kms_key_id` cleared. **Funds rescue:** if the wallet has on-chain native-token balance and a `recovery_address` is set, the gateway auto-drains the balance to that address before scheduling deletion. If balance is non-trivial AND no recovery address is set, the gateway sends warning emails on days 60, 75, and 88 of suspension, then deletes anyway on day 90 — funds at the on-chain address become permanently inaccessible (the address still exists, but no key exists to sign for it). **Users keep their funds by paying rent, draining the wallet, or setting a recovery address — there is no free archive tier.**
- **Drain endpoint (the safety valve)**: New endpoint `POST /contracts/v1/wallets/:id/drain` builds a single transaction sending the entire native-token balance to a destination address, signs via KMS, and broadcasts. **Works on both `active` and `suspended` wallets** — this is intentional, so a project that runs out of cash credit can still recover its on-chain funds without first having to top up. The wallet pays its own gas from its own ETH balance, so the drain doesn't depend on the project's USD cash balance. Requires `X-Confirm-Drain: <wallet_id>` header to prevent accidental drains.
- **Recovery address (optional auto-drain target)**: Wallets can be created with an optional `recovery_address`, or have one set/updated later via `POST /contracts/v1/wallets/:id/recovery-address`. When set, the 90-day deletion job auto-drains to this address before deletion. When unset, the deletion job sends increasingly urgent warning emails (days 60, 75, 88) but still deletes on day 90.
- **Generic contract-call API**: New endpoint `POST /contracts/v1/call` accepts `{ chain, wallet_id, contract_address, abi_fragment, function_name, args, value? }`, builds the transaction, signs via KMS, broadcasts to the chain's RPC, and returns a tx hash. The caller supplies the ABI fragment per-call — no global contract registry, no ABI storage.
- **Call status / receipts**: New endpoint `GET /contracts/v1/calls/:id` returns `pending | confirmed | failed`, block number, gas used, and the receipt. Status is also written to a `contract_calls` table for audit and replay.
- **Idempotency**: `POST /contracts/v1/call` accepts an optional `Idempotency-Key` header. Same key → same call (returns the existing call record, never re-broadcasts).
- **Read-only contract calls**: New endpoint `POST /contracts/v1/read` for `view`/`pure` functions. No signing, no gas, no KMS — just RPC call. Included for symmetry so projects don't need to run their own RPC client.
- **Mainnet support**: Base mainnet is the first supported chain (per kysigned). Architecture supports adding chains via configuration: each chain has `{ chain_id, rpc_url, native_token, block_explorer }`. Initial chain set: `base-mainnet`. Adding `ethereum-mainnet`, `optimism-mainnet`, etc., is configuration only — no code change.
- **Gas accounting**: Gas is paid in the chain's native token (ETH on Base) from the project's KMS wallet (the wallet itself holds ETH; users top it up by sending ETH to the wallet's address). Each confirmed or failed `POST /contracts/v1/call` records the gas cost in USD-micros (using a Chainlink ETH/USD price feed read via `POST /contracts/v1/read`) against the project's billing account as a `contract_call_gas` ledger entry. **Gas is at-cost — run402 takes no markup on chain gas.** The KMS sign fee (separate ledger entry, see above) is the only run402 markup on contract calls.
- **Wallet funding**: `GET /contracts/v1/wallets/:id` returns the address + native token balance. Funding the wallet (sending ETH to the address) is the project owner's responsibility; the gateway only reads and reports balance. No deposit endpoint.
- **Low-balance alerts**: When a wallet's native token balance falls below a configurable threshold, send a notification email to the project's billing account email (uses Feature #3 plumbing). Threshold default: enough for ~100 transactions at recent gas prices.
- **MCP/CLI/OpenClaw**: New MCP tools `provision_contract_wallet`, `get_contract_wallet`, `list_contract_wallets`, `contract_call`, `contract_read`, `get_contract_call_status`, `set_low_balance_alert`, `set_recovery_address`, `drain_contract_wallet`, `delete_contract_wallet`. Matching CLI subcommands `run402 contracts ...`. Matching OpenClaw shims.
- **Docs**: `site/llms.txt`, `site/llms-cli.txt`, `site/openapi.json`, `AGENTS.md` MCP tool table.
- **BREAKING**: None. This is a net-new capability; no existing endpoints, schemas, or behaviors change.

## Non-goals

- **Custodial signing of arbitrary messages**: This feature signs *transactions* (contract calls). It does NOT expose `personal_sign` or `eth_signTypedData`. Message signing for end users is outside scope — products that need it should use the user's own wallet (kysigned Method B pattern).
- **Private-key export**: No endpoint, no admin override, no escape hatch. Once a KMS wallet is created its key material lives and dies inside KMS. If a project needs to migrate keys, they must drain the wallet on-chain and provision a new one.
- **Multi-sig / threshold signing**: Single-signer KMS wallets only in MVP. No safe.global integration, no MPC, no co-signer.
- **Gas markup**: Gas itself stays at-cost — run402 takes no margin on chain gas. The only run402 markup on contract calls is the per-sign KMS fee ($0.000005/call), which is recorded as a separate ledger line so users can see exactly what they're paying for.
- **Free archive of suspended wallets**: There is no free tier and no permanent archive. A wallet that stays suspended for 90 days is deleted (KMS key destroyed). The relationship is non-custodial: the user keeps their wallet alive by paying rent, just like an EC2 instance — if they stop paying, the infrastructure terminates and the data (here, the on-chain funds) becomes inaccessible. AWS bills us $1/key/month forever for any KMS key, so an "archive but don't bill" model would have run402 paying for abandoned wallets indefinitely.
- **Custodial responsibility / escrow / fiduciary duty for user funds**: run402 provides KMS-backed signing infrastructure, not custody. On-chain funds at a KMS wallet address are the project owner's responsibility, not run402's. This is non-negotiable and is enforced through (a) explicit terms of service language, (b) billing page disclosures, (c) warning email language, (d) a `non_custodial_notice` field in every wallet-creating API response and every suspension-related 402 error, and (e) the new "Non-custodial relationship" spec requirement. The drain endpoint and recovery address are optional safety nets, not obligations.
- **Negative cash balance**: A project's billing account never goes negative. Daily rent debit fails → wallet suspends. No grace credit, no debt collection, no surprise bill on top-up.
- **Automatic wallet top-up**: The gateway will not auto-top-up the wallet's native-token (ETH) balance. Funding ETH is manual by the project owner. Low-balance notifications are the only safety net.
- **Cross-chain bridging / swaps**: No built-in DEX or bridge integration. If a wallet needs ETH on Base, the owner sends ETH on Base.
- **Contract deployment**: `POST /contracts/v1/call` invokes existing contracts. No `deployContract` endpoint in this MVP.
- **ABI registry / contract aliases**: Callers supply the ABI fragment per call. No central ABI store, no human-friendly contract names. Keeps the surface tiny and unopinionated.
- **L1 Ethereum mainnet at launch**: Architecture supports it but the initial supported chain set is Base mainnet only. ETH mainnet, Optimism, Arbitrum, etc., are configuration-only follow-ups, not part of this proposal.
- **Eventual consistency / mempool monitoring**: We submit, we poll the receipt, we report status. We do NOT re-broadcast stuck transactions or replace-by-fee. The first version intentionally has no nonce-management heroics — submit, wait, surface failure honestly.

## Capabilities

### New Capabilities

- `kms-wallet`: Provision and inspect AWS KMS-backed Ethereum wallets per project. Each wallet has a project-scoped ID, an Ethereum address derived from the KMS public key, a current native-token balance read live from RPC, and a `status` of `active | suspended | deleted`. Soft default of one wallet per project (CLI/MCP nudge); the API has no hard cap. Private keys never leave KMS.
- `kms-wallet-rental`: Daily debit of $0.04 from the project's cash balance per active wallet, recorded as `kms_wallet_rental` ledger entries. Wallet creation requires 30 days' rent ($1.20) prepaid in cash balance. When a project can't cover the next day's rent, all its wallets transition to `suspended` automatically. Reactivation on top-up is automatic. After 90 days suspended, the KMS key is scheduled for deletion (7-day AWS deletion window) and the wallet is permanently `deleted`.
- `contract-call`: Submit a write call to an existing contract from a KMS wallet. Caller supplies chain, wallet ID, contract address, ABI fragment, function name, and args. Server signs via KMS, broadcasts, records the call, and returns a call ID + tx hash. Idempotent on `Idempotency-Key`. Each confirmed/failed call records two ledger entries: `contract_call_gas` (at-cost ETH gas in USD-micros) and `kms_sign_fee` ($0.000005 = 5 USD-micros, the only run402 markup).
- `contract-read`: Submit a read-only call to an existing contract. No signing, no gas, no billing. Just an RPC convenience so projects don't ship their own RPC client.
- `contract-call-status`: Look up a previously submitted call by call ID. Returns lifecycle state (pending/confirmed/failed), block number, gas used in native token + USD-micros, receipt, and any error message.
- `chain-config`: A static, in-config registry of supported chains. Initial entries: `base-mainnet`. Adding chains is a config + redeploy only — no code change.
- `wallet-balance-alerts`: Per-wallet low-balance notification threshold; when balance crosses it, send an email to the project's billing account contact.

### Modified Capabilities

- `billing-ledger`: Three new ledger entry kinds: `contract_call_gas` (per call, at-cost ETH gas in USD-micros), `kms_sign_fee` (per call, flat 5 USD-micros markup), and `kms_wallet_rental` (per wallet per day, flat 40,000 USD-micros = $0.04). All three are negative amounts. Existing ledger schema accommodates them without migration beyond adding the new kinds to the allowed enum.
- `email-send`: Reused as transport for low-balance alerts. No code change to the email service itself; this is a new caller.

## Shipping Surfaces

| Name | Type | Reach | Smoke check |
|------|------|-------|-------------|
| Gateway HTTP API | service | `https://api.run402.com` | `curl -fsSL -o /dev/null -w "%{http_code}\n" https://api.run402.com/contracts/v1/wallets` returns `401` (auth required, route exists) — and after publish, a real authorized call to `GET /contracts/v1/wallets` returns `200` with the new shape including a `chain` field |
| run402-mcp (MCP server) | npm | `npx run402-mcp` | `cd $(mktemp -d) && npx -y run402-mcp@latest --list-tools 2>&1 \| grep -F contract_call` exits 0 — proves the new MCP tool is published |
| run402 CLI | npm | `npm install -g run402` | `cd $(mktemp -d) && npm install -g run402@latest && run402 contracts --help \| grep -F provision-wallet` exits 0 — proves the new CLI subcommand is published |
| Docs site (`llms.txt`, `llms-cli.txt`, `llms-full.txt`, `openapi.json`) | url | `https://run402.com/llms.txt` | `curl -fsSL https://run402.com/llms.txt \| grep -F /contracts/v1/call` exits 0 AND `curl -fsSL https://run402.com/llms.txt \| grep -F '$0.04/day'` exits 0 — proves both endpoint AND pricing reached docs |
| Marketing site billing page | url | `https://run402.com/billing/` | `curl -fsSL https://run402.com/billing/ \| grep -F '$0.04/day'` exits 0 AND `grep -F 'KMS contract wallet'` exits 0 — proves the pricing page lists the new fees |
| Marketing site changelog | url | `https://run402.com/humans/changelog.html` | `curl -fsSL https://run402.com/humans/changelog.html \| grep -F 'KMS contract wallet'` exits 0 — proves the change is publicly announced with pricing |
| Marketing site updates feed | url | `https://run402.com/updates.txt` | `curl -fsSL https://run402.com/updates.txt \| grep -F 'KMS contract wallet'` exits 0 |

All four surfaces are external. None are internal-only. The feature is **not** shipped until every smoke check passes, regardless of CI status or merge state. See `/implement` Step 8 acceptance walk for how these are verified.

## Impact

- **Gateway** (`packages/gateway/src/`):
  - New `services/kms-wallet.ts` — KMS key creation, public-key fetch, secp256k1 signing wrapper, address derivation.
  - New `services/contract-call.ts` — transaction building (viem), KMS signing, broadcast, receipt polling.
  - New `services/chain-config.ts` — static chain registry.
  - New `routes/contracts.ts` — `POST /contracts/v1/call`, `POST /contracts/v1/read`, `GET /contracts/v1/calls/:id`, `GET /contracts/v1/wallets`, `POST /contracts/v1/wallets`, `GET /contracts/v1/wallets/:id`.
  - Modified `services/billing.ts` — new `contract_call_gas` ledger kind in the allowed enum.
- **Database**: New tables `internal.contract_wallets` (project_id, kms_key_id, chain, address, status `active|suspended|deleted`, recovery_address `nullable`, low_balance_threshold_wei, last_alert_sent_at, last_rent_debited_on `DATE`, suspended_at, deleted_at, last_warning_day `int nullable`, created_at) and `internal.contract_calls` (id, wallet_id, project_id, chain, contract_address, function_name, args_json, idempotency_key, tx_hash, status, gas_used_wei, gas_cost_usd_micros, receipt_json, error, created_at, updated_at). Unique index on `(project_id, idempotency_key)` where idempotency_key is not null. Index on `contract_wallets.status` and `contract_wallets.suspended_at` for the daily-rent and suspension-grace jobs. Migration in `server.ts` v1.20 block.
- **AWS / IAM**: Gateway IAM role gains `kms:CreateKey`, `kms:GetPublicKey`, `kms:Sign`, `kms:DescribeKey`, `kms:TagResource`, `kms:ListResourceTags`, `kms:ScheduleKeyDeletion`, `kms:CancelKeyDeletion`. Notably the role does NOT get `kms:Decrypt` or `kms:GetParametersForImport` — these would defeat the no-export guarantee. Each wallet is a tagged KMS key (`run402:project_id`, `run402:wallet_id`). KMS key spec: `ECC_SECG_P256K1`, key usage `SIGN_VERIFY`. Deletion uses the AWS minimum 7-day window. CDK update in `infra/lib/pod-stack.ts`.
- **Secrets**: New secret `run402/base-mainnet-rpc-url` (RPC endpoint for Base; can be Alchemy/Infura/Base public RPC). New secret `run402/eth-price-oracle-url` (or use chainlink price feed read directly via the same contract layer — TBD in design).
- **Tests**: Unit tests for KMS signing wrapper (with mocked KMS client), contract-call building, idempotency, status polling. E2E test against Base mainnet using a funded test wallet (or, preferably, against `base-sepolia` to avoid spending real ETH; design.md will resolve which).
- **Docs**: `site/llms.txt`, `site/llms-cli.txt`, `site/openapi.json` updated. `AGENTS.md` MCP tool table appended. New section in `CLAUDE.md` covering KMS deployment + RPC secret rotation.
- **MCP/CLI**: New MCP tool definitions in `run402-mcp` (separate repo). New CLI module `cli/lib/contracts.mjs` with subcommands. OpenClaw shims for each tool. `sync.test.ts` updated.
- **Cost & margin model**: AWS KMS at-cost is $1/key/month flat + $0.03 per 10,000 sign operations. run402 charges:
  - **$0.04/day rental** ($1.20/month) per active wallet → ~20% margin over the AWS flat fee at zero-sign volume, lower margin at high-sign volume but covered by the per-sign markup below.
  - **$0.000005 per contract call** (= $0.05 per 10,000 calls) → ~67% markup over AWS sign cost ($0.03 → $0.05).
  - **Worked example (kysigned-target, 1000 envelopes/day = ~90k signs/month):**
    - Income: $1.20 rental + $0.45 sign fees = **$1.65/month**
    - AWS cost: $1.00 flat + $0.27 signs = **$1.27/month**
    - **Net: +$0.38/month (~30% margin)**
  - **Worked example (heavy product, ~900k signs/month):** Income $1.20 + $4.50 = $5.70; AWS cost $1.00 + $2.70 = $3.70; net +$2.00 (~54% margin)
  - **Worked example (idle wallet, 0 signs/month):** Income $1.20; AWS cost $1.00; net +$0.20 (17% margin)
  - This is the only feature in run402 with explicit margin in MVP — gas, AI helpers, email send, and storage all stay at-cost. KMS gets margin because AWS bills us a flat $1/wallet/month whether the wallet is used or not, so an idle/abandoned wallet is a real loss center; the margin protects against that.
