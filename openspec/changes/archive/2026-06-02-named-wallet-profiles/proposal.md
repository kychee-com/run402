## Why

`run402 init` creates a single wallet at one fixed location (`~/.config/run402/`), with no notion of multiple wallets or a way to select between them. Holding more than one wallet on a machine — per-client isolation for contractors, personal-vs-work-vs-infra separation, blast-radius containment — means hand-swapping key files or env vars, with no signal telling you which wallet you're about to spend from. The platform is already multi-wallet-native server-side (projects are listed per wallet address; billing pools many wallets; the operator console renders a multi-wallet view), so the gap is purely client-side. This change adds named wallets, per-directory binding, and a human-readable name that follows the wallet across every interface (CLI, SDK, MCP, and WEB) — so a wallet reads as `kychon`, not `0x1234…aBcD`. Fully non-custodial: keys never leave the local machine.

## What Changes

- **Named wallets stored as profile directories.** `run402 wallets new <name>` creates a wallet under `~/.config/run402/profiles/<name>/` (its own `allowance.json` + `projects.json` + non-secret `meta.json`). The pre-existing single wallet stays at the config-dir root as the reserved `default` wallet — **zero migration** for existing installs.
- **A single synced name per wallet.** The folder name, the local selector, and the server-side display label are one name, kept in sync. A named wallet is *always* a folder: renaming `default` physically migrates its files into `profiles/<new-name>/`, so there is no folderless-but-named special case.
- **Selection precedence with an explicit conflict error.** Resolution order: `--wallet <name>` flag → `RUN402_WALLET` env → nearest `./.run402.json` directory binding → global `wallets use` default → `default`. When the env var and a directory binding name *different* wallets and no flag disambiguates, the CLI **errors** with a fix-it message rather than silently picking one — the flag is the universal escape hatch.
- **Per-directory binding via a commit-safe `.run402.json`.** Holds only a wallet *name* (never a key), resolved by walking up the directory tree like `.git`. A gitignored `.run402.local.json` overrides it for personal use. Distinct from the deploy manifest (`run402.config.json`) — no collision with strict `ReleaseSpec` validation.
- **The name surfaces everywhere.** CLI `status` header + a provenance echo on non-default operations + `wallet:{name,address,label}` in JSON output; an SDK identity read (`r.whoami()`); MCP tool output tagged with the active wallet (driven by `RUN402_WALLET` in the server env); and the operator-console label (the WEB surface — a run402-private companion dependency).
- **`run402 wallets` command family:** `list`, `current`, `new`, `use`, `rename`, `bind`/`unbind`, `import`, `rm`. `--profile`/`RUN402_PROFILE` kept as hidden aliases for AWS muscle memory. `run402 allowance` continues to operate on the *selected* wallet.
- **File-permission hardening (bundled).** Fix the `wallet.json → allowance.json` auto-migration that preserves a legacy `0644` mode via `renameSync`: chmod `0600` after rename, self-heal on read, and create profile directories `0700`. OS-keychain storage is explicitly **out of scope** for this change.
- **Non-breaking.** With no flag/env/binding and no profiles created, every existing single-wallet install behaves identically.

## Capabilities

### New Capabilities
- `cli-wallet-profiles`: Local multi-wallet management — the profile-directory storage layout, the wallet-selection precedence chain and its conflict-error contract, the `run402 wallets` command family, the per-directory `.run402.json` binding (commit-safe + `.local` override, tree-walk resolution), and credential-file permission hardening.
- `wallet-named-identity`: The single synced human-readable wallet name as a cross-surface display identity — how the name is set (at `new`/`rename`) and pushed to the server-side label, the local↔server sync and display-fallback rules, and the contract for surfacing the name in CLI output, the SDK identity read, and MCP tool output. The operator-console (WEB) rendering and the server-side label storage/endpoint are captured as the run402-private companion dependency.

### Modified Capabilities
<!-- None. Status/init JSON gains additive `wallet` fields, consistent with the existing cli-output-shape local-state-inspection requirement; no existing requirement is redefined. -->

## Impact

- **`core/`** — `config.ts` profile-aware `getConfigDir()` (env-driven: `RUN402_PROFILE`/`RUN402_WALLET`), new base `config.json` (`active_wallet`), per-profile `meta.json`, allowance/keystore path resolution, and the permission-hardening fixes in `getAllowancePath()`/`readAllowance()`/`saveAllowance()`.
- **`cli/`** — new `cli/lib/wallets.mjs` (the command family) + dispatch entry; early profile resolution + provenance reporting in `cli.mjs` before any subcommand/`config.mjs` import; `.run402.json` tree-walk reader; `status.mjs` header + JSON `wallet` field; the env-vs-binding conflict error envelope.
- **`sdk/`** — `NodeCredentialsProvider` exposes the resolved profile name; a small identity read (`r.whoami()` / `r.wallet`) returning `{ name, address, label, activeProject }`; SDK consumption of the server-side label read.
- **MCP (`src/`)** — wallet-aware tool output tagging driven by `RUN402_WALLET`; `status` tool surfaces the active wallet name.
- **Docs/sync** — `SKILL.md`, `openclaw/SKILL.md`, `cli/llms-cli.txt`, README env-var tables; `sync.test.ts` SURFACE additions for the new `wallets` commands.
- **run402-private (companion)** — server-side wallet `label` field + signed set/read endpoint, and operator-console rendering of the label. The public client surface degrades gracefully (falls back to the local folder name) when the server has no label.
- **Out of scope** — OS-keychain credential storage; CI wallets (OIDC federation is keyless by design).
