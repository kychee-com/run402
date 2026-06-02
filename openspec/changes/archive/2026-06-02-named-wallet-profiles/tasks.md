## 1. Core: profile-aware paths + permission hardening

- [x] 1.1 Make `core/src/config.ts` `getConfigDir()` profile-aware: `base = RUN402_CONFIG_DIR || ~/.config/run402`, `prof = RUN402_PROFILE || "default"`, return `base` for `default` else `join(base, "profiles", prof)`
- [x] 1.2 Add base-level `config.json` read/write helpers (`active_wallet`) at `{base}/config.json`, distinct from per-profile `projects.json` `active_project_id`
- [x] 1.3 Add per-profile `meta.json` read/write helpers (`name`, `address`, `label`, `created`) — secret-free, readable without loading the key
- [x] 1.4 Fix `getAllowancePath()` migration: chmod `0600` after the `wallet.json → allowance.json` rename
- [x] 1.5 Self-heal in `readAllowance()`: when an allowance file mode is looser than `0600`, tighten it and warn on stderr
- [x] 1.6 Create `profiles/` and `profiles/<name>/` directories with mode `0700`
- [x] 1.7 Unit tests for profile path resolution, `default`-stays-at-root, and the permission fixes (extend `core/src/config.test.ts`, `allowance` tests)

## 2. CLI: profile resolution + provenance at the edge

- [x] 2.1 Add a profile resolver invoked at the top of `cli/cli.mjs` (before `dispatch()` and any subcommand/`config.mjs` import) that returns `{ name, source, sourceDetail }`
- [x] 2.2 Implement precedence: `--wallet` flag → `RUN402_WALLET` → nearest `.run402.json`/`.run402.local.json` → `config.json` `active_wallet` → `default`; accept `--profile`/`RUN402_PROFILE` as hidden aliases
- [x] 2.3 Set `process.env.RUN402_WALLET` to the resolved name so core path functions pick it up; verify `config.mjs` snapshot still reads correctly (add resolve-before-import regression test) — snapshot footgun removed by 2.5's getter conversion
- [x] 2.4 Emit the stderr provenance line for non-default selections (name + short address + source); stay silent for `default`; honor `--quiet`
- [x] 2.5 Converted `cli/lib/config.mjs` wallet-dependent path constants (`CONFIG_DIR`/`ALLOWANCE_FILE`/`PROJECTS_FILE`) to getters; migrated init/doctor/allowance call sites

## 3. CLI: per-directory binding + conflict error

- [x] 3.1 Implement `.run402.json` / `.run402.local.json` tree-walk reader (walk up from cwd, `.local` overrides sibling), parsing only `{ wallet }`
- [x] 3.2 Implement the env-vs-binding conflict: differ + no flag → structured non-zero error naming both values and listing resolutions; same name or flag present → proceed
- [x] 3.3 Fail closed when the resolved wallet name does not exist locally (no silent fallback to `default`)

## 4. CLI: `run402 wallets` command family

- [x] 4.1 Add `cli/lib/wallets.mjs` and a `wallets` case in `cli/cli.mjs` dispatch
- [x] 4.2 `wallets list` — JSON array from `meta.json` (`name`, `label`, `address`+short, `rail`, `active`), no private-key read, no top-level `status`
- [x] 4.3 `wallets current` — resolved `{ name, source, address, label }` including drift + conflict notices
- [x] 4.4 `wallets new <name>` — create profile dir + key (viem, mirroring `init`) + meta + best-effort server label push (no-op until group 6)
- [x] 4.5 `wallets use <name>` — set `config.json` `active_wallet`
- [x] 4.6 `wallets rename <old> <new>` — move `profiles/<old>` → `profiles/<new>`; migrate root → `profiles/<new>` when `old == default`; update `active_wallet`; push label
- [x] 4.7 `wallets bind [<name>]` / `unbind` — write/remove `./.run402.json`; print the "safe to commit (no secrets)" notice
- [x] 4.8 `wallets import <name> --key -` — adopt an existing key as a named wallet; adopt the server label if one exists
- [x] 4.9 `wallets rm <name>` — guarded delete (requires `--yes`; agent-first, no interactive prompt)
- [x] 4.10 CLI help text (`wallets --help`, global `--wallet` in top-level help) + `cli-help.test.mjs` MATRIX entry for the `wallets` group

## 5. Wallet name display across surfaces

- [x] 5.1 `cli/lib/status.mjs` — adds a `wallet: { name, address, label }` object to JSON stdout (JSON-only agent-first CLI: the object IS the header)
- [x] 5.2 Add `r.whoami()` SDK read returning `{ name, address, label, activeProject }`; expose `getWalletIdentity()` on `NodeCredentialsProvider`
- [x] 5.3 MCP: `status` tool surfaces the active wallet (resolved from `RUN402_WALLET`) as a `wallet` row
- [x] 5.4 SDK consumption of the server-side label read with local-name fallback when absent/unreachable (getWalletIdentity falls back to local name; label null when unknown)

## 6. Server label sync (public side, best-effort)

- [x] 6.1 Add `r.wallets.setLabel` (signed by allowance headers), tolerant of a not-yet-deployed endpoint (returns `{ ok: false }` on 404/offline, never throws)
- [x] 6.2 Add `r.wallets.getLabel`; returns null on 404/offline for local-name fallback
- [x] 6.3 Wire `wallets new`/`rename`/`import` to a best-effort label push (signs with the target wallet; never errors offline). On by default now that the gateway endpoint (run402-private #414) is live + verified; `RUN402_WALLET_LABEL_SYNC=0` opts out.

## 7. Docs + sync

- [x] 7.1 Add `wallets` commands to `sync.test.ts` `SURFACE` (9 cli entries) + module lists; label methods in `SDK_ONLY_METHODS`; OpenClaw re-export shim for parity
- [x] 7.2 Document profiles + binding + `RUN402_WALLET` in `SKILL.md`, `openclaw/SKILL.md`, `cli/llms-cli.txt`
- [x] 7.3 Update README env-var tables (`README.md`, `cli/README.md`, `AGENTS.md`) for `RUN402_WALLET`/`RUN402_PROFILE` and the profiles layout

## 8. Verification

- [x] 8.1 CLI e2e tests (`cli-wallets.test.mjs`, wired into `test:e2e` + `test`) for the precedence chain, conflict error, binding tree-walk + `.local` override, and `default` migration on rename
- [x] 8.2 Tests for non-default provenance line and `default` silence
- [x] 8.3 Run full `npm test` (SKILL + sync + unit + CLI e2e + docs) green — 603 e2e + all unit/sync/skill pass
- [x] 8.4 Confirm zero-behavior-change for the no-profile path — existing tests unmodified (only additive) and passing
