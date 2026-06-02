## Context

All run402 credential paths funnel through one seam: `core/src/config.ts` `getConfigDir()` → `RUN402_CONFIG_DIR || ~/.config/run402`, from which `getKeystorePath()` (`projects.json`) and `getAllowancePath()` (`allowance.json`, auto-migrated from `wallet.json`) derive. A "wallet" is effectively a whole config directory: the signing key (`allowance.json`), the per-wallet project API-key cache + `active_project_id` (`projects.json`). The server is already multi-wallet — `projects.list(wallet)` hits `GET /wallets/v1/:wallet/projects`, billing pools wallets, and the operator console renders them — so the gap is purely client-side.

Two implementation constraints shape everything:
- `RUN402_CONFIG_DIR` is the **universal test-isolation seam** — the entire suite points it at a temp dir. Profiles must compose with it, not replace it.
- `cli/lib/config.mjs` **snapshots** paths at module load (`export const CONFIG_DIR = getConfigDir()`). This works today only because subcommand modules are dynamically imported *after* `cli.mjs` top-level code runs, so the env can be set first. Profiles lean harder on that ordering.

There is no `whoami`/`identity`/`wallet` SDK namespace today; `allowance.ts` is the key/funding surface. A named, server-backed wallet identity is net-new surface.

## Goals / Non-Goals

**Goals:**
- Hold multiple named wallets on one machine and select between them cleanly (flag / env / per-directory binding / global default).
- One human-readable name per wallet that reads identically across CLI, SDK, MCP, and WEB — never just `0x1234…`.
- Per-directory binding that auto-selects the right wallet by cwd, kills "which wallet am I on" mistakes, and is safe to commit.
- Zero migration and identical behavior for existing single-wallet installs.
- Fix the world-readable-credential migration bug along the way.

**Non-Goals:**
- OS-keychain / encrypted-at-rest credential storage (large, OS-specific; separate change).
- CI wallets (OIDC federation is keyless by design).
- A custodial cloud wallet (against the self-custody ethos).
- The cross-device PRF-passkey vault (complementary future work, not this change).

## Decisions

### A profile is a named config directory; resolution is env-driven in core

`getConfigDir()` gains profile awareness: `base = RUN402_CONFIG_DIR || ~/.config/run402`; `prof = RUN402_PROFILE/RUN402_WALLET || "default"`; return `base` when `prof === "default"`, else `base/profiles/<prof>`. Because keystore, allowance, and `meta.json` all derive from `getConfigDir()`, switching one env var moves the whole wallet bundle atomically — and the SDK and MCP inherit profiles for free via the same core path functions.

*Alternative considered:* per-file path overrides (`allowancePath`/`keystorePath`) threaded through every call. Rejected — more plumbing, easy to get partially right, and doesn't give MCP/SDK the behavior for free.

### Default lives at the root; zero migration (Thread A)

The reserved `default` wallet stays at `{config_dir}/allowance.json`. Named wallets live under `profiles/<name>/`. Existing installs are already a valid `default` with no file moved.

*Alternative considered:* uniform `profiles/default/` for everyone. Rejected — forces a migration of every install's only wallet on first run, racing concurrent CLI invocations (the keystore already needs a lockdir for exactly this).

### CLI translates flag + binding into the env var; core stays env-only (Thread B)

The `--wallet` flag and the `.run402.json` binding are **CLI-edge** concerns: `cli.mjs` resolves them and sets `process.env.RUN402_WALLET` before dispatch (and before any `config.mjs` import). Core never reads argv or cwd. This keeps core pure and testable and means the SDK/MCP don't change behavior based on the directory a process launched in.

### One synced name; renaming `default` migrates it (answer locked)

The folder name, the `--wallet` selector, and the server label are one name. It is set at `new` and changed at `rename`; both push the server label. A named wallet is *always* a folder, so renaming `default` physically migrates the root files into `profiles/<name>/`. This removes the "label a folderless root wallet" special case and shrinks the command surface — there is no standalone `wallets label`.

*Alternative considered:* two independent names (local selector vs server label). Rejected per product call — one name is the simpler mental model and a smaller CLI.

### Binding file is separate from the deploy manifest; commit-safe (Thread C, designed fresh)

The binding is its own `.run402.json` holding only `{ "wallet": "<name>" }`, resolved by walking up the tree, with a gitignored `.run402.local.json` override. It is **not** the deploy manifest (`run402.config.json`).

