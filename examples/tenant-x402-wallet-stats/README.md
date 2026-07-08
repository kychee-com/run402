# Tenant x402 Wallet Stats Smoke

Minimal project for testing fixed-price tenant x402 function routes.

It deploys one public route:

- `POST /wallet-stats`
- price: `$0.03` (`amount_usd_micros: 30000`)
- payout: owning org's `org_default_payout`
- default network: Base Sepolia testnet (`networks: ["testnet"]`)

After the gateway verifies and settles the x402 payment, the function reads the
settled payment context and emails the wallet/payment stats to
`major.tal@gmail.com`.

## Preconditions

- Target gateway includes tenant priced routes.
- The project owner org has an active payout wallet. If needed:

```sh
run402 org payout-wallet "$ORG_ID" "$PAYOUT_WALLET_ADDRESS"
```

- The project has one send-ready mailbox, or an explicit default outbound
  mailbox. The function uses `email.send(...)`.
- The agent payer wallet has USDC on the selected x402 network. The default
  manifest uses testnet, so use Base Sepolia USDC for the smoke test.

## Deploy

```sh
cd examples/tenant-x402-wallet-stats
run402 deploy apply --manifest run402.deploy.ts --project "$PROJECT_ID"
```

The deploy check expects unauthenticated `POST /wallet-stats` to return `402`.

## Agent Paid Call

```sh
run402 wallets use <wallet-name>   # select your default payer wallet
run402 wallets current --json      # confirm the active wallet

WALLET_STATS_URL="https://<your-project-host>/wallet-stats" node scripts/call-paid-wallet-stats.mjs
```

By default the script uses the active `run402 wallets use` wallet and reads its
local allowance key. Set `BUYER_PRIVATE_KEY=0x...` only when you want an
explicit CI/test payer wallet instead of the default Run402 wallet.

Optional:

```sh
X402_NETWORK=eip155:8453      # mainnet Base, if you change the manifest networks
RPC_URL=https://...           # custom RPC
AGENT_LABEL=codex-smoke
```

The script performs the real 402 challenge/retry flow with `@x402/fetch` and
prints the function response plus any settlement response header it receives.
