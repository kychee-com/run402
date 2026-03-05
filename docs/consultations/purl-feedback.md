# purl Feedback — From an x402 Server Operator

Field notes from integrating purl v0.1.1 into an existing x402 deployment (AgentDB, run402.com). Written for Stripe's machine payments team.

## Context

We run an x402 server (CDP facilitator) and wanted to test purl as a client against it. Environment: macOS, M-series Mac, Claude Code (AI coding agent in a non-TTY shell). Also tested manually from terminal.

## The Good

**inspect is excellent.** `purl inspect <url>` just works — no wallet needed, no password, clean output. It immediately told us the server offers two networks (Base mainnet + Sepolia), the price, the asset, and whether our wallet is compatible. This is the best debugging tool in the x402 ecosystem right now.

**curl-like UX is right.** The `-i`, `-H`, `-d`, `--json`, `-o` flags make it feel familiar. Piping to jq works because `--output-format json` auto-detects when stdout isn't a terminal.

**PURL_PASSWORD env var exists for requests.** This means CI/CD pipelines can decrypt the wallet without interactive prompts during actual payment flows.

**--dry-run and --confirm are thoughtful.** Lets operators validate the full flow without spending.

## The Problems

### 1. `wallet add` is fully interactive — no non-interactive mode

This is the biggest issue. `purl wallet add` uses `dialoguer` prompts for everything:
- Generate vs import selection
- Password entry (twice for confirm)
- "Set as active wallet?" confirmation

Even when you pass `--name default --type evm --private-key 0x...`, it still prompts for the password. There's no `--password` flag on `wallet add` (even though the main `purl` command has one).

**Impact:** Can't bootstrap purl in:
- CI/CD pipelines (GitHub Actions, etc.)
- Docker containers
- AI coding agents (Claude Code, Cursor, Copilot Workspace)
- Any headless or scripted environment

**Workaround we used:** `expect` (the Unix tool for automating interactive programs):
```bash
expect -c '
spawn purl wallet add --name default --type evm
expect "Generate"
send "\r"
expect "Create password"
send "mypassword\r"
expect "Confirm password"
send "mypassword\r"
expect "Set as active"
send "Y\r"
expect eof
'
```

This is brittle — it breaks if prompt text changes.

**Suggested fix:** Add `--password` flag to `wallet add`, and when all required flags are provided (`--name`, `--type`, `--password`, and optionally `--private-key`), skip all interactive prompts. Alternatively, respect `PURL_PASSWORD` env var during wallet creation too — it already works for wallet decryption.

### 2. No way to create a config.toml without going through wallet add

The config format is simple TOML:
```toml
[evm]
keystore = "/path/to/keystore.json"
```

But the keystore file is an Ethereum-standard encrypted JSON keystore, which is hard to create manually. If `wallet add` supported non-interactive mode, this wouldn't matter. As-is, there's no escape hatch for headless provisioning.

**Suggested fix:** Either document the keystore format so power users can generate it with external tools (e.g., `cast wallet new`), or provide a `purl wallet import-keystore <path>` command that takes an existing keystore file.

### 3. Password prompt on every payment request

Unless you pass `--password` or set `PURL_PASSWORD`, every `purl <url>` invocation prompts for the keystore password. This makes sense for security but kills scriptability.

The env var works, but it's not mentioned in `purl --help` output for the main command — only discoverable via `purl topics environment`. Would help to add `[env: PURL_PASSWORD=]` annotation to the `--password` flag in `purl wallet add --help` (like the main command already has).

### 4. First keystore gets orphaned

When we ran `wallet add` twice (first attempt failed midway, second succeeded), the first keystore file was left in `~/.purl/keystores/` with no config pointing to it. No `wallet remove` or `wallet clean` command exists to prune orphaned keystores.

### 5. Missing `wallet export-address` for scripting

To get the wallet address programmatically, you have to parse the colorized output of `wallet list` or `wallet info`. A simple `purl wallet address` that prints just the hex address (no ANSI codes) would help for scripts that need to, say, fund the wallet from a faucet.

### 6. `--network base-sepolia` doesn't match `eip155:84532`

When the server returns x402 v2 payment requirements with CAIP-2 network IDs (`eip155:84532`), purl's `--network base-sepolia` filter doesn't match:

```bash
# This fails with "requires a wallet for eip155:84532"
purl --network base-sepolia http://localhost:4022/v1/ping

# This works
purl http://localhost:4022/v1/ping
```

The `balance` command uses friendly names (`base-sepolia`) but the payment filter doesn't resolve them to CAIP-2 IDs. Confusing because `inspect` shows `"compatible": true` regardless.

**Suggested fix:** Accept both `base-sepolia` and `eip155:84532` in `--network` (like `resolve_network_alias` already does internally for other paths).

### 7. x402.org facilitator: no mainnet support

The facilitator at `x402.org` (which Stripe's own docs point to) only supports `eip155:84532` (Base Sepolia). There's no `eip155:8453` (Base mainnet) in `/facilitator/supported`. This means the entire Stripe x402 path is testnet-only today.

For server operators, the Stripe value proposition is settlement into Stripe balance (fiat payouts, dashboard, reporting). But that only matters on mainnet. Without mainnet facilitator support, there's no reason to switch from CDP in production.

**Questions for the team:**
- What's the timeline for mainnet support on the x402.org facilitator?
- Will Stripe host its own facilitator (e.g., `api.stripe.com/x402/facilitator`), or will mainnet be added to x402.org?
- Is there a way to get early access to mainnet facilitation for approved machine payments accounts?

## Minor Suggestions

- **`purl inspect` in JSON mode:** `purl inspect --output-format json <url>` would be useful for programmatic checking of payment requirements (e.g., a monitoring script that alerts when prices change).
- **Exit codes:** Document them prominently. `purl topics exit-codes` exists but operators will look in `--help` first.
- **Example in README for x402 server operators:** The current docs focus on paying. A section showing "I run an x402 server and want to test my endpoints with purl" would help adoption — that's a huge use case.

## Summary Table

| Issue | Severity | Suggested Fix |
|---|---|---|
| `wallet add` requires TTY | **High** | Add `--password` flag, skip prompts when all flags given |
| No headless config bootstrap | **High** | Non-interactive `wallet add` or `import-keystore` |
| Password prompt on every request | Medium | Better docs for `PURL_PASSWORD`; consider keyring integration |
| Orphaned keystores | Low | Add `wallet remove` / `wallet clean` |
| No scriptable address output | Low | Add `wallet address` subcommand |
| `--network` doesn't match CAIP-2 IDs | Medium | Resolve aliases in `--network` filter |
| No mainnet facilitator support | **High** | Add `eip155:8453` to x402.org (or host at stripe.com) |

## What We're Using purl For

1. **Smoke testing** our x402 endpoints after deploy (`purl inspect`)
2. **E2E payment flow** validation from a real client (not just our test harness)
3. **Comparing facilitators** — we're adding Stripe alongside CDP, purl lets us test both from the same client
4. **Monitoring** — considering a cron that runs `purl inspect` and alerts on changes

purl fills a real gap. curl can't do x402; custom scripts are fragile. This tool should be the standard way to debug and test x402 APIs. The interactivity issues are the main barrier to broader adoption in DevOps/CI workflows.