*Why not the issue's `run402.config.json`:* (1) that filename is the `ReleaseSpec` manifest, and the SDK's strict `validateSpec` rejects unknown top-level fields — a stray `profile` would be rejected or silently dropped; (2) the binding must resolve *before the SDK is built*, on *every* command, but a manifest is read late and only by `deploy` (e.g. `projects list` reads no manifest at all). A dedicated, command-agnostic file is the only shape that works. Commit-safety is a feature: a name reference (never a key) lets the binding travel with the repo so clones get the right wallet.

### The flag is the conflict resolver; env≠binding errors (answer locked)

Industry norm (pyenv `PYENV_VERSION` > `.python-version`, terraform, git) is **env silently beats the directory file**. We deliberately deviate: this feature exists to prevent wrong-wallet mistakes, and silent precedence reintroduces exactly that footgun (a forgotten `export RUN402_WALLET` silently overriding a repo binding). Instead: `--wallet` always wins and never errors; with no flag, if env and binding name *different* wallets it is a hard error with fix-its; same-name never annoys. The flag isn't a higher rung — it's what makes erroring painless.

### Server label is signed metadata; the change spans both repos

The label is written via a wallet-signed (EIP-191/SIWX) call and stored as display-only metadata — zero custody implications. run402-public owns selection, binding, local naming, and CLI/SDK/MCP display; run402-private owns the wallet `label` column, the signed set/read endpoint, and operator-console rendering. The public surface degrades gracefully to the local folder name when the server has no label or is unreachable, so public can ship and function before private lands.

### Permission hardening bundled

`getAllowancePath()`'s `wallet.json → allowance.json` migration uses `renameSync`, which preserves a legacy `0644` mode. Fix: chmod `0600` after rename, self-heal looser-than-`0600` on read (tighten + warn), create `profiles/` and `profiles/<name>/` as `0700`.

## Risks / Trade-offs

- **`config.mjs` path snapshot timing** → Profile must be resolved before the first `config.mjs` import. Mitigation: resolve in `cli.mjs` top-level before `dispatch()`; add a regression test that a late `RUN402_WALLET` is irrelevant because resolution precedes import; consider converting the exported constants to getter functions to remove the latent footgun.
- **Cross-repo dependency on the server label** → Public would reference an endpoint private hasn't shipped. Mitigation: label push is best-effort and no-ops/falls back to the local name until the private endpoint exists; ship public first, wire the live push last.
- **Offline rename drift** (local name ≠ server label) → Mitigation: surface as a reconcilable notice in `current`/`list`; reconcile on the next online operation (or an explicit `wallets sync` — see Open Questions).
- **Hostile `.run402.json` social engineering** (a cloned repo names one of *your* other wallets) → Mitigation: binding to an unknown name fails closed (never silent-falls-back), and the loud provenance echo shows the selected wallet on every non-default op. A direnv-style trust gate is deferred (our file is a name, not arbitrary shell).
- **Test-suite blast radius** → `RUN402_WALLET` unset → `default` → identical paths, so existing tests are unaffected; new tests set `RUN402_WALLET` alongside the existing `RUN402_CONFIG_DIR` temp dir.

## Migration Plan

Zero data migration by design — named wallets are opt-in directories; the default stays put. Sequencing:
1. **run402-public:** profile-aware `getConfigDir()`, base `config.json`, `.run402.json` resolution, the `wallets` command family, CLI/SDK/MCP name display (local-only), and the permission fix. Label push is best-effort and harmless if the endpoint 404s.
2. **run402-private (companion):** wallet `label` column + signed set/read endpoint + operator-console rendering.
3. **run402-public:** confirm the CLI label push against the live endpoint; document the WEB name.

Rollback is trivial: the surface is additive. Removing the feature leaves the default wallet at root untouched; any created `profiles/<name>/` dirs are inert without the resolver.

## Open Questions

- **Trust gate** for honoring a freshly-cloned `.run402.json`? Lean *no* for v1 (fails closed on unknown name; provenance echo mitigates).
- **Offline reconciliation**: auto-sync the server label on the next online op, or require an explicit `wallets sync`?
- **Selector by address/label**: should `--wallet` eventually accept a `0x…` address or server label, not just the local folder name?
- **Label charset / uniqueness** server-side (a run402-private decision; the public client only needs filesystem-safe folder names `[a-z0-9_-]`).
- **`RUN402_CONFIG_DIR` × profile composition**: confirm `RUN402_CONFIG_DIR` remains the *base* and profiles nest within it (assumed yes for test-isolation consistency).
