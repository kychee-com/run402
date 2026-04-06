## 1. Schema migrations

- [ ] 1.1 Add startup migration block v1.20 to `server.ts` [code]
- [ ] 1.2 `CREATE TABLE internal.contract_wallets` (id, project_id, kms_key_id nullable, chain, address, status enum-as-text default 'active', recovery_address nullable, low_balance_threshold_wei NUMERIC default 1000000000000000, last_alert_sent_at, last_rent_debited_on DATE nullable, suspended_at nullable, deleted_at nullable, last_warning_day INT nullable, created_at) [code]
- [ ] 1.3 Indexes on contract_wallets: `(project_id)`, `(status)`, `(status, suspended_at)` [code]
- [ ] 1.4 `CREATE TABLE internal.contract_calls` (id, wallet_id, project_id, chain, contract_address, function_name, args_json, idempotency_key nullable, tx_hash nullable, status enum-as-text, gas_used_wei NUMERIC nullable, gas_cost_usd_micros INT nullable, receipt_json nullable, error nullable, created_at, updated_at) [code]
- [ ] 1.5 Unique partial index `(project_id, idempotency_key) WHERE idempotency_key IS NOT NULL` on contract_calls [code]
- [ ] 1.6 Index `(status, created_at)` on contract_calls for the reconciler [code]
- [ ] 1.7 Extend the ledger kind allowlist (in code, wherever it's enforced) to include `kms_wallet_rental`, `kms_sign_fee`, `contract_call_gas` [code]
- [ ] 1.8 Migration smoke test: server boots fresh against an empty DB, all tables exist, all indexes present [code]

## 2. Chain registry + RPC secrets

- [ ] 2.1 Create `packages/gateway/src/services/chain-config.ts` with frozen const for `base-mainnet` and `base-sepolia` (chain_id, name, rpc_url_secret_key, native_token, block_explorer, chainlink_eth_usd_feed_address) [code]
- [ ] 2.2 `getChain(name)` and `listChains()` helpers + unit tests for unknown chain → throw, valid chain → frozen object [code]
- [ ] 2.3 Boot guard: gateway startup loads RPC URLs for every registered chain from Secrets Manager; missing secret → fail-fast with named error [code]
- [ ] 2.4 Boot guard: gateway startup checks no `contract_wallets` row references a chain not in the registry → fail-fast naming the orphaned chain [code]
- [ ] 2.5 Create AWS secrets `run402/base-mainnet-rpc-url` (Base public RPC for now: `https://mainnet.base.org`) and `run402/base-sepolia-rpc-url` (`https://sepolia.base.org`) [infra]
- [ ] 2.6 Verify secrets exist via AWS CLI [infra]

## 3. KMS service — key management + signing wrapper

- [ ] 3.1 Create `packages/gateway/src/services/kms-wallet.ts` [code]
- [ ] 3.2 `createKmsKey(projectId, walletId)` — calls `kms:CreateKey` with spec ECC_SECG_P256K1, usage SIGN_VERIFY, tags `run402:project_id`, `run402:wallet_id`. Returns `{ kms_key_id, public_key_der }` [code]
  - TDD: Write failing test for happy path with mocked KMS client
  - TDD: Write failing test for AWS failure → throws with cause preserved
  - Implement
- [ ] 3.3 `derivedAddressFromPublicKey(public_key_der)` — parse DER, extract uncompressed 65-byte point, drop leading 0x04, keccak256 last 20 bytes, return checksummed 0x address. Use viem's `keccak256` and `getAddress`. [code]
  - TDD: Write failing test with a known public key → known address (use a fixture from Ethereum test vectors)
  - TDD: Write failing test for malformed DER → throws
  - Implement
- [ ] 3.4 `signDigest(kms_key_id, digest_32_bytes)` — calls `kms:Sign` with MessageType=DIGEST, SigningAlgorithm=ECDSA_SHA_256. Parses the DER signature into `(r, s)`, computes recovery id `v` by trying both candidates and comparing recovered address to the wallet's known address (cached on the wallet record). Returns `{ r, s, v }` ready for viem. [code]
  - TDD: Write failing test with a fixture KMS response → expected (r,s,v) for a known private key in a test KMS environment
  - TDD: Write failing test for malformed signature
  - TDD: Write failing test for KMS access denied → throws with clear error
  - Implement (use a `MockKmsClient` test helper that signs with a hardcoded test key for deterministic results)
- [ ] 3.5 `scheduleKeyDeletion(kms_key_id)` — calls `kms:ScheduleKeyDeletion` with `PendingWindowInDays=7`. Returns deletion completion date. [code]
  - TDD: Write failing test for happy path
  - TDD: Write failing test for already-scheduled key (idempotent)
  - Implement
- [ ] 3.6 `cancelKeyDeletion(kms_key_id)` — for support recovery. Calls `kms:CancelKeyDeletion`. [code]
- [ ] 3.7 IAM smoke test: from a deployed task, attempt each KMS operation against a test key tagged `run402:test:true` and confirm success. Decrypt should NOT be in the role — verify by attempting and expecting AccessDenied. [infra]

## 4. CDK — IAM permissions + RPC secrets in task def

- [ ] 4.1 Update `infra/lib/pod-stack.ts` — add KMS permissions to the gateway task role: CreateKey, GetPublicKey, Sign, DescribeKey, TagResource, ListResourceTags, ScheduleKeyDeletion, CancelKeyDeletion [infra]
- [ ] 4.2 Verify Decrypt and GetParametersForImport are NOT in the role [infra]
- [ ] 4.3 Add the two RPC URL secrets to the task definition env (BASE_MAINNET_RPC_URL, BASE_SEPOLIA_RPC_URL via Secrets Manager) [infra]
- [ ] 4.4 Deploy CDK update to the AgentDB-Pod01 stack [infra]
- [ ] 4.5 Verify deployed task has the new env vars and IAM perms via AWS CLI [infra]

## 5. Service — wallet provisioning

- [ ] 5.1 Create `packages/gateway/src/services/contract-wallets.ts` [code]
- [ ] 5.2 `provisionWallet(projectId, chain, recoveryAddress?)` — calls `kms-wallet.createKmsKey`, derives address via `derivedAddressFromPublicKey`, inserts row into `contract_wallets` with status='active' and `last_rent_debited_on=today`, debits first day's rent in the same transaction (40000 USD-micros + `kms_wallet_rental` ledger entry). Returns the new wallet row. [code]
  - TDD: Write failing test for happy path with mocked KMS + real-ish DB
  - TDD: Write failing test for unsupported chain → throws
  - TDD: Write failing test for self-referential recovery address → throws
  - TDD: Write failing test for KMS failure → DB rollback, no half-state
  - Implement
- [ ] 5.3 `getWallet(walletId, projectId)` — returns wallet row or 404 if wrong project (no info leak — same response for "doesn't exist" and "wrong project") [code]
- [ ] 5.4 `listWallets(projectId)` — returns all wallets owned by project, including `deleted` ones [code]
- [ ] 5.5 `setRecoveryAddress(walletId, projectId, recoveryAddress)` — UPDATE; refuses if status='deleted' or if address equals wallet's own address [code]
- [ ] 5.6 `setLowBalanceThreshold(walletId, projectId, thresholdWei)` — UPDATE [code]

## 6. Service — wallet rental + suspension job

- [ ] 6.1 Create `packages/gateway/src/services/wallet-rental.ts` [code]
- [ ] 6.2 `debitDailyRent()` — main job entry point. Iterates active wallets where `last_rent_debited_on < today_utc`, atomically debits or suspends per DD-4. Idempotent. [code]
  - TDD: Write failing test for happy path debit
  - TDD: Write failing test for idempotent re-run (no double debit)
  - TDD: Write failing test for insufficient balance → all project wallets suspend
  - TDD: Write failing test for cash never goes negative
  - TDD: Write failing test for partial-day catch-up after gateway downtime
  - Implement
- [ ] 6.3 `reactivateProject(projectId)` — called from billing top-up handler when balance crosses 40000. Transitions all of project's `suspended` wallets back to `active`, clears `suspended_at`, debits one day's rent immediately for the current day. Idempotent. [code]
  - TDD: Write failing test for happy path
  - TDD: Write failing test for no-op when no suspended wallets exist
  - Implement
- [ ] 6.4 Wire `reactivateProject` into the existing top-up code path (whichever service finalizes a successful Stripe webhook or x402 receive) [code]

## 7. Service — 90-day deletion + funds rescue

- [ ] 7.1 Create `packages/gateway/src/services/wallet-deletion.ts` [code]
- [ ] 7.2 `processSuspensionGrace()` — main job entry. For each suspended wallet, computes days since `suspended_at` and dispatches: warnings (60/75/88), then deletion (90+). [code]
  - TDD: Write failing test for day-90 dust path → schedule deletion, set deleted_at, clear kms_key_id
  - TDD: Write failing test for day-90 with balance + recovery_address → drain submitted, status NOT yet deleted (waits for drain confirmation)
  - TDD: Write failing test for drain confirmation in next tick → schedule deletion
  - TDD: Write failing test for day-90 with balance + no recovery_address → schedule deletion immediately, fund-loss email sent
  - TDD: Write failing test for day-60/75/88 warnings (one per day, no duplicates)
  - TDD: Write failing test for reactivation between day 60 and 90 → warnings cleared, no deletion
  - Implement
- [ ] 7.3 Warning email body — include wallet address, current balance ETH + USD, suspended_at, deletion date, recovery options, link to docs [code]
- [ ] 7.4 Final fund-loss email body — include wallet address, balance lost, "no recovery address was set" explanation, link to support [code]

## 8. Service — contract call (signing + broadcast)

- [ ] 8.1 Create `packages/gateway/src/services/contract-call.ts` [code]
- [ ] 8.2 `submitContractCall({ projectId, walletId, chain, contractAddress, abiFragment, functionName, args, value?, idempotencyKey? })` — validates wallet ownership + status, parses ABI, builds transaction with viem, fetches nonce + gas estimates, builds unsigned tx hash, signs via `kms-wallet.signDigest`, serializes signed tx, broadcasts via RPC, inserts `contract_calls` row with status='pending'. Returns `{ call_id, tx_hash }`. [code]
  - TDD: Write failing test for happy path with mocked KMS + mocked RPC
  - TDD: Write failing test for ABI parse failure → 400
  - TDD: Write failing test for function not in ABI → 400
  - TDD: Write failing test for insufficient native balance → 402, no broadcast
  - TDD: Write failing test for suspended wallet → 402, no broadcast
  - TDD: Write failing test for idempotency (same key returns same call_id, no second broadcast)
  - TDD: Write failing test for cross-project idempotency key collision (independent calls)
  - TDD: Write failing test for RPC submit failure → status='failed', no gas charge
  - TDD: Write failing test for deleted wallet → 410
  - Implement
- [ ] 8.3 `submitDrainCall({ projectId, walletId, destinationAddress })` — special-case helper that builds a value-transfer tx (zero data, value=balance−gas), reuses the same KMS sign + broadcast path. Records as a contract_call row with `function_name='<drain>'`. Bypasses the cash-balance suspension check. [code]
  - TDD: Write failing test for active wallet drain
  - TDD: Write failing test for suspended wallet drain (the safety valve)
  - TDD: Write failing test for nothing-to-drain → 409
  - TDD: Write failing test for invalid destination → 400
  - TDD: Write failing test for deleted wallet → 410
  - Implement

## 9. Service — contract call status reconciliation

- [ ] 9.1 Create `packages/gateway/src/services/contract-call-reconciler.ts` [code]
- [ ] 9.2 `reconcilePendingCalls()` — main job entry. Polls each pending call's tx_hash via RPC `eth_getTransactionReceipt`. On receipt: compute gas cost in USD-micros via cached ETH/USD price, write two ledger entries (`contract_call_gas` + `kms_sign_fee`), update call to confirmed/failed, all in one transaction. [code]
  - TDD: Write failing test for confirmed call → both ledger entries written
  - TDD: Write failing test for failed (reverted) call → both ledger entries STILL written (failed reverts consume gas)
  - TDD: Write failing test for pending call (no receipt yet) → no change
  - TDD: Write failing test for receipt fetch error → no change, retry next tick
  - TDD: Write failing test for already-reconciled call → idempotent skip
  - Implement
- [ ] 9.3 `getCachedEthUsdPrice(chain)` — reads Chainlink price feed via the contract-read service (DD-11), caches result for 5 minutes per chain. Falls back to a hardcoded $2000 if Chainlink read fails (logged loudly). [code]
  - TDD: Write failing test for fresh fetch → calls Chainlink, returns price
  - TDD: Write failing test for cache hit → no Chainlink call
  - TDD: Write failing test for Chainlink failure → fallback price
  - Implement

## 10. Service — contract read (no signing)

- [ ] 10.1 Create `packages/gateway/src/services/contract-read.ts` [code]
- [ ] 10.2 `readContract({ chain, contractAddress, abiFragment, functionName, args })` — uses viem's `readContract` against the chain RPC. No signing, no DB writes, no billing. Returns the decoded result. [code]
  - TDD: Write failing test for happy path
  - TDD: Write failing test for unsupported chain → 400
  - TDD: Write failing test for invalid ABI → 400
  - TDD: Write failing test for RPC failure → 502
  - Implement

## 11. Service — low-balance alerts

- [ ] 11.1 Create `packages/gateway/src/services/wallet-balance-alerts.ts` [code]
- [ ] 11.2 `checkLowBalances()` — runs every 10 minutes. For each active wallet, fetches current native balance via RPC; if `< low_balance_threshold_wei` AND `last_alert_sent_at < NOW() - 24 hours` AND project has a verified billing email, sends a low-balance alert and updates `last_alert_sent_at`. [code]
  - TDD: Write failing test for under-threshold + cooldown ok → email sent
  - TDD: Write failing test for under-threshold + recent alert → no email
  - TDD: Write failing test for over-threshold → no email
  - TDD: Write failing test for no billing email → no email (silent)
  - Implement
- [ ] 11.3 Alert email body — wallet address, current balance, threshold, link to top-up instructions [code]

## 12. Routes — `/contracts/v1/...`

- [ ] 12.1 Create `packages/gateway/src/routes/contracts.ts` [code]
- [ ] 12.2 `POST /contracts/v1/wallets` — body validation, 30-day prepay check, calls `provisionWallet` [code]
  - TDD: Write failing test for happy path (with seeded billing balance)
  - TDD: Write failing test for insufficient balance → 402
  - TDD: Write failing test for unsupported chain → 400
  - TDD: Write failing test for invalid recovery_address → 400
  - Implement
- [ ] 12.3 `GET /contracts/v1/wallets/:id` and `GET /contracts/v1/wallets` — calls `getWallet` and `listWallets`. Wrong-project returns 404 [code]
- [ ] 12.4 `POST /contracts/v1/wallets/:id/recovery-address` — sets/clears recovery address [code]
- [ ] 12.5 `POST /contracts/v1/wallets/:id/alert` — sets low-balance threshold [code]
- [ ] 12.6 `POST /contracts/v1/wallets/:id/drain` — body `{ destination_address }`, header `X-Confirm-Drain: <wallet_id>`, calls `submitDrainCall` [code]
  - TDD: Write failing test for missing/wrong confirmation header → 400
  - TDD: Write failing test for happy path
  - TDD: Write failing test for suspended wallet → still works (safety valve)
  - Implement
- [ ] 12.7 `DELETE /contracts/v1/wallets/:id` — header `X-Confirm-Delete: <wallet_id>`, refuses if balance > dust → 409 [code]
- [ ] 12.8 `POST /contracts/v1/call` — body validation, idempotency-key extraction, calls `submitContractCall`. Returns 202. [code]
- [ ] 12.9 `POST /contracts/v1/read` — calls `readContract`, returns 200 [code]
- [ ] 12.10 `GET /contracts/v1/calls/:id` — wrong-project returns 404 [code]

## 13. Background job scheduler wiring

- [ ] 13.1 Wire `reconcilePendingCalls` into the existing run402 background-task scheduler at 30s interval [code]
- [ ] 13.2 Wire `debitDailyRent` to run on every reconciler tick (idempotent guard ensures it actually runs once per day) [code]
- [ ] 13.3 Wire `processSuspensionGrace` to run on every reconciler tick [code]
- [ ] 13.4 Wire `checkLowBalances` to run every 10 minutes (less frequent than the main reconciler) [code]
- [ ] 13.5 Boot-time invocation: run all jobs once at startup so a long downtime window doesn't skip work [code]

## 14. Backward-compatibility test sweep

- [ ] 14.1 `npm run test:unit` — full gateway unit suite passes with zero regressions [code]
- [ ] 14.2 `npm run test:e2e` — full lifecycle test passes against a local server [code]
- [ ] 14.3 `npm run test:bld402-compat` passes [code]
- [ ] 14.4 `npm run test:billing` passes [code]
- [ ] 14.5 `npm run test:email` passes [code]
- [ ] 14.6 `npm run test:functions` passes [code]
- [ ] 14.7 `npm run test:openclaw` passes [code]
- [ ] 14.8 `npx tsc --noEmit -p packages/gateway` clean [code]
- [ ] 14.9 `npm run lint` clean [code]

## 15. E2E test — new contract feature

- [ ] 15.1 Create `test/contracts-e2e.ts` — covers: provision wallet (with prepay), get wallet, list wallets, set recovery address, set low-balance threshold, submit a real contract call (against a deployed test contract on base-sepolia), poll status to confirmed, verify ledger entries (gas + sign fee), drain wallet, delete wallet [code]
- [ ] 15.2 Deploy a minimal test contract on base-sepolia for E2E (an `EmitsEvent` contract with one no-op write function) — record address in test fixtures [infra]
- [ ] 15.3 Add `npm run test:contracts` script [code]
- [ ] 15.4 Test runs against local server with BASE_URL=http://localhost:4022, uses base-sepolia for the on-chain side [code]

## 16. Docs — gateway-side surfaces

- [ ] 16.1 `site/llms.txt` — new section "## Contract Wallets" listing all `/contracts/v1/...` endpoints + pricing ($0.04/day rental, $0.000005/sign), funds-rescue mechanisms, suspension model [manual]
- [ ] 16.2 `site/llms-cli.txt` — new `## run402 contracts` section with all CLI subcommands, pricing inline on cost-incurring commands [manual]
- [ ] 16.3 `site/llms-full.txt` — long-form documentation with full pricing model, lifecycle diagram, security posture [manual]
- [ ] 16.4 `site/openapi.json` — add 9 new path entries with request/response schemas; pricing in description fields for `POST /contracts/v1/wallets` and `POST /contracts/v1/call` [manual]
- [ ] 16.5 `site/billing/index.html` — add KMS rental + sign fee section with: $0.04/day per wallet, $1.20 prepay, suspension model, 90-day deletion, drain endpoint, recovery address [manual]
- [ ] 16.6 `site/index.html` (landing) — if pricing or features are listed, add KMS wallet line + link to billing page [manual]
- [ ] 16.7 `site/humans/terms.html`, `humans/faq.html`, `humans/index.html` — update fee enumerations to include KMS rental + sign fee [manual]
- [ ] 16.8 `site/updates.txt` — new entry: "KMS contract wallets — $0.04/day rental + $0.000005/sign, drain endpoint, 90-day deletion lifecycle. /contracts/v1/* endpoints now live." [manual]
- [ ] 16.9 `site/humans/changelog.html` — matching changelog entry [manual]
- [ ] 16.10 `AGENTS.md` tool table — append new MCP tools with pricing notes in description column [manual]
- [ ] 16.11 `docs/products/kysigned/kysigned-spec.md` line 94 — update Costs section to cite actual pricing [manual]
- [ ] 16.12 `CLAUDE.md` — add new section "## KMS contract wallets" with deployment notes (RPC secret rotation, IAM verification) [manual]
- [ ] 16.13 **Pricing grep audit** — `grep -rn '\$0\.10\|\$5\.00\|\$5\b\|\$20\|email pack\|prototype\|hobby\|team' site/ docs/ AGENTS.md README.md` and verify every match either references the new KMS pricing or is irrelevant. Document the audit result in the implementation log. [manual]
- [ ] 16.14 `site/humans/terms.html` — add new section "KMS contract wallets are non-custodial" explicitly disclaiming fund custody, fiduciary duty, and recovery obligation. Cover all five points from the "Terms of service explicit disclaimer" spec scenario. [manual]
- [ ] 16.15 `site/billing/index.html` — add a "Non-custodial: you are responsible for your funds" notice to the KMS wallet section, with a link to the new terms section [manual]
- [ ] 16.16 **Custody-language audit** — `grep -rn -i 'safekeep\|custody\|escrow\|safe with us\|your funds are secure\|we hold\|we protect' site/ docs/ README.md` and verify every match is either removed, rephrased to non-custodial language, or scoped to something genuinely under run402 control (USD cash credit, KMS keys themselves). Document audit result in implementation log. [manual]

## 17. MCP / CLI / OpenClaw (run402-mcp repo)

- [ ] 17.1 Create 10 new MCP tools: `provision_contract_wallet`, `get_contract_wallet`, `list_contract_wallets`, `set_recovery_address`, `set_low_balance_alert`, `contract_call`, `contract_read`, `get_contract_call_status`, `drain_contract_wallet`, `delete_contract_wallet` [code]
- [ ] 17.2 Create `run402 contracts` CLI module `cli/lib/contracts.mjs` with subcommands: `provision-wallet`, `get-wallet`, `list-wallets`, `set-recovery`, `set-alert`, `call`, `read`, `status`, `drain`, `delete` [code]
- [ ] 17.3 CLI nudge: `provision-wallet` prompts confirmation if project already has ≥1 active wallet [code]
- [ ] 17.4 CLI pricing notes: every cost-incurring subcommand mentions the cost in `--help` output [code]
- [ ] 17.5 Create OpenClaw shims for each MCP tool [code]
- [ ] 17.6 Update `sync.test.ts` SURFACE — verify all tools are present in MCP, CLI, and OpenClaw [code]
- [ ] 17.7 Update `SKILL.md` and `README.md` tool table [manual]

## 18. Ship & Verify

> Per the upgraded skill framework, every shipping surface in the spec gets a `[ship]` task here. A task is not done until its smoke check passes from a fresh-user context (clean dir, outside the repo) against the published artifact.

- [ ] 18.1 **Ship Gateway HTTP API** — push gateway code to main; CI deploys via `.github/workflows/deploy-gateway.yml`. Smoke check: `curl -fsSL -o /dev/null -w "%{http_code}\n" https://api.run402.com/contracts/v1/wallets` returns `401` (route exists, auth required); then with a real API key `curl ... -H "Authorization: Bearer ..."` returns `200` and the response includes `chain` field. [ship]
- [ ] 18.2 **Ship run402-mcp** — invoke the `/publish` skill in the run402-mcp repo (do NOT do publish steps manually). Smoke check: `cd $(mktemp -d) && npx -y run402-mcp@latest --list-tools 2>&1 | grep -F contract_call` exits 0. [ship]
- [ ] 18.3 **Ship run402 CLI** — bundled with run402-mcp publish. Smoke check: `cd $(mktemp -d) && npm install -g run402@latest && run402 contracts --help | grep -F provision-wallet` exits 0. [ship]
- [ ] 18.4 **Ship marketing site billing page** — push `site/billing/index.html` to main; CI deploys via `.github/workflows/deploy-site.yml`. Smoke check: `curl -fsSL https://run402.com/billing/ | grep -F '$0.04/day'` exits 0 AND `curl ... | grep -F 'KMS contract wallet'` exits 0. [ship]
- [ ] 18.5 **Ship llms.txt + llms-cli.txt + llms-full.txt + openapi.json** — bundled with site deploy. Smoke check: `curl -fsSL https://run402.com/llms.txt | grep -F '/contracts/v1/call'` exits 0 AND `curl ... | grep -F '$0.04/day'` exits 0; same for llms-cli.txt; openapi.json `curl ... | jq -e '.paths."/contracts/v1/wallets"'` returns the path object. [ship]
- [ ] 18.6 **Ship marketing site changelog** — bundled with site deploy. Smoke check: `curl -fsSL https://run402.com/humans/changelog.html | grep -F 'KMS contract wallet'` exits 0. [ship]
- [ ] 18.7 **Ship marketing site updates feed** — bundled with site deploy. Smoke check: `curl -fsSL https://run402.com/updates.txt | grep -F 'KMS contract wallet'` exits 0. [ship]
- [ ] 18.8 **Final pricing grep audit** — re-run the grep audit from 16.13 against the deployed site URLs (not local files) to catch anything that wasn't deployed. [manual]
- [ ] 18.9 **Provision the kysigned platform wallet** — using the now-live `run402 contracts provision-wallet` CLI. Funds it with ETH on Base mainnet (kysigned operator action). Update kysigned config with wallet ID + address. Smoke: `run402 contracts get-wallet <id>` returns the wallet with non-zero ETH balance. [manual]
- [ ] 18.10 **Update kysigned spec** — edit `docs/products/kysigned/kysigned-spec.md` line 94 to cite the actual run402 KMS pricing now that it's published. Commit + push. [manual]
- [ ] 18.11 **Smoke check non-custodial disclosure** — `curl -fsSL https://run402.com/humans/terms.html | grep -F 'non-custodial'` exits 0 AND `curl -fsSL https://run402.com/billing/ | grep -F 'Non-custodial'` exits 0. Verifies the legal disclosure actually shipped. [ship]
